import { useEffect, useState } from "react";
import type { UpdateInfo, UpdateProgress } from "../types";
import * as bridge from "../lib/serialBridge";

interface Props {
  info: UpdateInfo;
  onClose: () => void;
}

type Phase = "idle" | "downloading" | "installing" | "error";

function formatSize(bytes: number): string {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UpdateDialog({ info, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress>({
    downloaded: 0,
    total: info.size,
  });
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    void bridge.onUpdateProgress((payload) => {
      if (!disposed) setProgress(payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const install = async () => {
    setError("");
    setPhase("downloading");
    try {
      const path = await bridge.downloadUpdate(
        info.url,
        info.sha256,
        info.version,
      );
      setPhase("installing");
      await bridge.installUpdate(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("error");
    }
  };

  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;
  const busy = phase === "downloading" || phase === "installing";

  return (
    <div
      className="update-backdrop"
      onPointerDown={() => {
        if (!busy && !info.mandatory) onClose();
      }}
    >
      <div className="update-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="update-title">
          发现新版本 <strong>v{info.version}</strong>
          {info.mandatory && <span className="update-mandatory">必须更新</span>}
        </div>
        <div className="update-meta">
          当前 v{info.currentVersion}
          {info.pubDate ? ` · ${info.pubDate}` : ""}
          {info.size ? ` · ${formatSize(info.size)}` : ""}
        </div>
        <div className="update-notes">
          {info.notes || "本次更新没有附加说明。"}
        </div>
        <div className="update-tip">
          安装时本工具会自动退出，替换文件后重新启动。日志目录不会删除。
        </div>

        {busy && (
          <div className="update-progress">
            <div className="update-progress-bar">
              <span style={{ width: `${percent}%` }} />
            </div>
            <span>
              {phase === "downloading"
                ? `正在下载 ${percent}%`
                : "正在启动更新器…"}
            </span>
          </div>
        )}
        {error && <div className="update-error">{error}</div>}

        <div className="update-actions">
          <button
            type="button"
            className="update-secondary"
            disabled={busy || info.mandatory}
            onClick={onClose}
          >
            以后再说
          </button>
          <button
            type="button"
            className="update-primary"
            disabled={busy}
            onClick={() => void install()}
          >
            {phase === "error" ? "重试下载并安装" : "下载并安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
