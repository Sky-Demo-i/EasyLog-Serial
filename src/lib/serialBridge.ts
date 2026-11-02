import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AutoSaveInfo,
  PortInfo,
  SerialConfig,
  SerialDataPayload,
  SerialStatePayload,
} from "../types";
import { bytesToBase64 } from "./format";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ------------------------------------------------------------------ */
/* Mock transport: lets the UI run in a plain browser during frontend  */
/* development, without the Rust backend.                              */
/* ------------------------------------------------------------------ */

const mockDataListeners = new Set<(p: SerialDataPayload) => void>();
const mockStateListeners = new Set<(p: SerialStatePayload) => void>();
let mockTimer: number | undefined;
let mockRxTotal = 0;
let mockLineIndex = 0;

const MOCK_LINES = [
  "\x1b[34;22mV/TRK    (185 jm_pal_get_utc_time)[480],1970-1-1 8:32:54, 480\x1b[0m",
  "\x1b[34;22mV/TRK    (360 jm_sensor_sc7a20h_get_xyz)raw:80 07 60 09 70 c4, X = 30  Y = 37  Z = -239 \x1b[0m",
  "\x1b[32;22mD/TRK    (255 track_master_rollover_norm_check)x:y:z=1:22:20 over:2 acc:243 stage_t:1,  (30:37:-239)\x1b[0m",
  "\x1b[32;22mI/SYS    (46 jm_sys_heartbeat)tick=1024 heap=18320\x1b[0m",
  "\x1b[33;22mW/TRK    (312 track_master_rollover_norm_check)rollover margin low: acc=31\x1b[0m",
];

function emitMockState(connected: boolean, message: string) {
  const payload: SerialStatePayload = { connected, message };
  mockStateListeners.forEach((cb) => cb(payload));
}

function startMock(): void {
  if (mockTimer !== undefined) return;
  mockTimer = window.setInterval(() => {
    const line = `${MOCK_LINES[mockLineIndex % MOCK_LINES.length]}\r\n`;
    mockLineIndex += 1;
    const bytes = new TextEncoder().encode(line);
    mockRxTotal += bytes.length;
    const payload: SerialDataPayload = {
      ts: Date.now(),
      data: bytesToBase64(bytes),
      rxTotal: mockRxTotal,
    };
    mockDataListeners.forEach((cb) => cb(payload));
  }, 240);
}

function stopMock(): void {
  if (mockTimer !== undefined) {
    window.clearInterval(mockTimer);
    mockTimer = undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Public bridge                                                       */
/* ------------------------------------------------------------------ */

export async function listPorts(): Promise<PortInfo[]> {
  if (!isTauri()) {
    return [
      {
        name: "COM3",
        kind: "USB",
        product: "USB-SERIAL CH340",
        manufacturer: "wch.cn",
      },
      {
        name: "COM7",
        kind: "USB",
        product: "STMicroelectronics Virtual COM Port",
        manufacturer: "STMicroelectronics",
      },
    ];
  }
  return invoke<PortInfo[]>("list_ports");
}

export async function openPort(config: SerialConfig): Promise<void> {
  if (!isTauri()) {
    emitMockState(true, `已连接 ${config.portName} @ ${config.baudRate}（模拟）`);
    startMock();
    return;
  }
  await invoke("open_port", { config });
}

export async function closePort(): Promise<void> {
  if (!isTauri()) {
    stopMock();
    emitMockState(false, "已断开（模拟）");
    return;
  }
  await invoke("close_port");
}

export async function writePort(base64: string): Promise<number> {
  if (!isTauri()) {
    return atob(base64).length;
  }
  return invoke<number>("write_port", { data: base64 });
}

export async function setSignals(dtr: boolean, rts: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_signals", { dtr, rts });
}

/** 0 disables idle framing; >0 splits serial RX into one line per idle gap. */
export async function setFrameGap(gapMs: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_frame_gap", { gapMs });
}

export async function startRecording(
  portName: string,
  baudRate: number,
): Promise<string> {
  if (!isTauri()) return `mock-sessions/recording-${Date.now()}-${portName}.jsonl`;
  return invoke<string>("start_recording", {
    config: { portName, baudRate },
  });
}

export async function stopRecording(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("stop_recording");
}

export async function saveLogText(content: string, portName: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("save_log_text", { content, portName });
}

export async function exportCommands(
  content: string,
  suggestedName: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("export_commands", { content, suggestedName });
}

export interface TcpClientsPayload {
  count: number;
  clients: string[];
}

export async function startTcpServer(host: string, port: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("start_tcp_server", { host, port });
}

export async function localIp(): Promise<string> {
  if (!isTauri()) return "127.0.0.1";
  return invoke<string>("local_ip");
}

export async function stopTcpServer(): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_tcp_server");
}

export async function writeTcp(data: string): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("tcp_write_port", { data });
}

export async function onTcpClients(
  cb: (payload: TcpClientsPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<TcpClientsPayload>("tcp://clients", (event) => cb(event.payload));
}

const MOCK_AUTOSAVE: AutoSaveInfo = {
  enabled: true,
  dir: "（浏览器模拟）logs/auto",
  bytes: 0,
  files: 0,
  maxBytes: 10 * 1024 * 1024,
};

export async function setAutoSave(
  enabled: boolean,
  maxMb: number,
): Promise<AutoSaveInfo> {
  if (!isTauri()) {
    MOCK_AUTOSAVE.enabled = enabled;
    MOCK_AUTOSAVE.maxBytes = maxMb * 1024 * 1024;
    return { ...MOCK_AUTOSAVE };
  }
  return invoke<AutoSaveInfo>("set_autosave", { enabled, maxMb });
}

export async function getAutoSaveInfo(): Promise<AutoSaveInfo> {
  if (!isTauri()) return { ...MOCK_AUTOSAVE };
  return invoke<AutoSaveInfo>("autosave_info");
}

export async function onSerialData(
  cb: (payload: SerialDataPayload) => void,
): Promise<() => void> {
  if (!isTauri()) {
    mockDataListeners.add(cb);
    return () => mockDataListeners.delete(cb);
  }
  return listen<SerialDataPayload>("serial://data", (event) => cb(event.payload));
}

export async function onSerialState(
  cb: (payload: SerialStatePayload) => void,
): Promise<() => void> {
  if (!isTauri()) {
    mockStateListeners.add(cb);
    return () => mockStateListeners.delete(cb);
  }
  return listen<SerialStatePayload>("serial://state", (event) => cb(event.payload));
}
