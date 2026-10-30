import type { AppendMode, CommandAppend, QuickCommand } from "../types";
import { parseEscapes } from "./format";

export interface ParsedCommand {
  name: string;
  data: string;
  hex: boolean;
  append: CommandAppend;
  enabled: boolean;
  category?: string;
  delayMs?: number;
  order?: number;
}

export interface ParseResult {
  commands: ParsedCommand[];
  warnings: string[];
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeAppend(value: unknown): CommandAppend {
  if (value === "none" || value === "cr" || value === "lf" || value === "crlf") return value;
  // Missing append => follow the send box's 结尾 setting.
  return "global";
}

/** Text commands that already end in CR/LF must not get a second tail. */
function inferAppend(data: string): CommandAppend {
  return /[\r\n]$/.test(data) ? "none" : "global";
}

/**
 * Old imports stored append="none", which silently dropped the newline that
 * SSCOM/AT commands need. Migrate those to "global" (follow the send box).
 */
export function migrateCommandAppend(command: QuickCommand): QuickCommand {
  const append = command.append ?? "global";
  if (append === "none" && !/[\r\n]$/.test(command.data)) {
    return { ...command, append: "global" };
  }
  if (append === "global") {
    return { ...command, append: "global" };
  }
  return command;
}

/** Resolve a command's tail mode against the send box's 结尾 setting. */
export function resolveAppend(append: CommandAppend, globalAppend: AppendMode): AppendMode {
  return append === "global" ? globalAppend : append;
}

export interface MergeResult {
  commands: QuickCommand[];
  added: number;
  updated: number;
}

/**
 * Merge an import into the existing list by name. Re-importing an updated
 * sscom51.ini updates rows in place instead of duplicating the whole list.
 * Existing enabled/append choices win over the imported defaults.
 */
export function mergeCommands(
  existing: QuickCommand[],
  incoming: ParsedCommand[],
): MergeResult {
  const commands = [...existing];
  let added = 0;
  let updated = 0;

  for (const item of incoming) {
    const index = commands.findIndex((command) => command.name === item.name);
    if (index >= 0) {
      const current = commands[index];
      commands[index] = {
        ...current,
        data: item.data,
        hex: item.hex,
        delayMs: item.delayMs,
        append: current.append === "none" ? item.append : current.append,
      };
      updated += 1;
    } else {
      commands.push({ ...item, id: newId(), category: item.category || "未分类" });
      added += 1;
    }
  }

  return { commands, added, updated };
}

function previewName(data: string): string {
  const oneLine = data.replace(/\s+/g, " ").trim();
  if (!oneLine) return "未命名指令";
  return oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine;
}

/**
 * SSCOM (sscom51.ini) stores each row in two entries:
 *   N1=A,AT+CSQ              data: "A" = ASCII, "H" = HEX
 *   N101=0,查询信号,1000      meta: enabled? , name , delay(ms)
 * N1..N99 pair with N101..N199. The file is GBK encoded (decoded by caller).
 */
function parseSscomIni(text: string): ParseResult | null {
  const data = new Map<number, { hex: boolean; value: string }>();
  const meta = new Map<number, { name: string; delayMs: number }>();

  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^N(\d+)=(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const index = Number(match[1]);
    const value = match[2];

    if (index >= 100 && index < 200) {
      const parts = value.split(",");
      meta.set(index - 100, {
        name: (parts[1] ?? "").trim(),
        delayMs: Number(parts[2] ?? 0) || 0,
      });
      continue;
    }

    if (index >= 1 && index < 100) {
      const comma = value.indexOf(",");
      if (comma < 0) continue;
      const kind = value.slice(0, comma).trim().toUpperCase();
      if (kind !== "A" && kind !== "H") continue;
      const raw = value.slice(comma + 1);
      // SSCOM uses 0x02 as an escaped comma inside ASCII commands because
      // "," is its ini field separator. Restore e.g. "LOG\x02255" -> "LOG,255".
      const payload = kind === "A" ? raw.replace(/\x02/g, ",") : raw;
      data.set(index, { hex: kind === "H", value: payload });
    }
  }

  if (data.size === 0) return null;

  const commands: ParsedCommand[] = [];
  for (const [index, item] of Array.from(data.entries()).sort((a, b) => a[0] - b[0])) {
    if (!item.value.trim()) continue;
    const info = meta.get(index);
    commands.push({
      name: info?.name || previewName(item.value),
      data: item.value,
      hex: item.hex,
      append: "global",
      enabled: true,
      delayMs: info?.delayMs || undefined,
    });
  }
  return { commands, warnings: [] };
}

/**
 * Import formats:
 *  1. JSON: [{ name, data, hex, append }] or { commands: [...] }
 *  2. Text: one command per line, optional "name<TAB>data" or "name|data"
 *     - lines starting with # or // are comments
 *     - "HEX: 01 03 00 00" marks a hex command
 *     - \r \n \t \xNN escapes are decoded for text commands
 */
export function parseCommandText(text: string): ParseResult {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { commands: [], warnings: ["文件为空"] };

  // Guard: a session file dropped into "导入" must not become commands.
  if (/"type"\s*:\s*"meta"/.test(text) && /"type"\s*:\s*"rx"/.test(text)) {
    return { commands: [], warnings: ["这是会话文件，请用“回放”打开"] };
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const list: unknown[] = Array.isArray(json) ? json : Array.isArray(json?.commands) ? json.commands : [];
      const commands: ParsedCommand[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const data = String(obj.data ?? obj.command ?? obj.cmd ?? "");
        if (!data) continue;
        commands.push({
          name: String(obj.name ?? previewName(data)),
          data,
          hex: Boolean(obj.hex),
          append: normalizeAppend(obj.append),
          enabled: obj.enabled === undefined ? true : Boolean(obj.enabled),
          category: typeof obj.category === "string" ? obj.category : undefined,
          delayMs: Number(obj.delayMs) || undefined,
          order: Number(obj.order) || undefined,
        });
      }
      if (commands.length === 0) warnings.push("JSON 中没有可用指令");
      return { commands, warnings };
    } catch (error) {
      warnings.push(`JSON 解析失败，按文本导入: ${(error as Error).message}`);
    }
  }

