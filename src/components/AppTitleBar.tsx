import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/serialBridge";

type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const appWindow = isTauri() ? getCurrentWindow() : null;

function run(action: "minimize" | "maximize" | "close") {
  if (!appWindow) return;
  if (action === "minimize") void appWindow.minimize();
  if (action === "maximize") void appWindow.toggleMaximize();
  if (action === "close") void appWindow.close();
}

export function WindowResizeHandles() {
  if (!appWindow) return null;
  const win = appWindow;
  const start = (direction: ResizeDirection) => (event: ReactPointerEvent) => {
    event.preventDefault();
    void win.startResizeDragging(direction);
  };

  return (
    <>
      <div className="resize-edge n" onPointerDown={start("North")} />
      <div className="resize-edge s" onPointerDown={start("South")} />
      <div className="resize-edge e" onPointerDown={start("East")} />
      <div className="resize-edge w" onPointerDown={start("West")} />
      <div className="resize-edge ne" onPointerDown={start("NorthEast")} />
      <div className="resize-edge nw" onPointerDown={start("NorthWest")} />
      <div className="resize-edge se" onPointerDown={start("SouthEast")} />
      <div className="resize-edge sw" onPointerDown={start("SouthWest")} />
    </>
  );
}

export default function AppTitleBar({
  onCheckUpdate,
  onDonate,
  updateAvailable = false,
  checking = false,
}: {
  onCheckUpdate?: () => void;
  onDonate?: () => void;
  updateAvailable?: boolean;
  checking?: boolean;
}) {
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !appWindow) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    void appWindow.startDragging();
  };

  return (
    <header
      className="app-titlebar"
      onPointerDown={startDrag}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        run("maximize");
      }}
    >
      <div className="app-brand">
        <span className="app-mark">EL</span>
        <span className="app-brand-name">EasyLog Serial</span>
        <span className="app-brand-sub">串口工作台</span>
        <span className="app-author">lyg · v0.4.2</span>
      </div>
      <span className="app-titlebar-spacer" />
      <button
        type="button"
        className={`titlebar-update ${updateAvailable ? "available" : ""}`}
        title="检查 GitHub Releases 上的新版本"
        disabled={checking}
        onClick={() => onCheckUpdate?.()}
      >
        {checking ? "检查中…" : updateAvailable ? "发现新版本" : "检查更新"}
      </button>
      <button
        type="button"
        className="titlebar-donate"
        title="赞赏作者"
        onClick={() => onDonate?.()}
      >
        赞赏作者
      </button>
      <div className="window-controls">
        <button
          type="button"
          title="最小化"
          onClick={() => run("minimize")}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          ─
        </button>
        <button
          type="button"
          title="最大化 / 还原"
          onClick={() => run("maximize")}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          □
        </button>
        <button
          type="button"
          className="close"
          title="关闭"
          onClick={() => run("close")}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          ×
        </button>
      </div>
    </header>
  );
}
