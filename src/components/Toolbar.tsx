import { useEffect, useRef, useState } from "react";
import type {
  ConnectOptions,
  Encoding,
  Parity,
  PortInfo,
  SerialConfig,
  ThemeMode,
} from "../types";

const BAUD_RATES = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000,
];

interface Props {
  ports: PortInfo[];
  config: SerialConfig;
  connected: boolean;
  busy: boolean;
  transport: "serial" | "tcp";
  tcpPort: number;
  tcpHost: string;
  tcpClients: number;
  encoding: Encoding;
  connectOptions: ConnectOptions;
  theme: ThemeMode;
  showFilter: boolean;
  showQuick: boolean;
  onConfigChange: (patch: Partial<SerialConfig>) => void;
  onConnectOptionsChange: (patch: Partial<ConnectOptions>) => void;
  onTransportChange: (transport: "serial" | "tcp") => void;
  onTcpPortChange: (port: number) => void;
  onTcpHostChange: (host: string) => void;
  onEncodingChange: (encoding: Encoding) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onToggleFilter: () => void;
  onToggleQuick: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}

export default function Toolbar({
  ports,
  config,
  connected,
  busy,
  transport,
  tcpPort,
  tcpHost,
  tcpClients,
  encoding,
  connectOptions,
  theme,
  showFilter,
  showQuick,
  onConfigChange,
  onConnectOptionsChange,
  onTransportChange,
  onTcpPortChange,
  onTcpHostChange,
  onEncodingChange,
  onThemeChange,
  onToggleFilter,
  onToggleQuick,
  onConnect,
  onDisconnect,
  onRefresh,
}: Props) {
  const lock = connected || busy;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  const connect = () => {
    setMoreOpen(false);
    if (connected) onDisconnect();
    else onConnect();
  };

  return (
    <div className="toolbar">
      <div className="group toolbar-primary">
        <div className="transport-switch" role="group" aria-label="连接方式">
          <button
            type="button"
            className={transport === "serial" ? "active" : ""}
            disabled={lock}
            onClick={() => onTransportChange("serial")}
          >
            串口
          </button>
          <button
            type="button"
            className={transport === "tcp" ? "active" : ""}
            disabled={lock}
            onClick={() => onTransportChange("tcp")}
          >
            TCP Server
          </button>
        </div>

        {transport === "serial" ? (
          <>
        <label className="field port-field">
          <span>端口</span>
          <select
            value={config.portName}
            onChange={(e) => onConfigChange({ portName: e.target.value })}
            disabled={lock}
          >
            {ports.length === 0 && <option value="">未发现串口</option>}
            {ports.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.product ? ` — ${p.product.replace(/\s*\(COM\d+\)\s*$/i, "")}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button className="icon-btn" title="刷新串口" onClick={onRefresh} disabled={busy}>
          ↻
        </button>

        <label className="field baud-field">
          <span>波特率</span>
          <input
            list="baud-rates"
            type="number"
            value={config.baudRate}
            disabled={lock}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) {
                onConfigChange({ baudRate: Math.floor(value) });
              }
            }}
          />
          <datalist id="baud-rates">
            {BAUD_RATES.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>

        <button
          className={`connect-btn ${connected ? "on" : ""}`}
          onClick={connect}
          disabled={busy || (!connected && !config.portName)}
        >
          {busy ? "处理中…" : connected ? "断开" : "连接"}
        </button>

        <div className="serial-more" ref={moreRef}>
          <button
            className={`more-btn ${moreOpen ? "active" : ""}`}
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
            title="更多串口设置：数据位、校验、停止位、流控、DTR/RTS"
          >
            更多设置
            <span className="more-caret">{moreOpen ? "▴" : "▾"}</span>
          </button>
          {moreOpen && (
            <div className="serial-popover" role="dialog" aria-label="更多串口设置">
              <div className="serial-popover-head">
                <strong>更多串口设置</strong>
                <button
                  className="link-btn"
                  onClick={() => setMoreOpen(false)}
                  title="关闭"
                >
                  ×
                </button>
              </div>
              <div className="serial-popover-grid">
                <label className="field">
                  <span>数据位</span>
                  <select
                    value={config.dataBits}
                    disabled={lock}
                    onChange={(e) => onConfigChange({ dataBits: Number(e.target.value) })}
                  >
                    {[5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>校验</span>
                  <select
                    value={config.parity}
                    disabled={lock}
                    onChange={(e) =>
                      onConfigChange({ parity: e.target.value as Parity })
                    }
                  >
                    <option value="none">无</option>
                    <option value="even">偶</option>
                    <option value="odd">奇</option>
                  </select>
                </label>

                <label className="field">
                  <span>停止位</span>
                  <select
                    value={config.stopBits}
                    disabled={lock}
                    onChange={(e) =>
                      onConfigChange({ stopBits: Number(e.target.value) })
                    }
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                </label>

                <label className="field">
                  <span>流控</span>
                  <select
                    value={config.flowControl}
                    disabled={lock}
                    onChange={(e) =>
                      onConfigChange({
                        flowControl: e.target.value as SerialConfig["flowControl"],
                      })
                    }
                  >
                    <option value="none">无</option>
                    <option value="software">XON/XOFF</option>
                    <option value="hardware">RTS/CTS</option>
                  </select>
                </label>
              </div>
              <div className="serial-popover-signals">
                <label className="check" title="数据终端就绪">
                  <input
                    type="checkbox"
                    checked={config.dtr}
                    disabled={lock}
                    onChange={(e) => onConfigChange({ dtr: e.target.checked })}
                  />
                  DTR
                </label>
                <label className="check" title="请求发送">
                  <input
                    type="checkbox"
                    checked={config.rts}
                    disabled={lock}
                    onChange={(e) => onConfigChange({ rts: e.target.checked })}
                  />
                  RTS
                </label>
              </div>
            </div>
          )}
        </div>

        <span className="toolbar-sep" />

        <label
          className="check"
          title="连接成功后自动发送一次下面的内容，并按发送框的“结尾”追加换行；部分 ASR USB 设备需要收到这个字符才开始输出日志"
        >
          <input
            type="checkbox"
            checked={connectOptions.wakeEnabled}
            onChange={(e) =>
              onConnectOptionsChange({ wakeEnabled: e.target.checked })
            }
          />
          连接后发送
        </label>
        <input
          className="wake-input"
          value={connectOptions.wakeText}
          disabled={!connectOptions.wakeEnabled}
          placeholder="如 2"
          title="支持 \r \n \t \xNN 转义"
          onChange={(e) => onConnectOptionsChange({ wakeText: e.target.value })}
        />
          </>
        ) : (
          <>
            <label className="field tcp-host-field">
              <span>本机IP</span>
              <input
                value={tcpHost}
                disabled={lock}
                placeholder="172.26.137.19"
                title="填写本机局域网 IP，TCP 客户端用它连接"
                onChange={(e) => onTcpHostChange(e.target.value)}
              />
            </label>
            <label className="field tcp-port-field">
              <span>监听端口</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={tcpPort}
                disabled={lock}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isInteger(value) && value > 0 && value < 65536) {
                    onTcpPortChange(value);
                  }
                }}
              />
            </label>
            <button
              className={`connect-btn ${connected ? "on" : ""}`}
              onClick={connect}
              disabled={busy || (!connected && !tcpHost.trim())}
            >
              {busy ? "处理中…" : connected ? "停止" : "启动"}
            </button>
            <span className="tcp-clients" title="当前 TCP 客户端连接">
              客户端 {tcpClients}
            </span>
            <span className="tcp-hint">单端口监听 · 异常断开自动等重连</span>
          </>
        )}
      </div>

      <div className="group toolbar-secondary">
        <label className="field encoding-field">
          <span>编码</span>
          <select
            value={encoding}
            onChange={(e) => onEncodingChange(e.target.value as Encoding)}
          >
            <option value="utf-8">UTF-8</option>
            <option value="gbk">GBK</option>
          </select>
        </label>

        <button
          className={`icon-btn ${showFilter ? "panel-on" : ""}`}
          title={showFilter ? "隐藏左侧过滤栏" : "显示左侧过滤栏"}
          onClick={onToggleFilter}
        >
          ◧
        </button>
        <button
          className={`icon-btn ${showQuick ? "panel-on" : ""}`}
          title={showQuick ? "隐藏右侧快捷指令" : "显示右侧快捷指令"}
          onClick={onToggleQuick}
        >
          ◨
        </button>

        <button
          className="icon-btn theme-toggle"
          title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
          aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "亮" : "暗"}
        </button>
      </div>
    </div>
  );
}
