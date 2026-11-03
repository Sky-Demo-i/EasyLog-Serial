import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Toolbar from "./components/Toolbar";
import AppTitleBar, { WindowResizeHandles } from "./components/AppTitleBar";
import UpdateDialog from "./components/UpdateDialog";
import LogView, { highlightText } from "./components/LogView";
import LogHeader from "./components/LogHeader";
import SendPane from "./components/SendPane";
import QuickCommands from "./components/QuickCommands";
import FilterPanel from "./components/FilterPanel";
import StatusBar from "./components/StatusBar";
import type {
  AppendMode,
  AutoSaveInfo,
  ConnectOptions,
  DisplayOptions,
  Encoding,
  KeywordColorRule,
  LogFilter,
  PortInfo,
  QuickCommand,
  SerialConfig,
  SerialDataPayload,
  UpdateInfo,
} from "./types";
import {
  base64ToBytes,
  buildPayload,
  bytesToBase64,
  escapeForDisplay,
  formatHexFrame,
  formatTime,
  lineEnding,
  parseEscapes,
  stripAnsi,
} from "./lib/format";
import {
  mergeCommands,
  migrateCommandAppend,
  parseCommandText,
  resolveAppend,
  serializeCommands,
} from "./lib/commands";
import { makeEntry } from "./lib/elog";
import { applyFilter, createFilter, isFilterActive } from "./lib/filter";
import { LineStore } from "./lib/lineStore";
import { findReconnectPort, nextPortSelection } from "./lib/ports";
import { parseSession, type SessionChunk } from "./lib/session";
import * as bridge from "./lib/serialBridge";

const CONFIG_KEY = "easylog.config.v1";
const OPTS_KEY = "easylog.display.v1";
const CMDS_KEY = "easylog.commands.v1";
const CONNECT_KEY = "easylog.connect.v1";
const KEYWORD_COLORS_KEY = "easylog.keywordColors.v1";
const CATEGORIES_KEY = "easylog.categories.v1";
const CATEGORY_ORDER_KEY = "easylog.categoryOrder.v1";

const EXAMPLE_COMMANDS: QuickCommand[] = [
  {
    id: "example-csq",
    name: "查询信号",
    data: "AT+CSQ",
    hex: false,
    append: "global",
    enabled: true,
    category: "示例",
    delayMs: 100,
  },
  {
    id: "example-version",
    name: "查询版本",
    data: "AT+CGMR",
    hex: false,
    append: "global",
    enabled: true,
    category: "示例",
    delayMs: 100,
  },
  {
    id: "example-log-on",
    name: "打开日志",
    data: "AT^GT_CM=LOG,255",
    hex: false,
    append: "global",
    enabled: true,
    category: "示例",
    delayMs: 100,
  },
  {
    id: "example-log-off",
    name: "关闭日志",
    data: "AT^GT_CM=LOG,0",
    hex: false,
    append: "global",
    enabled: true,
    category: "示例",
    delayMs: 100,
  },
];

const DEFAULT_CONFIG: SerialConfig = {
  portName: "",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
  dtr: true,
  rts: true,
};

const DEFAULT_OPTIONS: DisplayOptions = {
  timestamp: true,
  direction: true,
  hex: false,
  encoding: "utf-8",
  autoScroll: true,
  showTx: true,
  ansiRaw: false,
  elogMode: true,
  autoSave: true,
  autoSaveMaxMb: 10,
  theme: "light",
  showFilter: true,
  showQuick: true,
  logFontSize: 13,
  hexFrameGapMs: 30,
  timeWidth: 112,
  tagWidth: 48,
  funcWidth: 240,
  dirWidth: 36,
  levelWidth: 32,
  lineWidth: 44,
  tickWidth: 88,
  filterWidth: 220,
  quickWidth: 640,
  sendHeight: 172,
};

const DEFAULT_CONNECT: ConnectOptions = {
  wakeEnabled: false,
  wakeText: "2",
};

