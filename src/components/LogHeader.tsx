import type { PointerEvent as ReactPointerEvent } from "react";
import type { DisplayOptions } from "../types";

type ResizeKey = "timeWidth" | "tagWidth" | "funcWidth";

interface Props {
  options: DisplayOptions;
  onResize: (key: ResizeKey, width: number) => void;
}

const LIMITS: Record<ResizeKey, [number, number]> = {
  timeWidth: [70, 200],
  tagWidth: [40, 160],
  funcWidth: [120, 600],
};

export default function LogHeader({ options, onResize }: Props) {
  const fontSize = options.logFontSize || 13;
  const timeWidth = Math.max(options.timeWidth, Math.ceil(fontSize * 8.4));
  const dirWidth = Math.max(28, Math.ceil(fontSize * 2.4));
  const levelWidth = Math.max(24, Math.ceil(fontSize * 1.55));
  const lineWidth = Math.max(38, Math.ceil(fontSize * 2.6));

  const startResize = (key: ResizeKey, event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = options[key];
    document.body.classList.add("col-resizing");

    const move = (moveEvent: PointerEvent) => {
      const [min, max] = LIMITS[key];
      const next = Math.round(
        Math.min(max, Math.max(min, startWidth + moveEvent.clientX - startX)),
      );
      onResize(key, next);
    };
    const end = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const resizer = (key: ResizeKey) => (
    <span
      className="col-resizer"
      title="拖动调整列宽"
      onPointerDown={(event) => startResize(key, event)}
    />
  );

  return (
    <div className="log-header">
      {options.timestamp && (
        <span className="log-hcell" style={{ width: timeWidth }}>
          时间{resizer("timeWidth")}
        </span>
      )}
      {options.direction && (
        <span className="log-hcell" style={{ width: dirWidth }}>
          向
        </span>
      )}
      {options.elogMode && (
        <span className="log-hcell" style={{ width: levelWidth }}>
          级
        </span>
      )}
      {options.elogMode && (
        <span className="log-hcell" style={{ width: options.tagWidth }}>
          Tag{resizer("tagWidth")}
        </span>
      )}
      {options.elogMode && (
        <span className="log-hcell" style={{ width: options.funcWidth }}>
          函数{resizer("funcWidth")}
        </span>
      )}
      {options.elogMode && (
        <span className="log-hcell" style={{ width: lineWidth, textAlign: "right" }}>
          行
        </span>
      )}
      <span className="log-hcell grow">消息</span>
    </div>
  );
}
