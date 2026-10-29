import type { PointerEvent as ReactPointerEvent } from "react";
import type { AppendMode } from "../types";
import { buildPayload } from "../lib/format";

interface Props {
  value: string;
  onChange: (value: string) => void;
  hex: boolean;
  onHexChange: (value: boolean) => void;
  append: AppendMode;
  onAppendChange: (value: AppendMode) => void;
  autoSend: boolean;
  onAutoSendChange: (value: boolean) => void;
  autoInterval: number;
  onAutoIntervalChange: (value: number) => void;
  connected: boolean;
  onSend: () => void;
  atPrefix: boolean;
  onAtPrefixChange: (value: boolean) => void;
  height: number;
  onHeightChange: (height: number) => void;
}

export default function SendPane({
  value,
  onChange,
  hex,
  onHexChange,
  append,
  onAppendChange,
  autoSend,
  onAutoSendChange,
  autoInterval,
  onAutoIntervalChange,
  connected,
  onSend,
  atPrefix,
  onAtPrefixChange,
  height,
  onHeightChange,
}: Props) {
  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    document.body.classList.add("row-resizing");

    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(
        Math.min(440, Math.max(110, startHeight - (moveEvent.clientY - startY))),
      );
      onHeightChange(next);
    };
    const end = () => {
      document.body.classList.remove("row-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  let preview = 0;
  try {
    const source =
      atPrefix && !hex
        ? value.startsWith("AT^GT_CM=")
          ? value
          : `AT^GT_CM=${value}`
        : value;
    preview = source.length === 0 ? 0 : buildPayload(source, hex, append).length;
  } catch {
    preview = -1;
  }

  return (
    <div className="send-pane" style={{ height }}>
      <div
        className="h-resizer"
        title="拖动调整发送区高度"
        onPointerDown={startResize}
      />
      <div className="send-main">
        <textarea
          value={value}
          spellCheck={false}
          placeholder={hex ? "HEX 发送，例如：01 03 00 00 00 01 84 0A" : "输入要发送的文本，Ctrl+Enter 发送"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="send-actions">
          <button
            className="primary send-btn"
            onClick={onSend}
            disabled={!connected || value.length === 0}
            title="发送（Ctrl+Enter）"
          >
            发 送
          </button>
        </div>
      </div>

      <div className="send-options">
        <label className="check">
          <input type="checkbox" checked={hex} onChange={(e) => onHexChange(e.target.checked)} />
          HEX 发送
        </label>

        <label
          className="check"
          title="发送文本时自动在内容前加 AT^GT_CM=；内容已带该前缀时不会重复"
        >
          <input
            type="checkbox"
            checked={atPrefix}
            disabled={hex}
            onChange={(e) => onAtPrefixChange(e.target.checked)}
          />
          AT^GT_CM=
        </label>

        <label className="field inline">
          <span>结尾</span>
          <select value={append} onChange={(e) => onAppendChange(e.target.value as AppendMode)}>
            <option value="none">无</option>
            <option value="cr">CR (\r)</option>
            <option value="lf">LF (\n)</option>
            <option value="crlf">CRLF (\r\n)</option>
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={autoSend}
            onChange={(e) => onAutoSendChange(e.target.checked)}
          />
          定时发送
        </label>

        <label className="field inline">
          <span>间隔</span>
          <input
            type="number"
            min={20}
            step={50}
            value={autoInterval}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value >= 20) onAutoIntervalChange(Math.floor(value));
            }}
          />
          <span className="unit">ms</span>
        </label>

        <span className={`byte-preview ${preview < 0 ? "invalid" : ""}`}>
          {preview < 0 ? "HEX 格式有误" : `${preview} 字节`}
        </span>
      </div>
    </div>
  );
}
