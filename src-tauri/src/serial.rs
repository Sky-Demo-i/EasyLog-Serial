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

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::autosave::{AutoSave, AutoSaveInfo};

pub const EV_DATA: &str = "serial://data";
pub const EV_STATE: &str = "serial://state";
pub const EV_TCP_CLIENTS: &str = "tcp://clients";

/// A frame that never sees an idle gap is cut after this long / this many bytes
/// so a continuous stream still reaches the UI instead of growing forever.
const FRAME_MAX_AGE_MS: u64 = 200;
const FRAME_MAX_BYTES: usize = 4096;

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpClientsPayload {
    pub count: usize,
    pub clients: Vec<String>,
}

struct TcpServer {
    running: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, TcpStream>>>,
    accept: Mutex<Option<thread::JoinHandle<()>>>,
}

struct Recording {
    file: BufWriter<File>,
    path: PathBuf,
}

struct Frame {
    bytes: Vec<u8>,
    ts: u64,
}

/// Assembles bytes into frames the way a UART idle interrupt does: a gap of
/// `gap_ms` without new data ends the frame. Time is passed in so tests can
/// drive it without sleeping.
struct FrameBuffer {
    bytes: Vec<u8>,
    started_wall: u64,
    started_at: Instant,
    last_data_at: Instant,
}

impl FrameBuffer {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            bytes: Vec::new(),
            started_wall: 0,
            started_at: now,
            last_data_at: now,
        }
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn push(&mut self, data: &[u8], now: Instant, wall: u64, gap_ms: u64) -> Option<Frame> {
        let mut completed = None;
        if !self.bytes.is_empty()
            && now.duration_since(self.last_data_at) >= Duration::from_millis(gap_ms)
        {
            completed = self.take();
        }
        if self.bytes.is_empty() {
            self.started_wall = wall;
            self.started_at = now;
        }
        self.bytes.extend_from_slice(data);
        self.last_data_at = now;
        if completed.is_none()
            && (self.bytes.len() >= FRAME_MAX_BYTES
                || now.duration_since(self.started_at) >= Duration::from_millis(FRAME_MAX_AGE_MS))
        {
            completed = self.take();
        }
        completed
    }

    fn poll(&mut self, now: Instant, gap_ms: u64) -> Option<Frame> {
        if self.bytes.is_empty() {
            return None;
        }
        if now.duration_since(self.last_data_at) >= Duration::from_millis(gap_ms)
            || now.duration_since(self.started_at) >= Duration::from_millis(FRAME_MAX_AGE_MS)
        {
            self.take()
        } else {
            None
        }
    }

    fn take(&mut self) -> Option<Frame> {
        if self.bytes.is_empty() {
            return None;
        }
        Some(Frame {
            bytes: std::mem::take(&mut self.bytes),
            ts: self.started_wall,
        })
    }
}

