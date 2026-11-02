import type { AppendMode } from "../types";

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Remove ANSI CSI/OSC sequences (colors, cursor control). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${d
    .getMilliseconds()
    .toString()
    .padStart(3, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function lineEnding(mode: AppendMode): string {
  switch (mode) {
    case "cr":
      return "\r";
    case "lf":
      return "\n";
    case "crlf":
      return "\r\n";
    default:
      return "";
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Parse "01 03 00 00" / "0x01,0x03" / "01030000" into bytes. */
export function parseHexInput(input: string): Uint8Array {
  const normalized = input
    .replace(/0x/gi, " ")
    .replace(/[,;]/g, " ")
    .trim();
  if (!normalized) return new Uint8Array();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const out: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-fA-F]+$/.test(token)) {
      throw new Error(`非法 HEX 片段: ${token}`);
    }
    if (token.length <= 2) {
      out.push(parseInt(token, 16));
      continue;
    }
    if (token.length % 2 !== 0) {
      throw new Error(`HEX 长度不是偶数: ${token}`);
    }
    for (let i = 0; i < token.length; i += 2) {
      out.push(parseInt(token.slice(i, i + 2), 16));
    }
  }
  return new Uint8Array(out);
}

export function buildPayload(text: string, hex: boolean, append: AppendMode): Uint8Array {
  const end = new TextEncoder().encode(lineEnding(append));
  if (hex) {
    const body = parseHexInput(text);
    const out = new Uint8Array(body.length + end.length);
    out.set(body, 0);
    out.set(end, body.length);
    return out;
  }
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + end.length);
  out.set(body, 0);
  out.set(end, body.length);
  return out;
}

/** One protocol frame on one line: `01 03 00 00 00 01 84 0A`. */
export function formatHexFrame(bytes: ArrayLike<number>): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).toUpperCase().padStart(2, "0"));
  }
  return hex.join(" ");
}

export function escapeForDisplay(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** Decode C-style escapes used in command lists: \r \n \t \xNN \\ */
export function parseEscapes(input: string): string {
  return input.replace(/\\(x[0-9a-fA-F]{2}|r|n|t|v|a|b|f|0|\\)/g, (_match, group: string) => {
    switch (group) {
      case "r":
        return "\r";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "v":
        return "\v";
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      default:
        return String.fromCharCode(parseInt(group.slice(1), 16));
    }
  });
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
