mod autosave;
mod serial;

use autosave::AutoSaveInfo;
use serial::{
    PortInfo, RecordingConfig, SerialConfig, SerialManager, StatePayload, EV_STATE,
};
use tauri::Emitter;

#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    serial::list_ports()
}

#[tauri::command]
fn open_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, SerialManager>,
    config: SerialConfig,
) -> Result<(), String> {
    state.open(app, config)
}

#[tauri::command]
fn close_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, SerialManager>,
) -> Result<(), String> {
    state.close();
    let _ = app.emit(
        EV_STATE,
        StatePayload {
            connected: false,
            message: "已断开".into(),
        },
    );
    Ok(())
}

#[tauri::command]
fn write_port(state: tauri::State<'_, SerialManager>, data: String) -> Result<usize, String> {
    state.write_base64(&data)
}

#[tauri::command]
fn set_signals(
    state: tauri::State<'_, SerialManager>,
    dtr: bool,
    rts: bool,
) -> Result<(), String> {
    state.set_signals(dtr, rts)
}

#[tauri::command]
fn start_recording(
    state: tauri::State<'_, SerialManager>,
    config: RecordingConfig,
) -> Result<String, String> {
    state.start_recording(config)
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, SerialManager>) -> Option<String> {
    state.stop_recording()
}

#[tauri::command]
fn set_autosave(
    state: tauri::State<'_, SerialManager>,
    enabled: bool,
    max_mb: u32,
) -> AutoSaveInfo {
    state.set_autosave(enabled, max_mb)
}

#[tauri::command]
fn autosave_info(state: tauri::State<'_, SerialManager>) -> AutoSaveInfo {
    state.autosave_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialManager::new())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            write_port,
            set_signals,
            start_recording,
            stop_recording,
            set_autosave,
            autosave_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
