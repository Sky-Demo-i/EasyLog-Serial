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
  tick: string;
  message: string;
  parsed: boolean;
}

function splitTick(value: string): { tick: string; message: string } {
  const match = /^\s*\[([^\]]+)\]\s*/.exec(value);
  if (!match) return { tick: "", message: value };
  return {
    tick: match[1].trim(),
    message: value.slice(match[0].length).trimStart(),
  };
}

export function parseElogLine(text: string): ElogFields {
  // Most EasyLog output has no ANSI left after ingest; skip both regex passes.
  const hasAnsi = text.includes("\x1b");
  const source = hasAnsi ? text.replace(/^(?:\x1b\[[0-9;]*m)+/, "") : text;
  const cleanMessage = hasAnsi
    ? (value: string) => value.replace(/(?:\x1b\[[0-9;]*m)+$/, "")
    : (value: string) => value;

  let match = FULL_RE.exec(source);
  if (match) {
    const body = splitTick(cleanMessage(match[5]));
    return {
      level: match[1] as LogLevel,
      tag: match[2].trim(),
      lineNo: Number(match[3]),
      func: match[4],
      tick: body.tick,
      message: body.message,
      parsed: true,
    };
  }

  match = TAG_ONLY_RE.exec(source);
  if (match) {
    const body = splitTick(cleanMessage(match[3]));
    return {
      level: match[1] as LogLevel,
      tag: match[2].trim(),
      lineNo: 0,
      func: "",
      tick: body.tick,
      message: body.message,
      parsed: true,
    };
  }

  match = LEVEL_ONLY_RE.exec(source);
  if (match) {
    const body = splitTick(cleanMessage(match[2]));
    return {
      level: match[1] as LogLevel,
      tag: "",
      lineNo: 0,
      func: "",
      tick: body.tick,
      message: body.message,
      parsed: true,
    };
  }

  return {
    level: "?",
    tag: "",
    lineNo: 0,
    func: "",
    tick: "",
    message: text,
    parsed: false,
  };
}

/** Build a new log entry. Only RX text is parsed; TX/HEX lines stay raw. */
export function makeEntry(
  ts: number,
  dir: LineDir,
  text: string,
  parse = true,
): Omit<LogEntry, "id"> {
  if (dir !== "rx" || !parse) {
    return {
      ts,
      dir,
      level: "?",
      tag: "",
      lineNo: 0,
      func: "",
      tick: "",
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
    tick: fields.tick,
    message: fields.message,
    text,
    parsed: fields.parsed,
  };
}
