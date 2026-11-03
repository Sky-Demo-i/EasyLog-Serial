#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use zip::ZipArchive;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Args {
    pid: u32,
    target: PathBuf,
    zip: PathBuf,
    log: PathBuf,
    staging: PathBuf,
    backup: PathBuf,
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn parse_args() -> Result<Args, String> {
    let args: Vec<String> = env::args().collect();
    let pid = arg_value(&args, "--pid")
        .ok_or("缺少 --pid")?
        .parse::<u32>()
        .map_err(|_| "--pid 无效")?;
    let target = PathBuf::from(arg_value(&args, "--target").ok_or("缺少 --target")?);
    let zip = PathBuf::from(arg_value(&args, "--zip").ok_or("缺少 --zip")?);
    let log = PathBuf::from(arg_value(&args, "--log").ok_or("缺少 --log")?);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let staging = arg_value(&args, "--staging")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join(format!("EasyLogSerial-staging-{stamp}")));
    let backup = arg_value(&args, "--backup")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join(format!("EasyLogSerial-backup-{stamp}")));
    Ok(Args {
        pid,
        target,
        zip,
        log,
        staging,
        backup,
    })
}

fn log(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {message}", timestamp());
    }
}

fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

fn wait_for_process(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return Ok(());
            }
            let result = WaitForSingleObject(handle, 90_000);
            CloseHandle(handle);
            if result == WAIT_OBJECT_0 {
                Ok(())
            } else {
                Err("等待主程序退出超时".into())
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Ok(())
    }
}

fn extract_zip(zip_path: &Path, staging: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|error| format!("打开更新包失败: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("解析更新包失败: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取更新包条目失败: {error}"))?;
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let output = staging.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("创建目录失败: {error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
        }
        let mut target = File::create(&output).map_err(|error| format!("创建文件失败: {error}"))?;
        io::copy(&mut entry, &mut target).map_err(|error| format!("解压失败: {error}"))?;
    }
    Ok(())
}

fn collect_files(root: &Path, base: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("读取目录失败: {error}"))? {
        let entry = entry.map_err(|error| format!("读取目录失败: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, base, files)?;
        } else {
            files.push(
                path.strip_prefix(base)
                    .map_err(|_| "计算相对路径失败")?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    let mut input = File::open(source).map_err(|error| format!("读取文件失败: {error}"))?;
    let mut output = File::create(target).map_err(|error| format!("写入文件失败: {error}"))?;
    io::copy(&mut input, &mut output).map_err(|error| format!("复制失败: {error}"))?;
    Ok(())
}

fn replace_files(args: &Args) -> Result<(), String> {
    let staged_exe = args.staging.join("EasyLogSerial.exe");
    if !staged_exe.is_file() {
        return Err("更新包中缺少 EasyLogSerial.exe".into());
    }

    fs::create_dir_all(&args.backup).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let mut files = Vec::new();
    collect_files(&args.staging, &args.staging, &mut files)?;
    if files.is_empty() {
        return Err("更新包为空".into());
    }

    let mut backed_up: Vec<PathBuf> = Vec::new();
    for relative in &files {
        let target = args.target.join(relative);
        if !target.is_file() {
            continue;
        }
        let backup = args.backup.join(relative);
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建备份目录失败: {error}"))?;
        }
        fs::copy(&target, &backup).map_err(|error| {
            format!("备份 {} 失败: {error}", target.display())
        })?;
        backed_up.push(relative.clone());
    }

    for relative in &files {
        let target = args.target.join(relative);
        let source = args.staging.join(relative);
        if target.exists() {
            let _ = fs::remove_file(&target);
        }
        if let Err(error) = copy_file(&source, &target) {
            restore_backups(args, &backed_up);
            return Err(format!("替换 {} 失败: {error}", target.display()));
        }
    }
    Ok(())
}

fn restore_backups(args: &Args, files: &[PathBuf]) {
    for relative in files {
        let target = args.target.join(relative);
        let backup = args.backup.join(relative);
        if backup.is_file() {
            let _ = fs::remove_file(&target);
            let _ = copy_file(&backup, &target);
        }
    }
}

fn restore_all_backups(args: &Args) {
    let mut files = Vec::new();
    if collect_files(&args.backup, &args.backup, &mut files).is_ok() {
        restore_backups(args, &files);
    }
}

fn start_app(target: &Path) -> Result<(), String> {
    let exe = target.join("EasyLogSerial.exe");
    let mut command = Command::new(&exe);
    command.current_dir(target);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动主程序失败: {error}"))
}

fn run(args: &Args) -> Result<(), String> {
    log(&args.log, "updater started");
    wait_for_process(args.pid)?;
    log(&args.log, "main process exited");

    if args.staging.exists() {
        let _ = fs::remove_dir_all(&args.staging);
    }
    fs::create_dir_all(&args.staging).map_err(|error| format!("创建 staging 失败: {error}"))?;
    extract_zip(&args.zip, &args.staging)?;
    log(&args.log, "update extracted");

    if let Err(error) = replace_files(args) {
        log(&args.log, &format!("replace failed: {error}"));
        let _ = start_app(&args.target);
        return Err(error);
    }
    log(&args.log, "files replaced");

    if let Err(error) = start_app(&args.target) {
        log(&args.log, &format!("restart failed: {error}"));
        restore_all_backups(args);
        let _ = start_app(&args.target);
        return Err(error);
    }
    log(&args.log, "new app started");

    let _ = fs::remove_file(&args.zip);
    let _ = fs::remove_dir_all(&args.staging);
    Ok(())
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            let _ = fs::write(
                env::temp_dir().join("EasyLogSerial-updater-error.log"),
                error,
            );
            return;
        }
    };
    if let Err(error) = run(&args) {
        log(&args.log, &format!("ERROR: {error}"));
        thread::sleep(Duration::from_millis(200));
    }
}
