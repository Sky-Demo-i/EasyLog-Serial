import { formatBytes } from "../lib/format";
import type { AutoSaveInfo } from "../types";

interface Props {
  connected: boolean;
  transport: "serial" | "tcp";
  tcpClients: number;
  portName: string;
  baudRate: number;
  rx: number;
  tx: number;
  lines: number;
  totalLines: number;
  rate: number;
  paused: boolean;
  hexMode: boolean;
  recording: boolean;
  recordPath: string;
  replaying: boolean;
  replayName: string;
  status: string;
  autoSaveInfo: AutoSaveInfo | null;
}

export default function StatusBar({
  connected,
  transport,
  tcpClients,
  portName,
  baudRate,
  rx,
  tx,
  lines,
  totalLines,
  rate,
  paused,
  hexMode,
  recording,
  recordPath,
  replaying,
  replayName,
  status,
  autoSaveInfo,
}: Props) {
  const autoSaveText = !autoSaveInfo
    ? "自动保存 …"
    : autoSaveInfo.enabled
      ? "自动保存"
      : "自动保存 关";

  return (
    <div className="status-bar">
      <span className={`dot ${connected ? "on" : ""}`} />
      <span className="status-port">
        {connected
          ? transport === "tcp"
            ? `TCP Server ${portName} · ${
                tcpClients > 0 ? `客户端 ${tcpClients}` : "等待客户端"
              }`
            : `${portName} @ ${baudRate}`
          : transport === "tcp"
            ? "TCP 未启动"
            : "未连接"}
      </span>
      <span className="sep">|</span>
      <span>RX {formatBytes(rx)}</span>
      <span>TX {formatBytes(tx)}</span>
      <span>
        行 {lines.toLocaleString()}
        {totalLines !== lines ? ` / ${totalLines.toLocaleString()}` : ""}
      </span>
      <span>{rate} B/s</span>
      <span
        className={`status-autosave ${
          autoSaveInfo?.enabled ? "" : "off"
        }`}
        title={autoSaveInfo?.dir || "工具目录\\logs\\auto（最多 10MB，循环覆盖）"}
      >
        {autoSaveText}
      </span>
      {hexMode && <span className="badge hex">HEX</span>}
      {paused && <span className="badge warn">已暂停</span>}
      {recording && (
        <span className="badge rec" title={recordPath}>
          ● 录制
        </span>
      )}
      {replaying && (
        <span className="badge rec" title={replayName}>
          ▶ 回放
        </span>
      )}
      <span className="status-message" title={status}>
        {status}
      </span>
      <span className="app-meta" title="作者 · 版本">
        lyg · v0.3.24
      </span>
    </div>
  );
}