pub struct SerialManager {
    port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
    running: Arc<AtomicBool>,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
    recorder: Arc<Mutex<Option<Recording>>>,
    autosave: Arc<Mutex<AutoSave>>,
    tcp: Mutex<Option<TcpServer>>,
    /// 0 = stream mode (30 ms batching); >0 = split frames on an idle gap.
    frame_gap_ms: Arc<AtomicU64>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
            reader: Mutex::new(None),
            recorder: Arc::new(Mutex::new(None)),
            autosave: Arc::new(Mutex::new(AutoSave::new())),
            tcp: Mutex::new(None),
            frame_gap_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_frame_gap(&self, gap_ms: u64) {
        self.frame_gap_ms
            .store(gap_ms.min(2000), Ordering::Relaxed);
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
        self.stop_tcp();
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
        let frame_gap = Arc::clone(&self.frame_gap_ms);
        let app_handle = app.clone();

        let handle = thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::with_capacity(8192);
            let mut framer = FrameBuffer::new();
            let mut framing = false;
            let mut last_emit = Instant::now();
            let mut total: u64 = 0;

            while running.load(Ordering::SeqCst) {
                let gap = frame_gap.load(Ordering::Relaxed);

                // Toggling HEX changes the mode without reopening the port.
                if gap > 0 && !framing {
                    if !pending.is_empty() {
                        emit_rx(&app_handle, &recorder, &autosave, now_ms(), &pending, total);
                        pending.clear();
                    }
                    framing = true;
                    last_emit = Instant::now();
                } else if gap == 0 && framing {
                    if let Some(frame) = framer.take() {
                        emit_rx(&app_handle, &recorder, &autosave, frame.ts, &frame.bytes, total);
                    }
                    framing = false;
                    last_emit = Instant::now();
                }

                match reader.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        total += n as u64;
                        if gap > 0 {
                            let now = Instant::now();
                            if let Some(frame) = framer.push(&buf[..n], now, now_ms(), gap) {
                                emit_rx(
                                    &app_handle,
                                    &recorder,
                                    &autosave,
                                    frame.ts,
                                    &frame.bytes,
                                    total,
                                );
                            }
                        } else {
                            pending.extend_from_slice(&buf[..n]);
                        }
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut => {
                        if gap > 0 {
                            if let Some(frame) = framer.poll(Instant::now(), gap) {
                                emit_rx(
                                    &app_handle,
                                    &recorder,
                                    &autosave,
                                    frame.ts,
                                    &frame.bytes,
                                    total,
                                );
                            }
                        }
                    }
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

                if gap == 0 {
                    let due = pending.len() >= FRAME_MAX_BYTES
                        || (last_emit.elapsed() >= Duration::from_millis(30)
                            && !pending.is_empty());
                    if due {
                        emit_rx(&app_handle, &recorder, &autosave, now_ms(), &pending, total);
                        pending.clear();
                        last_emit = Instant::now();
                    }
                }
            }

            if !pending.is_empty() {
                emit_rx(&app_handle, &recorder, &autosave, now_ms(), &pending, total);
            }
            if let Some(frame) = framer.take() {
                emit_rx(&app_handle, &recorder, &autosave, frame.ts, &frame.bytes, total);
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

    pub fn start_tcp(&self, app: AppHandle, host: &str, port: u16) -> Result<(), String> {
        if port == 0 {
            return Err("监听端口不能为 0".into());
        }
        let bind_ip: IpAddr = host
            .trim()
            .parse()
            .map_err(|_| format!("本机 IP 格式不正确: {host}"))?;
        self.stop();

        let listener = TcpListener::bind((bind_ip, port))
            .map_err(|e| format!("监听 {bind_ip}:{port} 失败: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("设置监听非阻塞失败: {e}"))?;

        let running = Arc::new(AtomicBool::new(true));
        let clients: Arc<Mutex<HashMap<u64, TcpStream>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let recorder = Arc::clone(&self.recorder);
        let autosave = Arc::clone(&self.autosave);
        let frame_gap = Arc::clone(&self.frame_gap_ms);
        let app_handle = app.clone();
        let accept_running = Arc::clone(&running);
        let accept_clients = Arc::clone(&clients);

        if let Ok(mut writer) = self.autosave.lock() {
            writer.start_session(&format!("TCP{port}"), 0);
        }

        let accept_handle = thread::spawn(move || {
            let mut next_id: u64 = 1;
            while accept_running.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _peer)) => {
                        let _ = stream.set_nodelay(true);
                        let read_stream = match stream.try_clone() {
                            Ok(value) => value,
                            Err(error) => {
                                eprintln!("tcp: clone client stream failed: {error}");
                                continue;
                            }
                        };
                        let id = next_id;
                        next_id += 1;
                        let accepted = if let Ok(mut map) = accept_clients.lock() {
                            if map.is_empty() {
                                map.insert(id, stream);
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        if !accepted {
                            // Single-client server, like SSCOM. Keep listening.
                            let _ = read_stream.shutdown(Shutdown::Both);
                            continue;
                        }
                        emit_tcp_clients(&app_handle, &accept_clients);
                        let _ = app_handle.emit(
                            EV_STATE,
                            StatePayload {
                                connected: true,
                                message: "TCP 客户端已连接".into(),
                            },
                        );

                        let client_app = app_handle.clone();
                        let client_running = Arc::clone(&accept_running);
                        let client_clients = Arc::clone(&accept_clients);
                        let client_recorder = Arc::clone(&recorder);
                        let client_autosave = Arc::clone(&autosave);
                        let client_frame_gap = Arc::clone(&frame_gap);
                        let client_running_after = Arc::clone(&client_running);
                        thread::spawn(move || {
                            tcp_client_loop(
                                read_stream,
                                id,
                                client_app.clone(),
                                client_running,
                                client_recorder,
                                client_autosave,
                                client_frame_gap,
                            );
                            if let Ok(mut map) = client_clients.lock() {
                                map.remove(&id);
                            }
                            emit_tcp_clients(&client_app, &client_clients);
                            if client_running_after.load(Ordering::SeqCst) {
                                let _ = client_app.emit(
                                    EV_STATE,
                                    StatePayload {
                                        connected: true,
                                        message: "TCP 客户端已断开，继续监听等待重连".into(),
                                    },
                                );
                            }
                        });
                    }
                    Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(error) => {
                        let _ = app_handle.emit(
                            EV_STATE,
                            StatePayload {
                                connected: false,
                                message: format!("TCP 监听失败: {error}"),
                            },
                        );
                        break;
                    }
                }
            }
            if let Ok(map) = accept_clients.lock() {
                for stream in map.values() {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
        });

        *self.tcp.lock().unwrap() = Some(TcpServer {
            running,
            clients: Arc::clone(&clients),
            accept: Mutex::new(Some(accept_handle)),
        });

        emit_tcp_clients(&app, &clients);
        let _ = app.emit(
            EV_STATE,
            StatePayload {
                connected: true,
                message: format!("TCP Server 监听 {bind_ip}:{port}"),
            },
        );
        Ok(())
    }

    pub fn stop_tcp(&self) {
        let Some(server) = self.tcp.lock().unwrap().take() else {
            return;
        };
        server.running.store(false, Ordering::SeqCst);
        if let Ok(clients) = server.clients.lock() {
            for stream in clients.values() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        if let Some(handle) = server.accept.lock().unwrap().take() {
            let _ = handle.join();
        }
        self.stop_recording();
        if let Ok(mut writer) = self.autosave.lock() {
            writer.flush();
        }
    }

    pub fn tcp_write_base64(&self, data: &str) -> Result<usize, String> {
        let bytes = B64.decode(data).map_err(|e| format!("数据解码失败: {e}"))?;
        let clients = {
            let guard = self.tcp.lock().unwrap();
            let server = guard
                .as_ref()
                .ok_or_else(|| "TCP Server 未启动".to_string())?;
            let guard = server.clients.lock().unwrap();
            if guard.is_empty() {
                return Err("没有 TCP 客户端连接".into());
            }
            guard
                .iter()
                .filter_map(|(id, stream)| stream.try_clone().ok().map(|clone| (*id, clone)))
                .collect::<Vec<_>>()
        };

        let mut sent = 0usize;
        for (_, mut stream) in clients {
            if stream.write_all(&bytes).is_ok() {
                sent += 1;
            }
        }
        if sent == 0 {
            return Err("TCP 客户端连接已断开".into());
        }

        let ts = now_ms();
        record_chunk(&self.recorder, "tx", ts, &bytes);
        if let Ok(mut writer) = self.autosave.lock() {
            writer.append_tx(ts, &bytes);
        }
        Ok(bytes.len())
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

    pub fn save_log_text(&self, content: &str, port_name: &str) -> Result<String, String> {
        let dir = crate::autosave::logs_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建保存目录失败: {e}"))?;
        let now = now_ms();
        let stamp = crate::autosave::filename_stamp(now);
        let port = crate::autosave::safe_port(port_name);
        let path = dir.join(format!("easylog-{stamp}-{port}.txt"));
        let body = format!(
            "# EasyLog Serial save {} · {}\r\n{}\r\n",
            crate::autosave::display_stamp(now),
            port,
            content
        );
        fs::write(&path, body.as_bytes()).map_err(|e| format!("保存日志失败: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn start_recording(&self, cfg: RecordingConfig) -> Result<String, String> {
        let serial_active = self.port.lock().unwrap().is_some();
        let tcp_active = self.tcp.lock().unwrap().is_some();
        if !serial_active && !tcp_active {
            return Err("串口/TCP Server 未启动，无法录制".into());
        }

        // Close any previous session before starting a new one.
        self.stop_recording();

        let dir = recording_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建录制目录失败: {e}"))?;

        let stamp = crate::autosave::filename_stamp(now_ms());
        let port = crate::autosave::safe_port(&cfg.port_name);
        let path = dir.join(format!("recording-{stamp}-{port}.jsonl"));

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

fn tcp_client_loop(
    mut stream: TcpStream,
    _id: u64,
    app: AppHandle,
    running: Arc<AtomicBool>,
    recorder: Arc<Mutex<Option<Recording>>>,
    autosave: Arc<Mutex<AutoSave>>,
    frame_gap: Arc<AtomicU64>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(20)));
    let mut buf = [0u8; 8192];
    let mut total: u64 = 0;
    let mut framer = FrameBuffer::new();
    let mut framing = false;

    while running.load(Ordering::SeqCst) {
        let gap = frame_gap.load(Ordering::Relaxed);

        if gap > 0 && !framing {
            framing = true;
        } else if gap == 0 && framing {
            if let Some(frame) = framer.take() {
                emit_rx(&app, &recorder, &autosave, frame.ts, &frame.bytes, total);
            }
            framing = false;
        }

        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                total += n as u64;
                if gap > 0 {
                    if let Some(frame) = framer.push(&buf[..n], Instant::now(), now_ms(), gap) {
                        emit_rx(&app, &recorder, &autosave, frame.ts, &frame.bytes, total);
                    }
                } else {
                    emit_rx(&app, &recorder, &autosave, now_ms(), &buf[..n], total);
                }
            }
            Err(ref error)
                if error.kind() == ErrorKind::WouldBlock
                    || error.kind() == ErrorKind::TimedOut =>
            {
                if gap > 0 {
                    if let Some(frame) = framer.poll(Instant::now(), gap) {
                        emit_rx(&app, &recorder, &autosave, frame.ts, &frame.bytes, total);
                    }
                }
                continue;
            }
            Err(_) => break,
        }
    }

    if let Some(frame) = framer.take() {
        emit_rx(&app, &recorder, &autosave, frame.ts, &frame.bytes, total);
    }
}

fn emit_tcp_clients(app: &AppHandle, clients: &Arc<Mutex<HashMap<u64, TcpStream>>>) {
    let clients = clients
        .lock()
        .map(|map| {
            map.values()
                .filter_map(|stream| stream.peer_addr().ok().map(|addr| addr.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let _ = app.emit(
        EV_TCP_CLIENTS,
        TcpClientsPayload {
            count: clients.len(),
            clients,
        },
    );
}

fn emit_rx(
    app: &AppHandle,
    recorder: &Arc<Mutex<Option<Recording>>>,
    autosave: &Arc<Mutex<AutoSave>>,
    ts: u64,
    bytes: &[u8],
    total: u64,
) {
    let _ = app.emit(
        EV_DATA,
        DataPayload {
            ts,
            data: B64.encode(bytes),
            rx_total: total,
        },
    );
    record_chunk(recorder, "rx", ts, bytes);
    if let Ok(mut writer) = autosave.lock() {
        writer.append_rx(ts, bytes);
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
    crate::autosave::logs_dir().join("recordings")
}

pub fn local_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_buffer_flushes_after_idle_gap() {
        let base = Instant::now();
        let mut buffer = FrameBuffer::new();
        assert!(buffer.push(&[0x01, 0x03], base, 1_000, 30).is_none());
        assert!(buffer.poll(base + Duration::from_millis(20), 30).is_none());

        let frame = buffer
            .poll(base + Duration::from_millis(30), 30)
            .expect("idle gap should flush");
        assert_eq!(frame.bytes, vec![0x01, 0x03]);
        assert_eq!(frame.ts, 1_000);
        assert!(buffer.is_empty());
    }

    #[test]
    fn frame_buffer_starts_new_frame_after_gap() {
        let base = Instant::now();
        let mut buffer = FrameBuffer::new();
        assert!(buffer.push(&[0x01], base, 1_000, 30).is_none());

        let first = buffer
            .push(&[0x02], base + Duration::from_millis(31), 1_031, 30)
            .expect("new data after idle gap should close the old frame");
        assert_eq!(first.bytes, vec![0x01]);

        let second = buffer
            .poll(base + Duration::from_millis(70), 30)
            .expect("second frame should flush");
        assert_eq!(second.bytes, vec![0x02]);
        assert_eq!(second.ts, 1_031);
    }

    #[test]
    fn frame_buffer_keeps_bytes_inside_the_gap() {
        let base = Instant::now();
        let mut buffer = FrameBuffer::new();
        assert!(buffer.push(&[0x01], base, 1_000, 30).is_none());
        assert!(
            buffer
                .push(&[0x02], base + Duration::from_millis(10), 1_010, 30)
                .is_none()
        );

        let frame = buffer
            .poll(base + Duration::from_millis(41), 30)
            .expect("gap is measured from the last byte");
        assert_eq!(frame.bytes, vec![0x01, 0x02]);
    }

    #[test]
    fn frame_buffer_caps_long_frames() {
        let base = Instant::now();
        let mut buffer = FrameBuffer::new();
        let data = vec![0xAA; FRAME_MAX_BYTES];
        let frame = buffer
            .push(&data, base, 1_000, 30)
            .expect("max bytes should force a line");
        assert_eq!(frame.bytes.len(), FRAME_MAX_BYTES);
    }

    #[test]
    fn frame_buffer_caps_frame_age_without_idle() {
        let base = Instant::now();
        let mut buffer = FrameBuffer::new();
        assert!(buffer.push(&[0x01], base, 1_000, 1_000).is_none());

        let frame = buffer
            .poll(base + Duration::from_millis(FRAME_MAX_AGE_MS + 1), 1_000)
            .expect("max age should force a line");
        assert_eq!(frame.bytes, vec![0x01]);
    }
}
