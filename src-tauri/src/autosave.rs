//! Automatic session recording.
//!
//! Two files are written for every segment, sharing the same enable switch and
//! size budget:
//!
//! - `auto-000001.jsonl` — lossless JSONL (base64) for replay/compatibility
//! - `auto-000001.log`   — readable `[timestamp] RX/TX text` for humans and
//!   tools that cannot decode the JSONL recording
//!
//! Files live next to the executable in `logs/auto`, so the portable app keeps
//! its recording with the tool. Segments are 1 MB; the total cap is user
//! configurable and the oldest segment pair is deleted first.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{Local, TimeZone};
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
    text: BufWriter<File>,
    path: PathBuf,
    json_size: u64,
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
            let _ = segment.text.flush();
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
        let text = text_record(kind, ts, bytes);
        if let Err(error) = self.write_record(format!("{line}\n").as_bytes(), text.as_bytes()) {
            eprintln!("autosave: write failed: {error}");
        }
    }

    fn write_record(&mut self, json: &[u8], text: &[u8]) -> Result<(), String> {
        self.ensure_segment()?;

        let should_rotate = self
            .current
            .as_ref()
            .map(|segment| segment.json_size > 0 && segment.json_size + json.len() as u64 > SEGMENT_BYTES)
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
            .write_all(json)
            .map_err(|e| format!("写入自动录制失败: {e}"))?;
        segment
            .text
            .write_all(text)
            .map_err(|e| format!("写入自动文本录制失败: {e}"))?;
        segment.json_size += json.len() as u64;
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
            let _ = segment.text.flush();
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
            let text_path = self.dir.join(format!("auto-{:06}.log", self.next_index));
            self.next_index += 1;
            if path.exists() || text_path.exists() {
                continue;
            }
            let file = OpenOptions::new()
                .create_new(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("创建自动录制文件失败: {e}"))?;
            let text = OpenOptions::new()
                .create_new(true)
                .append(true)
                .open(&text_path)
                .map_err(|e| format!("创建自动文本录制文件失败: {e}"))?;
            self.current = Some(Segment {
                file: BufWriter::new(file),
                text: BufWriter::new(text),
                path,
                json_size: 0,
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
        let text = format!(
            "# EasyLog Serial auto save {} · {} @ {}\n",
            format_ts(meta.started),
            meta.port,
            meta.baud
        );
        self.write_record(format!("{line}\n").as_bytes(), text.as_bytes())
    }

    fn flush_file(&mut self) {
        if let Some(segment) = self.current.as_mut() {
            let _ = segment.file.flush();
            let _ = segment.text.flush();
        }
    }

    fn cleanup(&mut self) -> Result<(), String> {
        let mut files = segments(&self.dir);
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
    let text_path = path.with_extension("log");
    if text_path.exists() {
        if let Err(error) = fs::remove_file(&text_path) {
            eprintln!("autosave: remove {:?} failed: {error}", text_path);
        }
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
        let json_size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        let text_size = fs::metadata(path.with_extension("log"))
            .map(|meta| meta.len())
            .unwrap_or(0);
        items.push((index, path, json_size + text_size));
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

fn format_ts(ts: u64) -> String {
    Local
        .timestamp_millis_opt(ts as i64)
        .single()
        .map(|time| time.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| ts.to_string())
}

fn text_record(kind: &str, ts: u64, bytes: &[u8]) -> String {
    let stamp = format_ts(ts);
    let tag = kind.to_uppercase();
    let raw = String::from_utf8_lossy(bytes);
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    for line in normalized.split('\n') {
        if line.is_empty() {
            continue;
        }
        out.push_str(&format!("[{stamp}] {tag} {line}\n"));
    }
    if out.is_empty() {
        out.push_str(&format!("[{stamp}] {tag}\n"));
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::text_record;

    #[test]
    fn text_record_prefixes_each_line() {
        let text = text_record("rx", 1_700_000_000_000, b"[GPS] one\r\n[GPS] two\r\n");
        assert!(text.contains(" RX [GPS] one\n"));
        assert!(text.contains(" RX [GPS] two\n"));
        assert!(!text.contains("RX \n"));
    }

    #[test]
    fn text_record_marks_tx() {
        let text = text_record("tx", 1_700_000_000_000, b"AT+CSQ\r\n");
        assert!(text.contains(" TX AT+CSQ\n"));
    }
}
