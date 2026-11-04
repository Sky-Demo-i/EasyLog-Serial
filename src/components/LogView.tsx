import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DisplayOptions, KeywordColorRule, LogEntry } from "../types";
import { formatTime } from "../lib/format";
import { makeEntry } from "../lib/elog";

const HEADER_HEIGHT = 30;

let measureContext: CanvasRenderingContext2D | null = null;

function measurePx(text: string, fontSize: number): number {
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return text.length * (fontSize * 0.62);
  measureContext.font = `500 ${fontSize}px "Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace`;
  return measureContext.measureText(text).width;
}

interface Props {
  lines: LogEntry[];
  partial: string;
  options: DisplayOptions;
  paused: boolean;
  header: ReactNode;
  colorRules: KeywordColorRule[];
  searchTerm: string;
  searchCaseSensitive: boolean;
  activeMatchRow: number | null;
  scrollToken: number;
  selectAll: boolean;
  onAutoScrollChange: (value: boolean) => void;
}

export function highlightText(text: string, search: string, caseSensitive: boolean): ReactNode {
  const needle = search.trim();
  if (!needle || !text) return text;
  const lower = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(target, cursor);

  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={`${index}-${cursor}`}>{text.slice(index, index + needle.length)}</mark>,
    );
    cursor = index + needle.length;
    index = lower.indexOf(target, cursor);
  }

  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function keywordColor(entry: LogEntry, rules: KeywordColorRule[]): string | null {
  const text = `${entry.message}\n${entry.func}\n${entry.tag}`.toLowerCase();
  for (const rule of rules) {
    const keyword = rule.keyword.trim().toLowerCase();
    if (keyword && text.includes(keyword)) return rule.color;
  }
  return null;
}

function levelClass(entry: LogEntry, elogMode: boolean): string {
  if (!elogMode) return "level-raw";
  if (entry.dir === "tx") return "level-tx";
  if (!entry.parsed) return "level-raw";
  return `level-${entry.level}`;
}

