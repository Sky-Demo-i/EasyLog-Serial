//! Serial port manager: owns the port handle, a reader thread, Tauri events,
//! and optional session recording.
//!
//! Frontend contract:
//!   invoke("list_ports")                          -> PortInfo[]
//!   invoke("open_port", { config })               -> void
//!   invoke("close_port")                          -> void
//!   invoke("write_port", { data })                -> number   (base64 payload)
//!   invoke("set_signals", { dtr, rts })
//!   invoke("start_recording", { config })         -> path
//!   invoke("stop_recording")                      -> path | null
//!
//! Events:
//!   serial://data   { ts, data(base64), rxTotal }
//!   serial://state  { connected, message }
//!
//! Session file (JSON Lines):
//!   {"type":"meta","version":1,"started":...,"port":"COM5","baud":115200}
//!   {"type":"rx","ts":...,"data":"<base64>"}
//!   {"type":"tx","ts":...,"data":"<base64>"}

use std::fs::{self, File};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::autosave::{AutoSave, AutoSaveInfo};

pub const EV_DATA: &str = "serial://data";
pub const EV_STATE: &str = "serial://state";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub kind: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub manufacturer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default = "default_flow")]
    pub flow_control: String,
    #[serde(default)]
    pub dtr: bool,
    #[serde(default)]
    pub rts: bool,
}

