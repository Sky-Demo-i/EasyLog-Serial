import type { LineDir, LogEntry, LogLevel } from "../types";

export const LEVELS: LogLevel[] = ["A", "E", "W", "I", "D", "V"];

export const LEVEL_LABEL: Record<LogLevel, string> = {
  A: "断言",
  E: "错误",
  W: "警告",
  I: "信息",
  D: "调试",
  V: "详细",
  "?": "原始",
};

// EasyLogger default: LEVEL/TAG<padding>(line func)message
const FULL_RE = /^([AEWIDV])\/([A-Za-z0-9_.-]+)\s*\((\d+)\s+([A-Za-z_][A-Za-z0-9_]*)\)(.*)$/;

// elog_set_fmt() with line/func disabled
const TAG_ONLY_RE = /^([AEWIDV])\/([A-Za-z0-9_.-]+)\s+(.*)$/;

// tag disabled as well
const LEVEL_ONLY_RE = /^([AEWIDV])\/\s*(.*)$/;

export interface ElogFields {
  level: LogLevel;
  tag: string;
  lineNo: number;
  func: string;
  message: string;
  parsed: boolean;
}

export function parseElogLine(text: string): ElogFields {
  // In "原始ANSI" mode the line starts with ESC[..m and ends with ESC[0m.
  // Parse metadata from the clean start, but keep the message body (without
  // the boundary reset) so function/tag columns are still filled.
  const source = text.replace(/^(?:\x1b\[[0-9;]*m)+/, "");
  const cleanMessage = (value: string) => value.replace(/(?:\x1b\[[0-9;]*m)+$/, "");

  let match = FULL_RE.exec(source);
  if (match) {
    return {
      level: match[1] as LogLevel,
      tag: match[2].trim(),
      lineNo: Number(match[3]),
      func: match[4],
      message: cleanMessage(match[5]),
      parsed: true,
    };
  }

  match = TAG_ONLY_RE.exec(source);
  if (match) {
    return {
      level: match[1] as LogLevel,
      tag: match[2].trim(),
      lineNo: 0,
      func: "",
      message: cleanMessage(match[3]),
      parsed: true,
    };
  }

  match = LEVEL_ONLY_RE.exec(source);
  if (match) {
    return {
      level: match[1] as LogLevel,
      tag: "",
      lineNo: 0,
      func: "",
      message: cleanMessage(match[2]),
      parsed: true,
    };
  }

  return {
    level: "?",
    tag: "",
    lineNo: 0,
    func: "",
    message: text,
    parsed: false,
  };
}

/** Build a new log entry. Only RX text is parsed; TX/HEX lines stay raw. */
export function makeEntry(ts: number, dir: LineDir, text: string): Omit<LogEntry, "id"> {
  if (dir !== "rx") {
    return {
      ts,
      dir,
      level: "?",
      tag: "",
      lineNo: 0,
      func: "",
      message: text,
      text,
      parsed: false,
    };
  }
  const fields = parseElogLine(text);
  return {
    ts,
    dir,
    level: fields.level,
    tag: fields.tag,
    lineNo: fields.lineNo,
    func: fields.func,
    message: fields.message,
    text,
    parsed: fields.parsed,
  };
}
