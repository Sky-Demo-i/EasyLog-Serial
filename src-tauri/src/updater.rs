use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/Sky-Demo-i/EasyLog-Serial/releases/latest/download/latest.json";
const UPDATE_EVENT: &str = "update://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub size: u64,
    pub url: String,
    pub sha256: String,
    pub mandatory: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateManifest {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: String,
    url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    mandatory: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: u64,
}

fn manifest_url() -> String {
    std::env::var("EASYLOG_UPDATE_URL").unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string())
}

fn is_local_override() -> bool {
    std::env::var("EASYLOG_UPDATE_URL").is_ok()
}

fn allowed_download_url(url: &str) -> bool {
    if url.starts_with("https://github.com/Sky-Demo-i/EasyLog-Serial/releases/") {
        return true;
    }
    if is_local_override()
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"))
    {
        return true;
    }
    false
}

fn newer(remote: &str, current: &str) -> bool {
    match (
        semver::Version::parse(remote.trim_start_matches('v')),
        semver::Version::parse(current.trim_start_matches('v')),
    ) {
        (Ok(remote), Ok(current)) => remote > current,
        _ => remote.trim_start_matches('v') != current.trim_start_matches('v'),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取更新包失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取更新包失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub fn check_update() -> Result<Option<UpdateInfo>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(12))
        .timeout_read(Duration::from_secs(20))
        .build();
    let response = agent
        .get(&manifest_url())
        .call()
        .map_err(|error| format!("检查更新失败: {error}"))?;
    let text = response
        .into_string()
        .map_err(|error| format!("读取更新信息失败: {error}"))?;
    let manifest: UpdateManifest =
        serde_json::from_str(&text).map_err(|error| format!("更新信息格式错误: {error}"))?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    if !newer(&manifest.version, &current) {
        return Ok(None);
    }
    if !allowed_download_url(&manifest.url) {
        return Err("更新下载地址不是允许的 GitHub Release 地址".into());
    }
    if manifest.sha256.len() != 64 {
        return Err("更新清单缺少有效的 SHA256".into());
    }
    Ok(Some(UpdateInfo {
        current_version: current,
        version: manifest.version,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        size: manifest.size,
        url: manifest.url,
        sha256: manifest.sha256.to_lowercase(),
        mandatory: manifest.mandatory,
    }))
}

#[tauri::command]
pub fn download_update(
    app: AppHandle,
    url: String,
    sha256: String,
    version: String,
) -> Result<String, String> {
    if !allowed_download_url(&url) {
        return Err("拒绝下载非 GitHub Release 地址".into());
    }
    let safe_version = version
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '.' || *value == '-')
        .collect::<String>();
    let dir = std::env::temp_dir().join("EasyLogSerial-update");
    fs::create_dir_all(&dir).map_err(|error| format!("创建更新目录失败: {error}"))?;
    let zip_path = dir.join(format!("EasyLog-Serial-{safe_version}-portable.zip"));

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(180))
        .build();
    let response = agent
        .get(&url)
        .call()
        .map_err(|error| format!("下载更新失败: {error}"))?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = response.into_reader();
    let mut file = File::create(&zip_path).map_err(|error| format!("创建更新包失败: {error}"))?;
    let mut downloaded = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("下载更新失败: {error}"))?;
        if read == 0 {
            break;
        }
        downloaded += read as u64;
        if downloaded > 250 * 1024 * 1024 {
            let _ = fs::remove_file(&zip_path);
            return Err("更新包超过 250MB，已取消".into());
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入更新包失败: {error}"))?;
        let _ = app.emit(
            UPDATE_EVENT,
            UpdateProgress {
                downloaded,
                total: total.max(downloaded),
            },
        );
    }
    file.flush().map_err(|error| format!("写入更新包失败: {error}"))?;
    drop(file);

    let actual = sha256_file(&zip_path)?;
    if actual != sha256.to_lowercase() {
        let _ = fs::remove_file(&zip_path);
        return Err(format!("更新包校验失败（实际 {actual}）"));
    }
    let _ = app.emit(
        UPDATE_EVENT,
        UpdateProgress {
            downloaded,
            total: total.max(downloaded),
        },
    );
    Ok(zip_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn install_update(app: AppHandle, zip_path: String) -> Result<(), String> {
    let zip = PathBuf::from(&zip_path);
    if !zip.is_file() {
        return Err("更新包不存在".into());
    }
    let exe = std::env::current_exe().map_err(|error| format!("获取程序路径失败: {error}"))?;
    let target = exe
        .parent()
        .ok_or("无法确定程序目录")?
        .to_path_buf();
    let helper = target.join("EasyLogSerialUpdater.exe");
    if !helper.is_file() {
        return Err("缺少 EasyLogSerialUpdater.exe，请重新下载完整便携包".into());
    }
    let helper_copy = std::env::temp_dir().join(format!(
        "EasyLogSerialUpdater-{}.exe",
        std::process::id()
    ));
    fs::copy(&helper, &helper_copy).map_err(|error| format!("准备更新器失败: {error}"))?;
    let log = std::env::temp_dir()
        .join("EasyLogSerial-update")
        .join("updater.log");

    let mut command = Command::new(&helper_copy);
    command
        .arg("--pid")
        .arg(std::process::id().to_string())
        .arg("--target")
        .arg(&target)
        .arg("--zip")
        .arg(&zip)
        .arg("--log")
        .arg(&log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| format!("启动更新器失败: {error}"))?;

    app.exit(0);
    Ok(())
}