fn default_data_bits() -> u8 {
    8
}
fn default_parity() -> String {
    "none".into()
}
fn default_stop_bits() -> u8 {
    1
}
fn default_flow() -> String {
    "none".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub filename: String,
    pub port_name: String,
    pub baud_rate: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPayload {
    pub ts: u64,
    pub data: String,
    pub rx_total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub connected: bool,
    pub message: String,
}

struct Recording {
    file: BufWriter<File>,
    path: PathBuf,
}

pub struct SerialManager {
    port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
    running: Arc<AtomicBool>,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
    recorder: Arc<Mutex<Option<Recording>>>,
    autosave: Arc<Mutex<AutoSave>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
            reader: Mutex::new(None),
            recorder: Arc::new(Mutex::new(None)),
            autosave: Arc::new(Mutex::new(AutoSave::new())),
        }
    }

    /// Stop the reader thread, close the port, and close the recording file.
    fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.reader.lock().unwrap().take() {
            let _ = handle.join();
        }
        self.stop_recording();
        if let Ok(mut autosave) = self.autosave.lock() {
            autosave.flush();
        }
        if let Some(port) = self.port.lock().unwrap().take() {
            drop(port);
        }
    }

    pub fn open(&self, app: AppHandle, cfg: SerialConfig) -> Result<(), String> {
        if cfg.data_bits < 5 || cfg.data_bits > 8 {
            return Err(format!("不支持的数据位: {}", cfg.data_bits));
        }

        self.stop();

        let builder = serialport::new(&cfg.port_name, cfg.baud_rate)
            .data_bits(match cfg.data_bits {
                5 => serialport::DataBits::Five,
                6 => serialport::DataBits::Six,
                7 => serialport::DataBits::Seven,
                _ => serialport::DataBits::Eight,
            })
            .parity(match cfg.parity.as_str() {
                "even" => serialport::Parity::Even,
                "odd" => serialport::Parity::Odd,
                _ => serialport::Parity::None,
            })
            .stop_bits(if cfg.stop_bits == 2 {
                serialport::StopBits::Two
            } else {
                serialport::StopBits::One
            })
            .flow_control(match cfg.flow_control.as_str() {
                "software" => serialport::FlowControl::Software,
                "hardware" => serialport::FlowControl::Hardware,
                _ => serialport::FlowControl::None,
            })
            .timeout(Duration::from_millis(20));

        let mut port = builder
            .open()
            .map_err(|e| format!("打开 {} 失败: {e}", cfg.port_name))?;

        // Modem lines: failure is not fatal on many USB adapters.
        let _ = port.write_data_terminal_ready(cfg.dtr);
        let _ = port.write_request_to_send(cfg.rts);

        let mut reader = port
            .try_clone()
            .map_err(|e| format!("复制串口句柄失败: {e}"))?;

        self.running.store(true, Ordering::SeqCst);
        *self.port.lock().unwrap() = Some(port);

        if let Ok(mut autosave) = self.autosave.lock() {
            autosave.start_session(&cfg.port_name, cfg.baud_rate);
        }

        let running = Arc::clone(&self.running);
        let recorder = Arc::clone(&self.recorder);
        let autosave = Arc::clone(&self.autosave);
        let app_handle = app.clone();

        let handle = thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::with_capacity(8192);
            let mut last_emit = Instant::now();
            let mut total: u64 = 0;

            while running.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        total += n as u64;
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut => {}
                    Err(e) => {
                        let _ = app_handle.emit(
                            EV_STATE,
                            StatePayload {
                                connected: false,
                                message: format!("串口读取失败: {e}"),
                            },
                        );
                        break;
                    }
                }

                let due = pending.len() >= 4096
                    || (last_emit.elapsed() >= Duration::from_millis(30) && !pending.is_empty());
                if due {
                    let ts = now_ms();
                    let encoded = B64.encode(&pending);
                    let _ = app_handle.emit(
                        EV_DATA,
                        DataPayload {
                            ts,
                            data: encoded,
                            rx_total: total,
                        },
                    );
                    record_chunk(&recorder, "rx", ts, &pending);
                    if let Ok(mut writer) = autosave.lock() {
                        writer.append_rx(ts, &pending);
                    }
                    pending.clear();
                    last_emit = Instant::now();
                }
            }

            if !pending.is_empty() {
                let ts = now_ms();
                let encoded = B64.encode(&pending);
                let _ = app_handle.emit(
                    EV_DATA,
                    DataPayload {
                        ts,
                        data: encoded,
                        rx_total: total,
                    },
                );
                record_chunk(&recorder, "rx", ts, &pending);
                if let Ok(mut writer) = autosave.lock() {
                    writer.append_rx(ts, &pending);
                }
            }
        });

        *self.reader.lock().unwrap() = Some(handle);

        let _ = app.emit(
            EV_STATE,
            StatePayload {
                connected: true,
                message: format!("已连接 {} @ {}", cfg.port_name, cfg.baud_rate),
            },
        );
        Ok(())
    }

    pub fn close(&self) {
        self.stop();
    }

    pub fn write_bytes(&self, bytes: &[u8]) -> Result<usize, String> {
        let mut guard = self.port.lock().unwrap();
        let port = guard.as_mut().ok_or_else(|| "串口未打开".to_string())?;
        port.write_all(bytes)
            .map_err(|e| format!("发送失败: {e}"))?;
        let _ = port.flush();
        let ts = now_ms();
        record_chunk(&self.recorder, "tx", ts, bytes);
        if let Ok(mut autosave) = self.autosave.lock() {
            autosave.append_tx(ts, bytes);
        }
        Ok(bytes.len())
    }

    pub fn write_base64(&self, data: &str) -> Result<usize, String> {
        let bytes = B64.decode(data).map_err(|e| format!("数据解码失败: {e}"))?;
        self.write_bytes(&bytes)
    }

    pub fn set_signals(&self, dtr: bool, rts: bool) -> Result<(), String> {
        let mut guard = self.port.lock().unwrap();
        let port = guard.as_mut().ok_or_else(|| "串口未打开".to_string())?;
        port.write_data_terminal_ready(dtr)
            .map_err(|e| format!("设置 DTR 失败: {e}"))?;
        port.write_request_to_send(rts)
            .map_err(|e| format!("设置 RTS 失败: {e}"))?;
        Ok(())
    }

    pub fn set_autosave(&self, enabled: bool, max_mb: u32) -> AutoSaveInfo {
        let max_bytes = u64::from(max_mb.max(1)) * 1024 * 1024;
        self.autosave
            .lock()
            .map(|mut autosave| autosave.set_enabled(enabled, max_bytes))
            .unwrap_or_else(|_| AutoSaveInfo {
                enabled,
                dir: String::new(),
                bytes: 0,
                files: 0,
                max_bytes,
            })
    }

    pub fn autosave_info(&self) -> AutoSaveInfo {
        self.autosave
            .lock()
            .map(|autosave| autosave.info())
            .unwrap_or_else(|_| AutoSaveInfo {
                enabled: false,
                dir: String::new(),
                bytes: 0,
                files: 0,
                max_bytes: 0,
            })
    }

    pub fn start_recording(&self, cfg: RecordingConfig) -> Result<String, String> {
        if self.port.lock().unwrap().is_none() {
            return Err("串口未打开，无法录制".into());
        }

        // Close any previous session before starting a new one.
        self.stop_recording();

        let dir = recording_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建录制目录失败: {e}"))?;

        let safe_name = Path::new(&cfg.filename)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("session.jsonl");
        let path = dir.join(safe_name);

        let file = File::create(&path).map_err(|e| format!("创建录制文件失败: {e}"))?;
        let mut writer = BufWriter::new(file);
        let meta = serde_json::json!({
            "type": "meta",
            "version": 1,
            "started": now_ms(),
            "port": cfg.port_name,
            "baud": cfg.baud_rate,
        });
        writeln!(writer, "{meta}").map_err(|e| format!("写入录制头失败: {e}"))?;
        writer.flush().ok();

        *self.recorder.lock().unwrap() = Some(Recording {
            file: writer,
            path: path.clone(),
        });

        Ok(path.to_string_lossy().into_owned())
    }

    pub fn stop_recording(&self) -> Option<String> {
        let mut guard = self.recorder.lock().unwrap();
        if let Some(mut recording) = guard.take() {
            let _ = recording.file.flush();
            return Some(recording.path.to_string_lossy().into_owned());
        }
        None
    }
}

