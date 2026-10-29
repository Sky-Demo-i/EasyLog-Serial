//! Automatic session recording in the same JSONL format as manual recording.
//!
//! Files live next to the executable in `logs/auto`, so the portable app keeps
//! its recording with the tool. Segments are 1 MB; the total cap is user
//! configurable and the oldest segment is deleted first.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::json;

const SEGMENT_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const MIN_MAX_BYTES: u64 = 1024 * 1024;
const MAX_MAX_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveInfo {
    pub enabled: bool,
    pub dir: String,
    pub bytes: u64,
    pub files: usize,
    pub max_bytes: u64,
}

struct Segment {
    file: BufWriter<File>,
    path: PathBuf,
    size: u64,
}

#[derive(Clone)]
struct SessionMeta {
    started: u64,
    port: String,
    baud: u32,
}

pub struct AutoSave {
    enabled: bool,
    dir: PathBuf,
    current: Option<Segment>,
    next_index: u64,
    max_bytes: u64,
    meta: Option<SessionMeta>,
}

impl AutoSave {
    pub fn new() -> Self {
        Self {
            enabled: true,
            dir: autosave_dir(),
            current: None,
            next_index: 1,
            max_bytes: DEFAULT_MAX_BYTES,
            meta: None,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool, max_bytes: u64) -> AutoSaveInfo {
        self.enabled = enabled;
        self.max_bytes = max_bytes.clamp(MIN_MAX_BYTES, MAX_MAX_BYTES);

        if enabled {
            if let Err(error) = fs::create_dir_all(&self.dir) {
                eprintln!("autosave: create dir failed: {error}");
            }
            if let Err(error) = self.cleanup() {
                eprintln!("autosave: cleanup failed: {error}");
            }
        } else if let Some(mut segment) = self.current.take() {
            let _ = segment.file.flush();
        }
        self.info()
    }

    pub fn start_session(&mut self, port_name: &str, baud_rate: u32) {
        if !self.enabled {
            return;
        }
        self.meta = Some(SessionMeta {
            started: now_ms(),
            port: port_name.to_string(),
            baud: baud_rate,
        });
        if let Err(error) = self.rotate() {
            eprintln!("autosave: start session failed: {error}");
        }
    }

    pub fn append_rx(&mut self, ts: u64, bytes: &[u8]) {
        self.append_event("rx", ts, bytes);
    }

    pub fn append_tx(&mut self, ts: u64, bytes: &[u8]) {
        self.append_event("tx", ts, bytes);
    }

    pub fn flush(&mut self) {
        self.flush_file();
    }

    pub fn info(&self) -> AutoSaveInfo {
        let (files, bytes, _) = scan(&self.dir);
        AutoSaveInfo {
            enabled: self.enabled,
            dir: self.dir.to_string_lossy().into_owned(),
            bytes,
            files,
            max_bytes: self.max_bytes,
        }
    }

    fn append_event(&mut self, kind: &str, ts: u64, bytes: &[u8]) {
        if !self.enabled || bytes.is_empty() {
            return;
        }
        let line = json!({
            "type": kind,
            "ts": ts,
            "data": B64.encode(bytes),
        })
        .to_string();
        if let Err(error) = self.write_record(format!("{line}\n").as_bytes()) {
            eprintln!("autosave: write failed: {error}");
        }
    }

    fn write_record(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.ensure_segment()?;

        let should_rotate = self
            .current
            .as_ref()
            .map(|segment| segment.size > 0 && segment.size + bytes.len() as u64 > SEGMENT_BYTES)
            .unwrap_or(false);
        if should_rotate {
            self.rotate()?;
        }

        let segment = self
            .current
            .as_mut()
            .ok_or_else(|| "autosave segment missing".to_string())?;
        segment
            .file
            .write_all(bytes)
            .map_err(|e| format!("写入自动录制失败: {e}"))?;
        segment.size += bytes.len() as u64;
        self.flush_file();
        Ok(())
    }

    fn ensure_segment(&mut self) -> Result<(), String> {
        if self.current.is_none() {
            self.rotate()?;
        }
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), String> {
        if let Some(mut segment) = self.current.take() {
            let _ = segment.file.flush();
        }
        fs::create_dir_all(&self.dir).map_err(|e| format!("创建自动录制目录失败: {e}"))?;

        let (_, _, max_index) = scan(&self.dir);
        if self.next_index <= max_index {
            self.next_index = max_index + 1;
        }

        loop {
            let path = self
                .dir
                .join(format!("auto-{:06}.jsonl", self.next_index));
            self.next_index += 1;
            if path.exists() {
                continue;
            }
            let file = OpenOptions::new()
                .create_new(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("创建自动录制文件失败: {e}"))?;
            self.current = Some(Segment {
                file: BufWriter::new(file),
                path,
                size: 0,
            });
            break;
        }

        if let Some(meta) = self.meta.clone() {
            self.write_meta(&meta)?;
        }
        self.cleanup()?;
        Ok(())
    }

    fn write_meta(&mut self, meta: &SessionMeta) -> Result<(), String> {
        let line = json!({
            "type": "meta",
            "version": 1,
            "started": meta.started,
            "port": meta.port,
            "baud": meta.baud,
            "auto": true,
        })
        .to_string();
        let bytes = format!("{line}\n");
        let segment = self
            .current
            .as_mut()
            .ok_or_else(|| "autosave segment missing".to_string())?;
        segment
            .file
            .write_all(bytes.as_bytes())
            .map_err(|e| format!("写入自动录制头失败: {e}"))?;
        segment.size += bytes.len() as u64;
        self.flush_file();
        Ok(())
    }

    fn flush_file(&mut self) {
        if let Some(segment) = self.current.as_mut() {
            let _ = segment.file.flush();
        }
    }

    fn cleanup(&mut self) -> Result<(), String> {
        let max_files = (self.max_bytes / SEGMENT_BYTES).max(1) as usize;
        let mut files = segments(&self.dir);
        while files.len() > max_files {
            if !remove_oldest(&mut files, self.current.as_ref()) {
                break;
            }
        }

        let mut total: u64 = files.iter().map(|(_, _, size)| *size).sum();
        while total > self.max_bytes && files.len() > 1 {
            let (_, _, size) = files[0];
            if !remove_oldest(&mut files, self.current.as_ref()) {
                break;
            }
            total = total.saturating_sub(size);
        }
        Ok(())
    }
}

fn remove_oldest(
    files: &mut Vec<(u64, PathBuf, u64)>,
    current: Option<&Segment>,
) -> bool {
    if files.is_empty() {
        return false;
    }
    let (_, path, _) = files.remove(0);
    if current.map(|segment| segment.path == path).unwrap_or(false) {
        files.insert(0, (0, path, 0));
        return false;
    }
    if let Err(error) = fs::remove_file(&path) {
        eprintln!("autosave: remove {:?} failed: {error}", path);
    }
    true
}

/// Directory containing the running executable. This is the portable root:
/// `logs/auto` sits next to `EasyLogSerial.exe`.
pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn autosave_dir() -> PathBuf {
    app_dir().join("logs").join("auto")
}

fn segments(dir: &Path) -> Vec<(u64, PathBuf, u64)> {
    let mut items = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return items;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(index) = segment_index(&path) else {
            continue;
        };
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        items.push((index, path, size));
    }
    items.sort_by_key(|(index, _, _)| *index);
    items
}

fn segment_index(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?;
    name.strip_prefix("auto-")?
        .strip_suffix(".jsonl")?
        .parse::<u64>()
        .ok()
}

fn scan(dir: &Path) -> (usize, u64, u64) {
    let items = segments(dir);
    let bytes = items.iter().map(|(_, _, size)| *size).sum();
    let max_index = items.iter().map(|(index, _, _)| *index).max().unwrap_or(0);
    (items.len(), bytes, max_index)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