  const sscom = parseSscomIni(text);
  if (sscom) return sscom;

  const commands: ParsedCommand[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;

    let name = "";
    let body = line;

    const tab = line.indexOf("\t");
    const pipe = line.indexOf("|");
    if (tab >= 0) {
      name = line.slice(0, tab).trim();
      body = line.slice(tab + 1).trim();
    } else if (pipe >= 0) {
      name = line.slice(0, pipe).trim();
      body = line.slice(pipe + 1).trim();
    }

    let hex = false;
    const hexMatch = body.match(/^(?:hex|HEX)\s*[:：]\s*/);
    if (hexMatch) {
      hex = true;
      body = body.slice(hexMatch[0].length).trim();
    }

    if (!body) {
      warnings.push(`第 ${index + 1} 行没有指令内容，已跳过`);
      return;
    }

    const data = hex ? body : parseEscapes(body);
    commands.push({
      name: name || previewName(body),
      data,
      hex,
      append: inferAppend(data),
      enabled: true,
    });
  });

  if (commands.length === 0 && warnings.length === 0) warnings.push("没有解析到指令");
  return { commands, warnings };
}

export function serializeCommands(commands: QuickCommand[]): string {
  return JSON.stringify(
    {
      version: 1,
      generator: "EasyLog Serial",
      commands: commands.map(({ id: _id, ...rest }) => rest),
    },
    null,
    2,
  );
}

export function makeCommand(
  name: string,
  data: string,
  hex: boolean,
  append: CommandAppend,
): QuickCommand {
  return {
    id: newId(),
    name: name || previewName(data),
    data,
    hex,
    append,
    enabled: true,
    category: "未分类",
  };
}