fn record_chunk(recorder: &Arc<Mutex<Option<Recording>>>, kind: &str, ts: u64, bytes: &[u8]) {
    if let Ok(mut guard) = recorder.lock() {
        if let Some(recording) = guard.as_mut() {
            let line = format!(
                "{{\"type\":\"{kind}\",\"ts\":{ts},\"data\":\"{}\"}}\n",
                B64.encode(bytes)
            );
            let _ = recording.file.write_all(line.as_bytes());
        }
    }
}

fn recording_dir() -> PathBuf {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        PathBuf::from(profile)
            .join("Documents")
            .join("EasyLog")
            .join("sessions")
    } else {
        PathBuf::from("sessions")
    }
}

pub fn list_ports() -> Vec<PortInfo> {
    let mut ports: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(info) => PortInfo {
                name: p.port_name,
                kind: "USB".into(),
                vid: Some(info.vid),
                pid: Some(info.pid),
                product: info.product,
                serial_number: info.serial_number,
                manufacturer: info.manufacturer,
            },
            serialport::SerialPortType::PciPort => PortInfo {
                name: p.port_name,
                kind: "PCI".into(),
                vid: None,
                pid: None,
                product: None,
                serial_number: None,
                manufacturer: None,
            },
            serialport::SerialPortType::BluetoothPort => PortInfo {
                name: p.port_name,
                kind: "蓝牙".into(),
                vid: None,
                pid: None,
                product: None,
                serial_number: None,
                manufacturer: None,
            },
            serialport::SerialPortType::Unknown => PortInfo {
                name: p.port_name,
                kind: "串口".into(),
                vid: None,
                pid: None,
                product: None,
                serial_number: None,
                manufacturer: None,
            },
        })
        .collect();

    ports.sort_by_key(|p| {
        let prefix: String = p.name.chars().take_while(|c| !c.is_ascii_digit()).collect();
        let number: u32 = p
            .name
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        (prefix.to_ascii_lowercase(), number)
    });
    ports
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
