export type Parity = "none" | "even" | "odd" | "mark" | "space";
export type FlowControl = "none" | "software" | "hardware";
export type AppendMode = "none" | "cr" | "lf" | "crlf";
/** "global" = follow the send box's 结尾 setting at send time. */
export type CommandAppend = AppendMode | "global";
export type Encoding = "utf-8" | "gbk";
export type LineDir = "rx" | "tx" | "sys";
export type LogLevel = "A" | "E" | "W" | "I" | "D" | "V" | "?";

export interface PortInfo {
  name: string;
  kind: string;
  vid?: number;
  pid?: number;
  product?: string;
  serialNumber?: string;
  manufacturer?: string;
}

export interface SerialConfig {
  portName: string;
  baudRate: number;
  dataBits: number;
  parity: Parity;
  stopBits: number;
  flowControl: FlowControl;
  dtr: boolean;
  rts: boolean;
}

/** Connection-time options that are not sent to the Rust backend. */
export interface ConnectOptions {
  /** Send wakeText once after the port opens (ASR USB needs this to start logging). */
  wakeEnabled: boolean;
  /** Plain text; supports \\r \\n \\xNN escapes. */
  wakeText: string;
}

export interface QuickCommand {
  id: string;
  name: string;
  data: string;
  hex: boolean;
  append: CommandAppend;
  enabled: boolean;
  /** Drawer/category name. Missing means 未分类. */
  category?: string;
  /** Per-command gap used by sequential/loop sending, in ms. */
  delayMs?: number;
  /** Loop send order. 0 means excluded from loop sending. */
  order?: number;
}

export interface LogEntry {
  id: number;
  ts: number;
  dir: LineDir;
  level: LogLevel;
  tag: string;
  lineNo: number;
  func: string;
  /** First [key=value] bracket after the EasyLogger function (device tick). */
  tick?: string;
  /** ANSI-stripped message (what the table shows). */
  message: string;
  /** Original line, used for copy/save/search. */
  text: string;
  parsed: boolean;
}

export interface LogFilter {
  levels: Set<LogLevel>;
  tags: Set<string>;
  keyword: string;
  regex: boolean;
  invert: boolean;
}

export interface LogCounts {
  levels: Record<LogLevel, number>;
  tags: Array<{ tag: string; count: number }>;
  total: number;
}

export type ThemeMode = "dark" | "light";

export interface DisplayOptions {
  timestamp: boolean;
  direction: boolean;
  hex: boolean;
  encoding: Encoding;
  autoScroll: boolean;
  showTx: boolean;
  ansiRaw: boolean;
  elogMode: boolean;
  autoSave: boolean;
  autoSaveMaxMb: number;
  theme: ThemeMode;
  showFilter: boolean;
  showQuick: boolean;
  logFontSize: number;
  timeWidth: number;
  tagWidth: number;
  funcWidth: number;
  dirWidth: number;
  levelWidth: number;
  lineWidth: number;
  tickWidth: number;
  filterWidth: number;
  quickWidth: number;
  sendHeight: number;
}

export interface SerialDataPayload {
  ts: number;
  data: string;
  rxTotal: number;
}

export interface AutoSaveInfo {
  enabled: boolean;
  dir: string;
  bytes: number;
  files: number;
  maxBytes: number;
}

export interface KeywordColorRule {
  id: string;
  keyword: string;
  color: string;
}

export interface SerialStatePayload {
  connected: boolean;
  message: string;
}
