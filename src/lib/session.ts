export interface SessionMeta {
  version: number;
  started: number;
  port?: string;
  baud?: number;
}

export interface SessionChunk {
  type: "rx" | "tx";
  ts: number;
  data: string;
}

export interface SessionParseResult {
  meta: SessionMeta | null;
  chunks: SessionChunk[];
  skipped: number;
}

/**
 * Parse a `.jsonl` session written by the Rust backend:
 *   {"type":"meta","version":1,"started":...,"port":"COM5","baud":115200}
 *   {"type":"rx","ts":...,"data":"<base64>"}
 *   {"type":"tx","ts":...,"data":"<base64>"}
 */
export function parseSession(text: string): SessionParseResult {
  let meta: SessionMeta | null = null;
  const chunks: SessionChunk[] = [];
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed) as Record<string, unknown>;
      if (item.type === "meta") {
        meta = {
          version: Number(item.version) || 1,
          started: Number(item.started) || 0,
          port: typeof item.port === "string" ? item.port : undefined,
          baud: Number(item.baud) || undefined,
        };
        continue;
      }
      if (
        (item.type === "rx" || item.type === "tx") &&
        typeof item.data === "string" &&
        Number.isFinite(Number(item.ts))
      ) {
        chunks.push({ type: item.type, ts: Number(item.ts), data: item.data });
        continue;
      }
      skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return { meta, chunks, skipped };
}