export default function LogView({
  lines,
  partial,
  options,
  paused,
  header,
  colorRules,
  searchTerm,
  searchCaseSensitive,
  activeMatchRow,
  scrollToken,
  selectAll,
  onAutoScrollChange,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  // Keep the DOM stable while the user is selecting. Live batching replaces
  // virtual rows and drops the browser selection otherwise.
  const [frozen, setFrozen] = useState<{
    lines: LogEntry[];
    partial: string;
  } | null>(null);
  const displayLines = frozen ? frozen.lines : lines;
  const displayPartial = frozen ? frozen.partial : partial;
  const fontSize = options.logFontSize || 13;
  const rowHeight = Math.max(26, Math.round(fontSize * 2.2));
  const timeWidth = Math.max(options.timeWidth, Math.ceil(fontSize * 8.4));
  const dirWidth = Math.max(options.dirWidth ?? 36, Math.ceil(fontSize * 2.7));
  const levelWidth = Math.max(options.levelWidth ?? 32, Math.ceil(fontSize * 2.4));
  const lineWidth = Math.max(options.lineWidth ?? 44, Math.ceil(fontSize * 2.9));
  const tickWidth = Math.max(options.tickWidth ?? 88, Math.ceil(fontSize * 6));
  const showMeta = options.elogMode && !options.hex;

  const contentWidth = useMemo(() => {
    // Measuring every historical line on each batch is the main render cost at
    // high log rates. The newest window is enough for horizontal scroll sizing.
    const sample =
      displayLines.length > 600 ? displayLines.slice(-600) : displayLines;
    let longest = "";
    for (const entry of sample) {
      const display = options.elogMode ? entry.message : entry.text;
      if (display.length > longest.length) longest = display;
    }
    if (displayPartial.length > longest.length) longest = displayPartial;

    const gap = 7;
    const pad = 20;
    let fixed = pad;
    if (options.timestamp) fixed += timeWidth + gap;
    if (options.direction) fixed += dirWidth + gap;
    if (showMeta) {
      fixed +=
        levelWidth +
        gap +
        options.tagWidth +
        gap +
        options.funcWidth +
        gap +
        lineWidth +
        gap +
        tickWidth +
        gap;
    }
    const messageWidth = Math.max(260, Math.ceil(measurePx(longest, fontSize)) + 16);
    return Math.min(30000, Math.max(560, fixed + messageWidth + pad));
  }, [
    displayLines,
    displayPartial,
    fontSize,
    timeWidth,
    dirWidth,
    levelWidth,
    lineWidth,
    tickWidth,
    options.timestamp,
    options.direction,
    showMeta,
    options.tagWidth,
    options.funcWidth,
  ]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lastTs = displayLines.length
    ? displayLines[displayLines.length - 1].ts
    : Date.now();
  let partialEntry: LogEntry | null = null;
  if (displayPartial) {
    const base = makeEntry(lastTs, "rx", displayPartial, options.elogMode);
    partialEntry = { ...base, id: -1, message: `${base.message}▍` };
  }

  const total = displayLines.length + (partialEntry ? 1 : 0);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || !options.autoScroll || frozen) return;
    el.scrollTop = el.scrollHeight;
  }, [displayLines.length, displayPartial, options.autoScroll, frozen, height, rowHeight]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || activeMatchRow === null) return;
    el.scrollTop = Math.max(
      0,
      HEADER_HEIGHT + activeMatchRow * rowHeight - el.clientHeight / 2,
    );
  }, [scrollToken, activeMatchRow, rowHeight]);

  useEffect(() => {
    if (!frozen) return;
    const leave = (event: PointerEvent) => {
      if (viewportRef.current?.contains(event.target as Node)) return;
      setFrozen(null);
      window.getSelection()?.removeAllRanges();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFrozen(null);
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("pointerdown", leave, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", leave, true);
      document.removeEventListener("keydown", escape);
    };
  }, [frozen]);

  const visibleCount = Math.max(1, Math.ceil((height || 600) / rowHeight));
  const effectiveScrollTop = Math.max(0, scrollTop - HEADER_HEIGHT);
  // When following the tail, render the newest rows immediately instead of
  // waiting for the programmatic scroll event to update scrollTop. Otherwise a
  // batch can paint from the old position and then jump to the bottom.
  const following = options.autoScroll && !frozen;
  const start = following
    ? Math.max(0, total - visibleCount - 2)
    : Math.max(0, Math.floor(effectiveScrollTop / rowHeight) - 8);
  const end = Math.min(total, start + visibleCount + 16);

  const rows = [];
  for (let index = start; index < end; index++) {
    const isPartial = index >= displayLines.length;
    const entry = isPartial ? partialEntry! : displayLines[index];
    const displayText = showMeta ? entry.message : entry.text;
    const customColor = keywordColor(entry, colorRules);
    const dim =
      showMeta && !customColor && entry.parsed && (entry.level === "V" || entry.level === "D");
    const rowStyle: CSSProperties = {
      top: index * rowHeight,
      height: rowHeight,
      lineHeight: `${rowHeight}px`,
    };
    if (customColor) {
      (rowStyle as Record<string, string | number>)["--row-color"] = customColor;
    }

    rows.push(
      <div
        key={isPartial ? "partial" : entry.id}
        className={`log-row ${entry.dir} ${levelClass(entry, showMeta)} ${dim ? "dim" : ""} ${
          customColor ? "keyword-colored" : ""
        } ${activeMatchRow === index ? "search-active" : ""}`}
        style={rowStyle}
        title={entry.text}
      >
        {options.timestamp && (
          <span className="col-time" style={{ width: timeWidth }}>
            [{formatTime(entry.ts)}]
          </span>
        )}
        {options.direction && (
          <span className={`col-dir ${entry.dir}`} style={{ width: dirWidth }}>
            {entry.dir === "rx" ? "收←" : entry.dir === "tx" ? "发→" : "·"}
          </span>
        )}
        {showMeta && (
          <span
            className={`col-lvl row-lvl-${
              entry.dir === "tx" ? "tx" : entry.parsed ? entry.level.toLowerCase() : "raw"
            }`}
            style={{ width: levelWidth }}
          >
            {entry.dir === "tx" ? "TX" : entry.parsed ? entry.level : ""}
          </span>
        )}
        {showMeta && (
          <span className="col-tag" style={{ width: options.tagWidth }}>
            {highlightText(entry.tag, searchTerm, searchCaseSensitive)}
          </span>
        )}
        {showMeta && (
          <span
            className="col-func"
            style={{ width: options.funcWidth }}
            title={entry.func ? `${entry.func}:${entry.lineNo}` : ""}
          >
            {highlightText(entry.parsed ? entry.func : "", searchTerm, searchCaseSensitive)}
          </span>
        )}
        {showMeta && (
          <span className="col-line" style={{ width: lineWidth }}>
            {entry.parsed && entry.lineNo ? entry.lineNo : ""}
          </span>
        )}
        {showMeta && (
          <span
            className="col-tick"
            style={{ width: tickWidth }}
            title={entry.tick ? `设备 tick: ${entry.tick}` : ""}
          >
            {highlightText(entry.tick ?? "", searchTerm, searchCaseSensitive)}
          </span>
        )}
        <span className="col-msg">
          {highlightText(displayText, searchTerm, searchCaseSensitive)}
        </span>
      </div>,
    );
  }

  return (
    <div className="log-view-shell">
      <div
        className={`log-viewport ${selectAll ? "log-select-all" : ""}`}
        ref={viewportRef}
        tabIndex={0}
        style={{ fontSize }}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          if (!frozen) {
            setFrozen({ lines: lines.slice(), partial });
          }
        }}
        onWheel={(event) => {
          if (event.deltaY < 0 && options.autoScroll && !frozen) {
            onAutoScrollChange(false);
          }
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          setScrollTop(el.scrollTop);
          if (frozen) return;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distance > 48 && options.autoScroll) {
            onAutoScrollChange(false);
          } else if (distance <= 2 && !options.autoScroll) {
            onAutoScrollChange(true);
          }
        }}
      >
        <div className="log-content" style={{ width: contentWidth }}>
          <div className="log-header-wrap">{header}</div>
          {total === 0 ? (
            <div className="log-empty">
              {paused ? "已暂停" : "等待数据… 连接串口后，接收内容会显示在这里"}
            </div>
          ) : (
            <div className="log-spacer" style={{ height: total * rowHeight }}>
              {rows}
            </div>
          )}
        </div>
      </div>
      {frozen && (
        <button
          type="button"
          className="log-resume-follow"
          title="恢复自动跟随（点击日志外部也可以恢复）"
          onClick={() => {
            setFrozen(null);
            window.getSelection()?.removeAllRanges();
            onAutoScrollChange(true);
          }}
        >
          继续跟随
        </button>
      )}
    </div>
  );
}