function loadConfig(): SerialConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function loadOptions(): DisplayOptions {
  try {
    const raw = localStorage.getItem(OPTS_KEY);
    const merged = raw
      ? { ...DEFAULT_OPTIONS, ...JSON.parse(raw) }
      : { ...DEFAULT_OPTIONS };
    // EasyLog and 原始 are mutually exclusive. EasyLog parses/cleans ANSI;
    // 原始 keeps the stream untouched.
    merged.ansiRaw = !merged.elogMode;
    if (merged.quickWidth < 620) merged.quickWidth = 640;
    const gap = Number(merged.hexFrameGapMs);
    merged.hexFrameGapMs = Number.isFinite(gap)
      ? Math.min(2000, Math.max(5, Math.round(gap)))
      : 30;
    if (localStorage.getItem("easylog.transport.v1") === "tcp") {
      merged.timestamp = false;
    }
    return merged;
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

function loadConnectOptions(): ConnectOptions {
  try {
    const raw = localStorage.getItem(CONNECT_KEY);
    return raw ? { ...DEFAULT_CONNECT, ...JSON.parse(raw) } : { ...DEFAULT_CONNECT };
  } catch {
    return { ...DEFAULT_CONNECT };
  }
}

function loadKeywordRules(): KeywordColorRule[] {
  try {
    const raw = localStorage.getItem(KEYWORD_COLORS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.keyword === "string" &&
          typeof item.color === "string" &&
          /^#[0-9a-fA-F]{6}$/.test(item.color),
      )
      .map((item) => ({
        id:
          typeof item.id === "string"
            ? item.id
            : `kw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        keyword: item.keyword,
        color: item.color,
      }));
  } catch {
    return [];
  }
}

function loadCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(CMDS_KEY);
    if (!raw) return EXAMPLE_COMMANDS.map((command) => ({ ...command }));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Collapse duplicates from repeated imports (keep the newest entry per name).
    const byName = new Map<string, QuickCommand>();
    for (const item of parsed) {
      const migrated = migrateCommandAppend(item as QuickCommand);
      // Fix SSCOM's 0x02 comma escape in commands imported by older versions.
      const data = migrated.data.includes("\x02")
        ? migrated.data.replace(/\x02/g, ",")
        : migrated.data;
      const command = {
        ...migrated,
        data,
        category: migrated.category || "未分类",
      };
      byName.set(command.name || command.data, command);
    }
    return Array.from(byName.values());
  } catch {
    return [];
  }
}

function loadCategories(): string[] {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const names = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const name = item.trim();
      if (name) names.add(name);
    }
    return Array.from(names);
  } catch {
    return [];
  }
}

function loadCategoryOrder(): string[] {
  try {
    const raw = localStorage.getItem(CATEGORY_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type EditableText = HTMLInputElement | HTMLTextAreaElement;

interface TextMenuState {
  kind: "text" | "log";
  x: number;
  y: number;
  target?: EditableText;
  selected: string;
}

const MENU_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
]);

function isEditableText(element: Element | null): element is EditableText {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return MENU_INPUT_TYPES.has(element.type);
}

function selectedTextOf(target: EditableText): string {
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  return end > start ? target.value.slice(start, end) : "";
}

function setNativeText(target: EditableText, value: string): void {
  const proto =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

const AT_CMD_PREFIX = "AT^GT_CM=";

function withAtPrefix(text: string): string {
  if (!text || text.startsWith(AT_CMD_PREFIX)) return text;
  return `${AT_CMD_PREFIX}${text}`;
}

export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [config, setConfig] = useState<SerialConfig>(loadConfig);
  const [connectOptions, setConnectOptions] = useState<ConnectOptions>(loadConnectOptions);
  const [options, setOptions] = useState<DisplayOptions>(loadOptions);
  const [commands, setCommands] = useState<QuickCommand[]>(loadCommands);
  const [quickCategories, setQuickCategories] =
    useState<string[]>(loadCategories);
  const [categoryOrder, setCategoryOrder] =
    useState<string[]>(loadCategoryOrder);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waitingReconnect, setWaitingReconnect] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [status, setStatus] = useState("就绪");
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ rx: 0, tx: 0 });
  const [rate, setRate] = useState(0);

  const [sendText, setSendText] = useState("");
  const [sendHex, setSendHex] = useState(false);
  const [atPrefix, setAtPrefix] = useState(true);
  const [append, setAppend] = useState<AppendMode>("crlf");
  const [autoSend, setAutoSend] = useState(false);
  const [autoInterval, setAutoInterval] = useState(1000);
  const [filter, setFilter] = useState<LogFilter>(createFilter);
  const [recording, setRecording] = useState(false);
  const [recordPath, setRecordPath] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [replayName, setReplayName] = useState("");
  const [replaySpeed, setReplaySpeed] = useState(10);
  const [autoSaveInfo, setAutoSaveInfo] = useState<AutoSaveInfo | null>(null);
  const [keywordRules, setKeywordRules] =
    useState<KeywordColorRule[]>(loadKeywordRules);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(true);
  const [activeMatch, setActiveMatch] = useState(0);
  const [searchToken, setSearchToken] = useState(0);
  const [textMenu, setTextMenu] = useState<TextMenuState | null>(null);
  const [logSelectAll, setLogSelectAll] = useState(false);
  const [looping, setLooping] = useState(false);
  const [filterToast, setFilterToast] = useState(false);

  const [transport, setTransport] = useState<"serial" | "tcp">(() =>
    localStorage.getItem("easylog.transport.v1") === "tcp" ? "tcp" : "serial",
  );
  const [tcpPort, setTcpPort] = useState(() => {
    const saved = Number(localStorage.getItem("easylog.tcpPort.v1"));
    return Number.isInteger(saved) && saved > 0 && saved < 65536 ? saved : 9000;
  });
  const [tcpHost, setTcpHost] = useState(
    () => localStorage.getItem("easylog.tcpHost.v1") || "",
  );
  const [tcpClients, setTcpClients] = useState<string[]>([]);

  const [version, bump] = useReducer((x: number) => x + 1, 0);

  const storeRef = useRef(new LineStore());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeResultRef = useRef<HTMLButtonElement>(null);
  const partialRef = useRef("");
  const decoderRef = useRef<TextDecoder>(new TextDecoder("utf-8"));
  const textBufRef = useRef("");
  const partialTimerRef = useRef<number | null>(null);
  const ansiCarryRef = useRef("");
  const renderTimerRef = useRef<number | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const replayCancelledRef = useRef(false);
  const replayInputRef = useRef<HTMLInputElement>(null);

  const optionsRef = useRef(options);
  const connectOptionsRef = useRef(connectOptions);
  const filterRef = useRef(filter);
  const lastFilterWarnRef = useRef(0);
  const pausedRef = useRef(paused);
  const connectedRef = useRef(connected);
  const logSelectAllRef = useRef(logSelectAll);
  const checkingUpdateRef = useRef(false);
  const loopRef = useRef(false);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const configRef = useRef(config);
  configRef.current = config;
  const manualDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectingRef = useRef(false);
  const connectedPortRef = useRef<PortInfo | null>(null);
  const serialWasConnectedRef = useRef(false);
  const transportRef = useRef(transport);
  const tcpPortRef = useRef(tcpPort);
  const serialTimestampRef = useRef(options.timestamp);
  const statsRef = useRef(stats);
  const sendParamsRef = useRef({ text: sendText, hex: sendHex, append });

  optionsRef.current = options;
  connectOptionsRef.current = connectOptions;
  filterRef.current = filter;
  pausedRef.current = paused;
  connectedRef.current = connected;
  logSelectAllRef.current = logSelectAll;
  transportRef.current = transport;
  tcpPortRef.current = tcpPort;
  statsRef.current = stats;
  sendParamsRef.current = { text: sendText, hex: sendHex, append };

  const view = useMemo(
    () =>
      applyFilter(
        storeRef.current.all,
        filter,
        options.elogMode && !options.hex,
      ),
    [version, filter, options.elogMode, options.hex],
  );

  const searchMatches = useMemo<number[]>(() => {
    const needle = searchTerm.trim();
    if (!needle) return [];
    const target = searchCaseSensitive ? needle : needle.toLowerCase();
    const matches: number[] = [];
    view.visible.forEach((entry, index) => {
      const haystack = `${entry.message}\n${entry.func}\n${entry.tag}\n${entry.tick ?? ""}\n${entry.text}`;
      if ((searchCaseSensitive ? haystack : haystack.toLowerCase()).includes(target)) {
        matches.push(index);
      }
    });
    return matches;
  }, [view.visible, searchTerm, searchCaseSensitive]);

  const activeMatchRow = searchMatches[activeMatch] ?? null;

  const openSearch = () => {
    setSearchOpen(true);
    setOption("autoScroll", false);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchTerm("");
    setActiveMatch(0);
  };

  const goSearch = (delta: number) => {
    if (searchMatches.length === 0) return;
    setActiveMatch(
      (prev) => (prev + delta + searchMatches.length) % searchMatches.length,
    );
    setSearchToken((value) => value + 1);
  };

  const jumpToMatch = (matchIndex: number) => {
    setActiveMatch(matchIndex);
    setSearchToken((value) => value + 1);
  };

  const includesSearch = (text: string) => {
    const needle = searchTerm.trim();
    if (!needle || !text) return false;
    return searchCaseSensitive
      ? text.includes(needle)
      : text.toLowerCase().includes(needle.toLowerCase());
  };

  const scheduleRender = useCallback(() => {
    if (renderTimerRef.current !== null) return;
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      bump();
    }, 16);
  }, []);

  const flushPartial = useCallback(() => {
    if (partialTimerRef.current !== null) {
      window.clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    const text = textBufRef.current;
    if (!text) return;
    textBufRef.current = "";
    partialRef.current = "";
    storeRef.current.push(
      makeEntry(Date.now(), "rx", text, optionsRef.current.elogMode),
    );
    scheduleRender();
  }, [scheduleRender]);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  const sendWakeText = useCallback(
    async (portName: string, autoReconnected = false) => {
      const wake = connectOptionsRef.current;
      const wakeText = wake.wakeEnabled ? wake.wakeText.trim() : "";
      const base = autoReconnected
        ? `${portName} 已自动回连，接收区继续保留`
        : `已连接 ${portName}`;
      if (!wakeText) {
        setStatus(base);
        return;
      }
      // Some ASR USB devices only start streaming logs after receiving one byte.
      await delay(250);
      const appendMode = sendParamsRef.current.append;
      try {
        // Match the send box's 结尾 setting: the ASR device may need "2\r\n",
        // not just "2". Set 结尾=无 if the device wants a single byte.
        const payload = buildPayload(parseEscapes(wakeText), false, appendMode);
        const txId = optionsRef.current.showTx
          ? storeRef.current.push(
              makeEntry(Date.now(), "tx", escapeForDisplay(wakeText + lineEnding(appendMode))),
            )
          : null;
        if (txId !== null) scheduleRender();
        try {
          await bridge.writePort(bytesToBase64(payload));
          setStats((prev) => ({ ...prev, tx: prev.tx + payload.length }));
          setStatus(`${base}，已发送激活字符 "${wakeText}"`);
        } catch (error) {
          if (txId !== null) {
            storeRef.current.remove([txId]);
            scheduleRender();
          }
          setStatus(`${base}，但激活字符发送失败：${normalizeError(error)}`);
        }
      } catch (error) {
        setStatus(`${base}，但激活字符发送失败：${normalizeError(error)}`);
      }
    },
    [scheduleRender],
  );

  function beginAutoReconnect() {
    if (
      reconnectTimerRef.current !== null ||
      manualDisconnectRef.current ||
      transportRef.current !== "serial" ||
      !configRef.current.portName
    ) {
      return;
    }

    const remembered = connectedPortRef.current;
    reconnectAttemptRef.current = 0;
    reconnectingRef.current = true;
    setWaitingReconnect(true);
    setStatus(`连接断开，等待 ${configRef.current.portName} 自动回连…`);

    const attempt = async () => {
      reconnectTimerRef.current = null;
      if (
        manualDisconnectRef.current ||
        transportRef.current !== "serial" ||
        !configRef.current.portName
      ) {
        reconnectingRef.current = false;
        setWaitingReconnect(false);
        return;
      }
      reconnectAttemptRef.current += 1;

      let targetName = remembered?.name ?? configRef.current.portName;
      if (remembered) {
        try {
          const list = await bridge.listPorts();
          const match = findReconnectPort(list, remembered);
          if (match) {
            targetName = match.name;
            connectedPortRef.current = match;
          }
        } catch {
          // Port enumeration failed; keep retrying the remembered port.
        }
      }
      if (!targetName) {
        reconnectingRef.current = false;
        setWaitingReconnect(false);
        return;
      }
      if (targetName !== configRef.current.portName) {
        configRef.current = { ...configRef.current, portName: targetName };
        setConfig((prev) => ({ ...prev, portName: targetName }));
      }
      const targetConfig = { ...configRef.current, portName: targetName };

      try {
        await bridge.openPort(targetConfig);
        if (manualDisconnectRef.current || transportRef.current !== "serial") {
          reconnectingRef.current = false;
          setWaitingReconnect(false);
          if (manualDisconnectRef.current) {
            await bridge.closePort().catch(() => {});
          }
          return;
        }
        reconnectingRef.current = false;
        setWaitingReconnect(false);
        serialWasConnectedRef.current = true;
        setConnected(true);
        const marker = `──────── ${targetName} 已自动回连 @ ${targetConfig.baudRate} ────────`;
        storeRef.current.push(makeEntry(Date.now(), "sys", marker));
        scheduleRender();
        void sendWakeText(targetName, true);
      } catch {
        const wait = Math.min(5000, 800 + reconnectAttemptRef.current * 600);
        if (manualDisconnectRef.current) {
          reconnectingRef.current = false;
          setWaitingReconnect(false);
          return;
        }
        setStatus(
          `${targetName} 未就绪，${Math.round(wait / 100) / 10}s 后重试（第 ${reconnectAttemptRef.current} 次）`,
        );
        reconnectTimerRef.current = window.setTimeout(attempt, wait);
      }
    };

    reconnectTimerRef.current = window.setTimeout(attempt, 800);
  }

  const resetStream = useCallback((encoding?: Encoding) => {
    textBufRef.current = "";
    if (partialTimerRef.current !== null) {
      window.clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    ansiCarryRef.current = "";
    partialRef.current = "";
    const name = encoding ?? optionsRef.current.encoding;
    try {
      decoderRef.current = new TextDecoder(name);
    } catch {
      decoderRef.current = new TextDecoder("utf-8");
    }
  }, []);

  const ingestText = useCallback((bytes: Uint8Array, ts: number) => {
    const decoded = decoderRef.current.decode(bytes, { stream: true });
    let text = decoded;

    // Strip ANSI unless the user explicitly wants raw escape codes. A trailing
    // partial escape sequence is carried to the next chunk so "[0m" split
    // across two serial reads does not leak into the display.
    if (!optionsRef.current.ansiRaw) {
      let combined = ansiCarryRef.current + decoded;
      ansiCarryRef.current = "";
      if (combined.includes("\x1b")) {
        const tail = combined.match(/\x1b(?:\[[0-9;?]*[ -/]*)?$/);
        if (tail) {
          ansiCarryRef.current = tail[0];
          combined = combined.slice(0, combined.length - tail[0].length);
        }
        text = stripAnsi(combined);
      } else {
        text = combined;
      }
    }

    textBufRef.current += text;

    if (textBufRef.current.length > 65536) {
      storeRef.current.push(
        makeEntry(ts, "rx", textBufRef.current.slice(0, 65536), optionsRef.current.elogMode),
      );
      textBufRef.current = textBufRef.current.slice(65536);
    }

    const parts = textBufRef.current.split(/\r\n|\n|\r/);
    textBufRef.current = parts.pop() ?? "";
    for (const part of parts) {
      if (part.length === 0) continue;
      storeRef.current.push(makeEntry(ts, "rx", part, optionsRef.current.elogMode));
    }
    partialRef.current = textBufRef.current;

    if (partialTimerRef.current !== null) {
      window.clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    if (textBufRef.current) {
      partialTimerRef.current = window.setTimeout(() => {
        partialTimerRef.current = null;
        flushPartial();
      }, 120);
    }
  }, [flushPartial]);

  const handleData = useCallback(
    (payload: SerialDataPayload) => {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(payload.data);
      } catch {
        return;
      }
      setStats((prev) => ({ ...prev, rx: prev.rx + bytes.length }));
      if (pausedRef.current) return;
      if (optionsRef.current.hex) {
        // Rust ends each payload at an idle gap, so one payload is one frame.
        if (bytes.length > 0) {
          storeRef.current.push(
            makeEntry(payload.ts, "rx", formatHexFrame(bytes), false),
          );
        }
      } else {
        ingestText(bytes, payload.ts);
      }
      scheduleRender();
    },
    [ingestText, scheduleRender],
  );

  const stopReplay = useCallback((silent = false) => {
    replayCancelledRef.current = true;
    if (replayTimerRef.current !== null) {
      window.clearTimeout(replayTimerRef.current);
      replayTimerRef.current = null;
    }
    setReplaying(false);
    if (!silent) setStatus("已停止回放");
  }, []);

  const applyReplayChunk = useCallback(
    (chunk: SessionChunk) => {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(chunk.data);
      } catch {
        return;
      }
      if (chunk.type === "rx") {
        handleData({ ts: chunk.ts, data: chunk.data, rxTotal: 0 });
        return;
      }
      if (optionsRef.current.hex) {
        storeRef.current.push(
          makeEntry(chunk.ts, "tx", formatHexFrame(bytes), false),
        );
      } else {
        const text = new TextDecoder(optionsRef.current.encoding).decode(bytes);
        storeRef.current.push(makeEntry(chunk.ts, "tx", escapeForDisplay(text)));
      }
      scheduleRender();
    },
    [handleData, scheduleRender],
  );

  const startReplay = useCallback(
    async (file: File) => {
      let text: string;
      try {
        text = await file.text();
      } catch (error) {
        setStatus(`读取会话失败：${normalizeError(error)}`);
        return;
      }

      const { meta, chunks, skipped } = parseSession(text);
      if (chunks.length === 0) {
        setStatus("会话文件没有可回放数据");
        return;
      }

      stopReplay(true);
      resetStream();
      storeRef.current.clear();
      setStats({ rx: 0, tx: 0 });
      setPaused(false);
      pausedRef.current = false;
      bump();

      setReplaying(true);
      setReplayName(file.name);
      setStatus(
        `回放 ${file.name}：${chunks.length} 块${meta?.port ? ` · ${meta.port}` : ""}${
          skipped ? ` · 跳过 ${skipped}` : ""
        }`,
      );

      replayCancelledRef.current = false;
      const speed = replaySpeed;
      let index = 0;
      let prevTs = chunks[0].ts;

      const tick = () => {
        if (replayCancelledRef.current) return;
        if (index >= chunks.length) {
          setReplaying(false);
          setStatus(`回放结束：${file.name}`);
          return;
        }
        const chunk = chunks[index++];
        const wait =
          speed === 0 ? 0 : Math.min(1000, Math.max(0, (chunk.ts - prevTs) / speed));
        prevTs = chunk.ts;
        replayTimerRef.current = window.setTimeout(() => {
          replayTimerRef.current = null;
          if (replayCancelledRef.current) return;
          applyReplayChunk(chunk);
          tick();
        }, wait);
      };
      tick();
    },
    [applyReplayChunk, replaySpeed, resetStream, stopReplay],
  );

  // Auto-save is a backend feature; keep it in sync with the checkbox.
  useEffect(() => {
    let alive = true;
    void bridge
      .setAutoSave(options.autoSave, options.autoSaveMaxMb)
      .then((info) => {
        if (alive) setAutoSaveInfo(info);
      })
      .catch((error) => {
        if (alive) setStatus(`自动保存设置失败: ${String(error)}`);
      });
    return () => {
      alive = false;
    };
  }, [options.autoSave, options.autoSaveMaxMb]);

  // HEX display relies on Rust-side idle framing; text mode keeps 30 ms batching.
  useEffect(() => {
    void bridge
      .setFrameGap(options.hex ? options.hexFrameGapMs : 0)
      .catch((error) => setStatus(`设置断帧间隔失败: ${normalizeError(error)}`));
  }, [options.hex, options.hexFrameGapMs]);

  // Refresh the 10 MB usage indicator.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      void bridge
        .getAutoSaveInfo()
        .then((info) => {
          if (alive) setAutoSaveInfo(info);
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Subscribe to backend events once.
  useEffect(() => {
    let disposed = false;
    let offData: (() => void) | undefined;
    let offState: (() => void) | undefined;
    let offTcpClients: (() => void) | undefined;
    void (async () => {
      offData = await bridge.onSerialData(handleData);
      offState = await bridge.onSerialState((payload) => {
        setConnected(payload.connected);
        setStatus(payload.message);
        if (payload.connected) {
          if (transportRef.current === "serial") {
            serialWasConnectedRef.current = true;
          }
          clearReconnectTimer();
          reconnectingRef.current = false;
          setWaitingReconnect(false);
        } else {
          setRecording(false);
          setTcpClients([]);
          loopRef.current = false;
          setLooping(false);
          if (
            transportRef.current === "serial" &&
            !manualDisconnectRef.current &&
            !reconnectingRef.current &&
            serialWasConnectedRef.current
          ) {
            beginAutoReconnect();
          }
        }
      });
      offTcpClients = await bridge.onTcpClients((payload) => {
        setTcpClients(payload.clients);
      });
      if (disposed) {
        offData?.();
        offState?.();
        offTcpClients?.();
      }
    })();
    return () => {
      disposed = true;
      offData?.();
      offState?.();
      offTcpClients?.();
    };
  }, [handleData]);

  // Poll the port list (USB adapters come and go).
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const list = await bridge.listPorts();
        if (!alive) return;
        setPorts(list);
        setConfig((prev) => {
          const next = nextPortSelection(
            prev.portName,
            list,
            reconnectingRef.current || serialWasConnectedRef.current,
          );
          return next === prev.portName ? prev : { ...prev, portName: next };
        });
      } catch (error) {
        if (alive) setStatus(normalizeError(error));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Apply the light/dark theme to the document.
  useEffect(() => {
    document.documentElement.dataset.theme = options.theme;
  }, [options.theme]);

  useEffect(() => {
    if (!filterToast) return;
    const timer = window.setTimeout(() => setFilterToast(false), 6000);
    return () => window.clearTimeout(timer);
  }, [filterToast]);

  useEffect(() => {
    if (!isFilterActive(filter, options.elogMode && !options.hex)) {
      lastFilterWarnRef.current = 0;
    }
  }, [filter, options.elogMode, options.hex]);

  useEffect(() => {
    setActiveMatch((prev) =>
      searchMatches.length === 0 ? 0 : Math.min(prev, searchMatches.length - 1),
    );
  }, [searchMatches.length]);

  useEffect(() => {
    activeResultRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeMatch, searchTerm]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        setOption("autoScroll", false);
        window.setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 0);
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        setSearchTerm("");
        setActiveMatch(0);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen]);

  useEffect(() => {
    if (!textMenu) return;
    const close = () => setTextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTextMenu(null);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [textMenu]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      const active = document.activeElement;
      if (isEditableText(active)) return;

      if (key === "a") {
        const anchor = window.getSelection()?.anchorNode;
        const anchorElement =
          anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
        const inLog =
          active?.classList.contains("log-viewport") ||
          Boolean(anchorElement?.closest(".log-viewport"));
        if (!inLog) return;
        event.preventDefault();
        selectAllLog();
        return;
      }

      if (key !== "c") return;
      if (logSelectAllRef.current) {
        event.preventDefault();
        void copyAllLogText();
        return;
      }
      const text = window.getSelection()?.toString() ?? "";
      if (!text) return;
      event.preventDefault();
      void writeClipboard(text).then((ok) => {
        if (ok) setStatus(`已复制 ${text.length} 个字符`);
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Persist UI state.
  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);
  useEffect(() => {
    localStorage.setItem(OPTS_KEY, JSON.stringify(options));
  }, [options]);
  useEffect(() => {
    localStorage.setItem(CONNECT_KEY, JSON.stringify(connectOptions));
  }, [connectOptions]);
  useEffect(() => {
    localStorage.setItem("easylog.transport.v1", transport);
  }, [transport]);
  useEffect(() => {
    localStorage.setItem("easylog.tcpPort.v1", String(tcpPort));
  }, [tcpPort]);
  useEffect(() => {
    localStorage.setItem("easylog.tcpHost.v1", tcpHost);
  }, [tcpHost]);
  useEffect(() => {
    if (tcpHost) return;
    let alive = true;
    void bridge
      .localIp()
      .then((ip) => {
        if (alive) setTcpHost((prev) => prev || ip);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tcpHost]);
  useEffect(() => {
    localStorage.setItem(CMDS_KEY, JSON.stringify(commands));
  }, [commands]);
  useEffect(() => {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(quickCategories));
  }, [quickCategories]);
  useEffect(() => {
    localStorage.setItem(CATEGORY_ORDER_KEY, JSON.stringify(categoryOrder));
  }, [categoryOrder]);
  useEffect(() => {
    localStorage.setItem(KEYWORD_COLORS_KEY, JSON.stringify(keywordRules));
  }, [keywordRules]);

  // Rate meter.
  useEffect(() => {
    let last = statsRef.current.rx;
    const timer = window.setInterval(() => {
      const now = statsRef.current.rx;
      setRate(Math.max(0, now - last));
      last = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Browser-only demo mode: http://localhost:1420/?demo=1 auto-connects the mock transport.
  useEffect(() => {
    if (bridge.isTauri()) return;
    if (!new URLSearchParams(window.location.search).has("demo")) return;
    if (!config.portName) return;
    const timer = window.setTimeout(() => {
      void bridge.openPort(config);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.portName]);

  // Keep DTR/RTS in sync when toggled while connected.
  useEffect(() => {
    if (!connected || transport !== "serial") return;
    void bridge.setSignals(config.dtr, config.rts).catch((error) => setStatus(normalizeError(error)));
  }, [config.dtr, config.rts, connected, transport]);

  // Cleanup pending timers and the recording file on unmount.
  useEffect(() => {
    return () => {
      if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
      if (replayTimerRef.current !== null) window.clearTimeout(replayTimerRef.current);
      replayCancelledRef.current = true;
      loopRef.current = false;
      clearReconnectTimer();
      if (partialTimerRef.current !== null) {
        window.clearTimeout(partialTimerRef.current);
        partialTimerRef.current = null;
      }
      void bridge.stopRecording().catch(() => {});
    };
  }, []);

  const maybeWarnFilter = useCallback(() => {
    const mode = optionsRef.current.elogMode && !optionsRef.current.hex;
    if (!isFilterActive(filterRef.current, mode)) return;
    const now = Date.now();
    if (now - lastFilterWarnRef.current < 10000) return;
    lastFilterWarnRef.current = now;
    setFilterToast(true);
  }, []);

  const doSend = useCallback(
    async (text: string, hex: boolean, appendMode: AppendMode): Promise<boolean> => {
      if (!connectedRef.current) {
        setStatus(transportRef.current === "tcp" ? "TCP Server 未启动" : "串口未打开");
        return false;
      }
      let payload: Uint8Array;
      try {
        payload = buildPayload(text, hex, appendMode);
      } catch (error) {
        setStatus(`发送失败：${normalizeError(error)}`);
        return false;
      }
      if (payload.length === 0) return false;

      const sendTs = Date.now();
      const txIds: number[] = [];
      if (optionsRef.current.showTx) {
        if (optionsRef.current.hex) {
          txIds.push(
            storeRef.current.push(makeEntry(sendTs, "tx", formatHexFrame(payload))),
          );
        } else if (hex) {
          const shown = Array.from(payload)
            .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
            .join(" ");
          txIds.push(storeRef.current.push(makeEntry(sendTs, "tx", shown)));
        } else {
          txIds.push(
            storeRef.current.push(
              makeEntry(sendTs, "tx", escapeForDisplay(text + lineEnding(appendMode))),
            ),
          );
        }
        scheduleRender();
      }

      try {
        if (transportRef.current === "tcp") {
          await bridge.writeTcp(bytesToBase64(payload));
        } else {
          await bridge.writePort(bytesToBase64(payload));
        }
        setStats((prev) => ({ ...prev, tx: prev.tx + payload.length }));
        maybeWarnFilter();
        return true;
      } catch (error) {
        storeRef.current.remove(txIds);
        if (txIds.length > 0) scheduleRender();
        setStatus(`发送失败：${normalizeError(error)}`);
        return false;
      }
    },
    [maybeWarnFilter, scheduleRender],
  );

  // Auto send.
  useEffect(() => {
    if (!autoSend || !connected) return;
    const timer = window.setInterval(() => {
      const params = sendParamsRef.current;
      if (!params.text) return;
      void doSend(params.text, params.hex, params.append);
    }, Math.max(20, autoInterval));
    return () => window.clearInterval(timer);
  }, [autoSend, connected, autoInterval, doSend]);

  const handleConnect = async () => {
    manualDisconnectRef.current = false;
    reconnectingRef.current = true;
    setWaitingReconnect(false);
    clearReconnectTimer();
    if (loopRef.current) {
      loopRef.current = false;
      setLooping(false);
    }
    if (transport === "tcp") {
      connectedPortRef.current = null;
      setBusy(true);
      stopReplay(true);
      try {
        resetStream();
        setRecording(false);
        setRecordPath("");
        setReplayName("");
        setTcpClients([]);
        bump();
        await bridge.startTcpServer(tcpHost || "127.0.0.1", tcpPort);
        setConnected(true);
        setStatus(`TCP Server 监听 ${tcpHost}:${tcpPort}，等待客户端连接`);
      } catch (error) {
        setStatus(`启动 TCP Server 失败：${normalizeError(error)}`);
        setConnected(false);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!config.portName) {
      setStatus("请选择串口");
      reconnectingRef.current = false;
      connectedPortRef.current = null;
      return;
    }
    setBusy(true);
    stopReplay(true);
    try {
      resetStream();
      setRecording(false);
      setRecordPath("");
      setReplayName("");
      bump();
      await bridge.openPort(config);

      let info = ports.find((port) => port.name === config.portName);
      if (!info) {
        try {
          info = (await bridge.listPorts()).find(
            (port) => port.name === config.portName,
          );
        } catch {
          // Identity is optional; the port name still works as a fallback.
        }
      }
      connectedPortRef.current = info
        ? { ...info }
        : { name: config.portName, kind: "串口" };

      await sendWakeText(config.portName);
    } catch (error) {
      setStatus(normalizeError(error));
      setConnected(false);
      reconnectingRef.current = false;
      connectedPortRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    manualDisconnectRef.current = true;
    reconnectingRef.current = false;
    serialWasConnectedRef.current = false;
    connectedPortRef.current = null;
    setWaitingReconnect(false);
    clearReconnectTimer();
    if (loopRef.current) {
      loopRef.current = false;
      setLooping(false);
    }
    if (transport === "tcp") {
      setBusy(true);
      try {
        await bridge.stopTcpServer();
        setStatus("TCP Server 已停止");
      } catch (error) {
        setStatus(normalizeError(error));
      } finally {
        setBusy(false);
        setConnected(false);
        setRecording(false);
        setTcpClients([]);
      }
      return;
    }

    setBusy(true);
    try {
      await bridge.closePort();
    } catch (error) {
      setStatus(normalizeError(error));
    } finally {
      setBusy(false);
      setConnected(false);
      setRecording(false);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      try {
        const path = await bridge.stopRecording();
        setRecording(false);
        setStatus(path ? `已停止录制：${path}` : "已停止录制");
      } catch (error) {
        setStatus(`停止录制失败：${normalizeError(error)}`);
      }
      return;
    }

    if (!connected) {
      setStatus(transport === "tcp" ? "请先启动 TCP Server" : "请先连接串口");
      return;
    }

    try {
      const activePort = transport === "tcp" ? `TCP${tcpPort}` : config.portName;
      const baudRate = transport === "tcp" ? 0 : config.baudRate;
      const path = await bridge.startRecording(activePort, baudRate);
      setRecording(true);
      setRecordPath(path);
      setStatus(`录制中：${path}`);
    } catch (error) {
      setStatus(`开始录制失败：${normalizeError(error)}`);
    }
  };

  const togglePause = () => {
    setPaused((prev) => !prev);
    resetStream();
  };

  const clearLog = () => {
    stopReplay(true);
    storeRef.current.clear();
    resetStream();
    setLogSelectAll(false);
    bump();
  };

  const selectAllLog = () => {
    const count = storeRef.current.length;
    if (count === 0) {
      setStatus("没有可全选的日志");
      return;
    }
    setLogSelectAll(true);
    setStatus(`已全选 ${count} 行日志，Ctrl+C 复制`);
  };

  const copyAllLogText = useCallback(async () => {
    const text = storeRef.current.all
      .map(
        (line) =>
          `${optionsRef.current.timestamp ? `[${formatTime(line.ts)}] ` : ""}${line.text}`,
      )
      .join("\r\n");
    if (!text) {
      setStatus("没有可复制的内容");
      return false;
    }
    const ok = await writeClipboard(text);
    if (ok) setStatus(`已复制 ${storeRef.current.all.length} 行`);
    return ok;
  }, []);

  const copyLog = () => copyAllLogText();

  const openTextMenu = (event: ReactMouseEvent) => {
    const element = event.target as HTMLElement;
    const editable = element.closest("input, textarea");
    const x = Math.min(event.clientX, window.innerWidth - 190);
    const y = Math.min(event.clientY, window.innerHeight - 230);

    if (isEditableText(editable) && !editable.disabled) {
      event.preventDefault();
      setTextMenu({
        kind: "text",
        x,
        y,
        target: editable,
        selected: selectedTextOf(editable),
      });
      return;
    }

    if (element.closest(".log-viewport")) {
      event.preventDefault();
      setTextMenu({
        kind: "log",
        x,
        y,
        selected: window.getSelection()?.toString() ?? "",
      });
      return;
    }

    setTextMenu(null);
  };

  const copyMenuSelection = async () => {
    if (!textMenu) return;
    const text =
      textMenu.kind === "text" && textMenu.target
        ? selectedTextOf(textMenu.target)
        : textMenu.selected;
    if (!text) return;
    if (await writeClipboard(text)) {
      setStatus(`已复制 ${text.length} 个字符`);
    }
    setTextMenu(null);
  };

  const cutMenuSelection = async () => {
    const target = textMenu?.target;
    if (!target || target.readOnly) return;
    const selected = selectedTextOf(target);
    if (!selected || !(await writeClipboard(selected))) return;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    setNativeText(target, target.value.slice(0, start) + target.value.slice(end));
    target.focus();
    target.setSelectionRange(start, start);
    setTextMenu(null);
  };

  const pasteIntoMenuTarget = async () => {
    const target = textMenu?.target;
    if (!target || target.readOnly) return;
    try {
      const text = await navigator.clipboard.readText();
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      setNativeText(target, target.value.slice(0, start) + text + target.value.slice(end));
      target.focus();
      const cursor = start + text.length;
      target.setSelectionRange(cursor, cursor);
      setTextMenu(null);
    } catch (error) {
      setStatus(`粘贴失败：${normalizeError(error)}`);
    }
  };

  const selectAllMenuTarget = () => {
    const target = textMenu?.target;
    if (!target) return;
    target.focus();
    target.select();
    setTextMenu(null);
  };

  const clearMenuTarget = () => {
    if (!textMenu) return;
    if (textMenu.kind === "log") {
      clearLog();
    } else if (textMenu.target && !textMenu.target.readOnly) {
      setNativeText(textMenu.target, "");
      textMenu.target.focus();
    }
    setTextMenu(null);
  };

  const saveLog = async () => {
    const text = storeRef.current.all
      .map((line) => `${options.timestamp ? `[${formatTime(line.ts)}] ` : ""}${line.text}`)
      .join("\r\n");
    if (!text) {
      setStatus("没有可保存的内容");
      return;
    }
    try {
      const activePort = transport === "tcp" ? `TCP${tcpPort}` : config.portName;
      if (bridge.isTauri()) {
        const path = await bridge.saveLogText(text, activePort);
        setStatus(`已保存 ${storeRef.current.all.length} 行到 ${path}`);
      } else {
        const port = activePort.replace(/[^A-Za-z0-9_-]/g, "") || "port";
        downloadText(`easylog-${stamp()}-${port}.txt`, text);
        setStatus(`已保存 ${storeRef.current.all.length} 行`);
      }
    } catch (error) {
      setStatus(`保存失败：${normalizeError(error)}`);
    }
  };

  const resolveCommandAppend = (command: QuickCommand): AppendMode =>
    resolveAppend(command.append, append);

  const sendAll = async (list: QuickCommand[]) => {
    const sendable = list.filter((command) => command.enabled);
    for (let index = 0; index < sendable.length; index++) {
      const command = sendable[index];
      const ok = await doSend(command.data, command.hex, resolveCommandAppend(command));
      if (!ok) break;
      if (index < sendable.length - 1) {
        const gap = Math.min(10000, Math.max(0, command.delayMs ?? 0));
        if (gap > 0) await delay(gap);
      }
    }
  };

  const stopLoop = () => {
    if (!loopRef.current) return;
    loopRef.current = false;
    setLooping(false);
    setStatus("循环发送已停止");
  };

  const startLoop = () => {
    if (loopRef.current) return;
    if (!connectedRef.current) {
      setStatus("请先连接串口或启动 TCP Server");
      return;
    }
    const eligible = commandsRef.current.filter(
      (command) => command.enabled && (command.order ?? 0) > 0,
    );
    if (eligible.length === 0) {
      setStatus("没有参与循环的指令：请勾选并设置序号 1 以上");
      return;
    }

    loopRef.current = true;
    setLooping(true);
    setStatus(`循环发送中：${eligible.length} 条，按序号顺序`);
    void (async () => {
      while (loopRef.current) {
        const ordered = commandsRef.current
          .map((command, index) => ({ command, index }))
          .filter(
            ({ command }) => command.enabled && (command.order ?? 0) > 0,
          )
          .sort(
            (a, b) =>
              (a.command.order ?? 0) - (b.command.order ?? 0) ||
              a.index - b.index,
          )
          .map(({ command }) => command);
        if (ordered.length === 0) break;

        for (const command of ordered) {
          if (!loopRef.current || !connectedRef.current) {
            loopRef.current = false;
            break;
          }
          const ok = await doSend(
            command.data,
            command.hex,
            resolveCommandAppend(command),
          );
          if (!ok) {
            loopRef.current = false;
            break;
          }
          const gap = Math.min(10000, Math.max(0, command.delayMs ?? 0));
          if (gap > 0 && loopRef.current) await delay(gap);
        }
      }
      loopRef.current = false;
      setLooping(false);
      if (connectedRef.current) setStatus("循环发送已停止");
    })();
  };

  const importCommands = (text: string, filename: string) => {
    const result = parseCommandText(text);
    if (result.commands.length === 0) {
      setStatus(`导入失败：${result.warnings.join("；") || "没有可用指令"}`);
      return;
    }

    // Merge by name: re-importing an updated sscom51.ini updates existing rows
    // instead of appending a second copy of all 96 commands.
    const { commands: next, added, updated } = mergeCommands(commands, result.commands);
    setCommands(next);
    const warning = result.warnings.length ? `（${result.warnings[0]}）` : "";
    setStatus(`已从 ${filename} 导入：新增 ${added}，更新 ${updated}${warning}`);
  };

  const exportCommands = async () => {
    const filename = `easylog-commands-${stamp()}.json`;
    const content = serializeCommands(commands);
    if (bridge.isTauri()) {
      try {
        const path = await bridge.exportCommands(content, filename);
        setStatus(
          path ? `已导出 ${commands.length} 条指令到 ${path}` : "已取消导出",
        );
      } catch (error) {
        setStatus(`导出失败：${normalizeError(error)}`);
      }
      return;
    }
    downloadText(filename, content, "application/json");
    setStatus(`已导出 ${commands.length} 条指令`);
  };

  const checkForUpdates = useCallback(async (silent = false) => {
    if (!bridge.isTauri()) {
      if (!silent) setStatus("浏览器模式不支持自动更新，请在正式版中检查");
      return;
    }
    if (checkingUpdateRef.current) return;
    checkingUpdateRef.current = true;
    setCheckingUpdate(true);
    if (!silent) setStatus("正在检查更新…");
    try {
      const info = await bridge.checkUpdate();
      if (info) {
        setUpdateInfo(info);
        setStatus(`发现新版本 v${info.version}（当前 v${info.currentVersion}）`);
      } else if (!silent) {
        setStatus("已是最新版本");
      }
    } catch (error) {
      if (!silent) setStatus(`检查更新失败：${normalizeError(error)}`);
    } finally {
      checkingUpdateRef.current = false;
      setCheckingUpdate(false);
    }
  }, []);

  useEffect(() => {
    if (!bridge.isTauri()) return;
    const last = Number(localStorage.getItem("easylog.update.lastCheck") || 0);
    if (last && Date.now() - last < 6 * 60 * 60 * 1000) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem("easylog.update.lastCheck", String(Date.now()));
      void checkForUpdates(true);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  function switchTransport(next: "serial" | "tcp") {
    if (connected || next === transport) return;
    clearReconnectTimer();
    reconnectingRef.current = false;
    connectedPortRef.current = null;
    setWaitingReconnect(false);
    serialWasConnectedRef.current = false;
    if (next === "tcp") {
      serialTimestampRef.current = options.timestamp;
      setOption("timestamp", false);
    } else {
      setOption("timestamp", serialTimestampRef.current);
    }
    setTransport(next);
    setTcpClients([]);
  }

  function setDisplayMode(elogMode: boolean) {
    if (options.elogMode === elogMode) return;
    setOptions((prev) => ({ ...prev, elogMode, ansiRaw: !elogMode }));
    resetStream();
    storeRef.current.clear();
    bump();
  }

  function setOption<K extends keyof DisplayOptions>(key: K, value: DisplayOptions[K]) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div
      className="app"
      data-lines={storeRef.current.length}
      onContextMenu={openTextMenu}
      onPointerDown={() => {
        if (logSelectAll) setLogSelectAll(false);
      }}
    >
      <AppTitleBar
        onCheckUpdate={() => void checkForUpdates(false)}
        updateAvailable={Boolean(updateInfo)}
        checking={checkingUpdate}
      />
      <WindowResizeHandles />
      <Toolbar
        ports={ports}
        config={config}
        connected={connected}
        busy={busy}
        transport={transport}
        waitingReconnect={waitingReconnect}
        tcpPort={tcpPort}
        tcpHost={tcpHost}
        tcpClients={tcpClients.length}
        encoding={options.encoding}
        connectOptions={connectOptions}
        theme={options.theme}
        showFilter={options.showFilter}
        showQuick={options.showQuick}
        onConfigChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
        onConnectOptionsChange={(patch) =>
          setConnectOptions((prev) => ({ ...prev, ...patch }))
        }
        onEncodingChange={(encoding) => {
          setOptions((prev) => ({ ...prev, encoding }));
          resetStream(encoding);
          storeRef.current.clear();
          bump();
        }}
        onThemeChange={(theme) => setOption("theme", theme)}
        onTransportChange={switchTransport}
        onTcpPortChange={setTcpPort}
        onTcpHostChange={setTcpHost}
        onToggleFilter={() => setOption("showFilter", !options.showFilter)}
        onToggleQuick={() => setOption("showQuick", !options.showQuick)}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onRefresh={() => void bridge.listPorts().then(setPorts).catch((e) => setStatus(normalizeError(e)))}
      />

      <div
        className="workspace"
        style={{
          gridTemplateColumns: `${
            options.showFilter ? `${options.filterWidth}px` : "0px"
          } minmax(0, 1fr) ${options.showQuick ? `${options.quickWidth}px` : "0px"}`,
        }}
      >
        {options.showFilter && (
          <FilterPanel
          filter={filter}
          counts={view.counts}
          total={storeRef.current.length}
          visible={view.visible.length}
          width={options.filterWidth}
          elogMode={options.elogMode}
          hexMode={options.hex}
          colorRules={keywordRules}
          onChange={setFilter}
          onReset={() => setFilter(createFilter())}
          onWidthChange={(width) => setOption("filterWidth", width)}
          onColorRulesChange={setKeywordRules}
        />
        )}

        <div className="main-col">
          <section className="receive-pane">
            <div className="pane-header receive-header">
              <span>接收</span>
              <div className="receive-tools">
                <div className="receive-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={options.timestamp}
                    onChange={(e) => setOption("timestamp", e.target.checked)}
                  />
                  时间戳
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={options.direction}
                    onChange={(e) => setOption("direction", e.target.checked)}
                  />
                  方向
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={options.hex}
                    onChange={(e) => {
                      setOptions((prev) => ({ ...prev, hex: e.target.checked }));
                      resetStream();
                      storeRef.current.clear();
                      bump();
                    }}
                  />
                  HEX
                </label>
                {options.hex && (
                  <label
                    className="field inline hex-gap-field"
                    title="两帧之间静默超过该时间就断成新的一行；连续无空闲的数据按 200ms / 4KB 强制断行"
                  >
                    <span>帧间隔</span>
                    <input
                      type="number"
                      min={5}
                      max={2000}
                      step={5}
                      value={options.hexFrameGapMs}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value)) {
                          setOption(
                            "hexFrameGapMs",
                            Math.min(2000, Math.max(5, Math.round(value))),
                          );
                        }
                      }}
                    />
                    <span>ms</span>
                  </label>
                )}
                <div className="mode-switch" role="group" aria-label="日志显示模式">
                  <button
                    type="button"
                    className={options.elogMode ? "active" : ""}
                    onClick={() => setDisplayMode(true)}
                    title="解析 EasyLogger 的级别/Tag/函数，按级别着色"
                  >
                    EasyLog
                  </button>
                  <button
                    type="button"
                    className={!options.elogMode ? "active" : ""}
                    onClick={() => setDisplayMode(false)}
                    title="不解析，原样打印收到的文本"
                  >
                    原始
                  </button>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={options.autoScroll}
                    onChange={(e) => setOption("autoScroll", e.target.checked)}
                  />
                  自动滚动
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={options.showTx}
                    onChange={(e) => setOption("showTx", e.target.checked)}
                  />
                  显示发送
                </label>
                <label
                  className="check"
                  title={`自动保存接收内容到工具目录 logs\\auto（JSONL + 时间戳文本，最多 10MB，循环覆盖最旧分段）${
                    autoSaveInfo?.dir ? `\n${autoSaveInfo.dir}` : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={options.autoSave}
                    onChange={(e) => setOption("autoSave", e.target.checked)}
                  />
                  自动保存
                </label>
                <select
                  className="autosave-size"
                  value={options.autoSaveMaxMb}
                  title="自动保存上限；超出后删除最旧的录制分段"
                  onChange={(e) => setOption("autoSaveMaxMb", Number(e.target.value))}
                >
                  {[5, 10, 20, 50, 100].map((mb) => (
                    <option key={mb} value={mb}>
                      {mb}MB
                    </option>
                  ))}
                </select>
                <label className="field inline" title="日志字号">
                  <span>字号</span>
                  <select
                    value={options.logFontSize}
                    onChange={(e) => setOption("logFontSize", Number(e.target.value))}
                  >
                    {[11, 12, 13, 14, 15, 16, 18].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                </div>

                <div className="receive-row receive-actions">
                <button onClick={togglePause}>{paused ? "继续" : "暂停"}</button>
                <button onClick={clearLog}>清空</button>
                <button onClick={copyLog}>复制</button>
                <button onClick={saveLog}>保存</button>
                <button onClick={openSearch} title="搜索日志 (Ctrl+F)">
                  搜索
                </button>
                <span className="toolbar-sep" />
                <button
                  className={`rec-btn ${recording ? "recording" : ""}`}
                  onClick={() => void toggleRecording()}
                  disabled={!connected && !recording}
                  title={recordPath || "把原始收发录制到 文档\\EasyLog\\sessions"}
                >
                  {recording ? "■ 停止录制" : "● 录制"}
                </button>
                {replaying ? (
                  <button className="rec-btn" onClick={() => stopReplay()}>
                    ■ 停止回放
                  </button>
                ) : (
                  <button
                    onClick={() => replayInputRef.current?.click()}
                    title="打开 .jsonl 会话文件回放"
                  >
                    ▶ 回放
                  </button>
                )}
                <label className="field inline" title="回放速度（对下一次回放生效）">
                  <span>速度</span>
                  <select
                    value={replaySpeed}
                    onChange={(e) => setReplaySpeed(Number(e.target.value))}
                  >
                    <option value={1}>1x</option>
                    <option value={10}>10x</option>
                    <option value={0}>立即</option>
                  </select>
                </label>
                {replaying && (
                  <span className="badge rec" title={replayName}>
                    回放中
                  </span>
                )}
                <input
                  ref={replayInputRef}
                  type="file"
                  accept=".jsonl,.elog,application/json,text/plain"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void startReplay(file);
                  }}
                />
                </div>
              </div>
            </div>
            {searchOpen && (
              <>
                <div className="log-search">
                  <span className="log-search-icon">⌕</span>
                  <input
                    ref={searchInputRef}
                    value={searchTerm}
                    placeholder="搜索日志、函数、Tag…（Enter 下一个，Shift+Enter 上一个）"
                    onChange={(e) => {
                      setSearchTerm(e.target.value);
                      setActiveMatch(0);
                      setSearchToken((value) => value + 1);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        goSearch(e.shiftKey ? -1 : 1);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        closeSearch();
                      }
                    }}
                  />
                  <label className="search-case" title="区分大小写">
                    <input
                      type="checkbox"
                      checked={searchCaseSensitive}
                      onChange={(e) => {
                        setSearchCaseSensitive(e.target.checked);
                        setActiveMatch(0);
                        setSearchToken((value) => value + 1);
                      }}
                    />
                    Aa
                  </label>
                  <span className="log-search-count">
                    {searchMatches.length === 0
                      ? "0/0"
                      : `${activeMatch + 1}/${searchMatches.length}`}
                  </span>
                  <button
                    className="icon-btn"
                    title="上一个"
                    disabled={searchMatches.length === 0}
                    onClick={() => goSearch(-1)}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    title="下一个"
                    disabled={searchMatches.length === 0}
                    onClick={() => goSearch(1)}
                  >
                    ↓
                  </button>
                  <button className="icon-btn" title="关闭搜索" onClick={closeSearch}>
                    ×
                  </button>
                </div>

                {searchTerm.trim() && (
                  <div className="search-results">
                    <div className="search-results-head">
                      匹配 <b>{searchMatches.length}</b> 行
                      {searchMatches.length > 300 && <span>（仅显示前 300 行）</span>}
                    </div>
                    {searchMatches.length === 0 ? (
                      <div className="search-results-empty">没有匹配项</div>
                    ) : (
                      searchMatches.slice(0, 300).map((lineIndex, matchIndex) => {
                        const entry = view.visible[lineIndex];
                        const displayMessage = options.elogMode
                          ? entry.message
                          : entry.text;
                        return (
                          <button
                            type="button"
                            key={lineIndex}
                            ref={matchIndex === activeMatch ? activeResultRef : undefined}
                            className={`search-result ${
                              matchIndex === activeMatch ? "active" : ""
                            }`}
                            onClick={() => jumpToMatch(matchIndex)}
                          >
                            <span className="search-result-time">
                              [{formatTime(entry.ts)}]
                            </span>
                            <span
                              className={`search-result-lvl ${
                                ["A", "E", "W", "I", "D", "V"].includes(entry.level)
                                  ? `lv-${entry.level.toLowerCase()}`
                                  : ""
                              }`}
                            >
                              {entry.level}
                            </span>
                            <span className="search-result-dir">
                              {entry.dir === "tx" ? "发→" : entry.dir === "rx" ? "收←" : "·"}
                            </span>
                            <span className="search-result-msg">
                              {includesSearch(displayMessage) ? (
                                highlightText(
                                  displayMessage,
                                  searchTerm,
                                  searchCaseSensitive,
                                )
                              ) : includesSearch(entry.func) ? (
                                <>
                                  <span className="search-result-context">
                                    {highlightText(
                                      entry.func,
                                      searchTerm,
                                      searchCaseSensitive,
                                    )}
                                  </span>
                                  <span className="search-result-sep"> · </span>
                                  {displayMessage}
                                </>
                              ) : (
                                <>
                                  <span className="search-result-context">
                                    {highlightText(
                                      entry.tag,
                                      searchTerm,
                                      searchCaseSensitive,
                                    )}
                                  </span>
                                  <span className="search-result-sep"> · </span>
                                  {displayMessage}
                                </>
                              )}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </>
            )}
            <LogView
              lines={view.visible}
              partial={partialRef.current}
              options={options}
              paused={paused}
              header={
                <LogHeader
                  options={options}
                  onResize={(key, width) => setOption(key, width)}
                />
              }
              colorRules={keywordRules}
              searchTerm={searchTerm}
              searchCaseSensitive={searchCaseSensitive}
              activeMatchRow={activeMatchRow}
              scrollToken={searchToken}
              selectAll={logSelectAll}
              onAutoScrollChange={(value) => setOption("autoScroll", value)}
            />
          </section>

          <SendPane
            value={sendText}
            onChange={setSendText}
            hex={sendHex}
            onHexChange={setSendHex}
            append={append}
            onAppendChange={setAppend}
            autoSend={autoSend}
            onAutoSendChange={setAutoSend}
            autoInterval={autoInterval}
            onAutoIntervalChange={setAutoInterval}
            connected={connected}
            onSend={() =>
              void doSend(
                atPrefix && !sendHex ? withAtPrefix(sendText) : sendText,
                sendHex,
                append,
              )
            }
            atPrefix={atPrefix}
            onAtPrefixChange={setAtPrefix}
            height={options.sendHeight}
            onHeightChange={(height) => setOption("sendHeight", height)}
          />
        </div>

        {options.showQuick && (
          <QuickCommands
            commands={commands}
            connected={connected}
            width={options.quickWidth}
            looping={looping}
            categories={quickCategories}
            categoryOrder={categoryOrder}
            onChange={setCommands}
            onCategoriesChange={setQuickCategories}
            onCategoryOrderChange={setCategoryOrder}
            onSend={(command) => void doSend(command.data, command.hex, resolveCommandAppend(command))}
            onSendAll={(list) => void sendAll(list)}
            onStartLoop={startLoop}
            onStopLoop={stopLoop}
            onLoad={(command) => {
              setSendText(command.data);
              setSendHex(command.hex);
              if (command.append !== "global") setAppend(command.append);
            }}
            onImport={importCommands}
            onExport={exportCommands}
            onWidthChange={(width) => setOption("quickWidth", width)}
          />
        )}
      </div>

      {filterToast && (
        <div className="app-toast filter-warn" role="status">
          <span className="app-toast-icon">!</span>
          <div className="app-toast-body">
            <strong>当前有过滤条件</strong>
            <span>发送的指令和设备回复可能不会显示在接收区。</span>
          </div>
          <button
            className="link-btn"
            onClick={() => {
              setFilter(createFilter());
              setFilterToast(false);
            }}
          >
            清除过滤
          </button>
          <button
            className="toast-close"
            title="关闭提示"
            onClick={() => setFilterToast(false)}
          >
            ×
          </button>
        </div>
      )}

      {textMenu && (
        <div
          className="text-context-menu"
          style={{ left: textMenu.x, top: textMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {textMenu.kind === "text" ? (
            <>
              <button
                disabled={!textMenu.selected || textMenu.target?.readOnly}
                onClick={() => void cutMenuSelection()}
              >
                剪切 <kbd>Ctrl+X</kbd>
              </button>
              <button
                disabled={!textMenu.selected}
                onClick={() => void copyMenuSelection()}
              >
                复制 <kbd>Ctrl+C</kbd>
              </button>
              <button
                disabled={textMenu.target?.readOnly}
                onClick={() => void pasteIntoMenuTarget()}
              >
                粘贴 <kbd>Ctrl+V</kbd>
              </button>
              <div className="text-menu-sep" />
              <button onClick={selectAllMenuTarget}>
                全选 <kbd>Ctrl+A</kbd>
              </button>
              <button
                disabled={textMenu.target?.readOnly}
                onClick={clearMenuTarget}
              >
                清除
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  selectAllLog();
                  setTextMenu(null);
                }}
              >
                全选日志
              </button>
              <button
                disabled={!textMenu.selected}
                onClick={() => void copyMenuSelection()}
              >
                复制选中
              </button>
              <button
                onClick={() => {
                  void copyLog();
                  setTextMenu(null);
                }}
              >
                复制全部日志
              </button>
              <div className="text-menu-sep" />
              <button
                onClick={() => {
                  openSearch();
                  setTextMenu(null);
                }}
              >
                查找…
              </button>
              <button onClick={clearMenuTarget}>清除日志</button>
            </>
          )}
        </div>
      )}

      {updateInfo && (
        <UpdateDialog info={updateInfo} onClose={() => setUpdateInfo(null)} />
      )}

      <StatusBar
        connected={connected}
        transport={transport}
        tcpClients={tcpClients.length}
        portName={transport === "tcp" ? `${tcpHost}:${tcpPort}` : config.portName}
        baudRate={config.baudRate}
        rx={stats.rx}
        tx={stats.tx}
        lines={view.visible.length}
        totalLines={storeRef.current.length}
        rate={rate}
        paused={paused}
        hexMode={options.hex}
        recording={recording}
        recordPath={recordPath}
        replaying={replaying}
        replayName={replayName}
        status={status}
        autoSaveInfo={autoSaveInfo}
      />
    </div>
  );
}
