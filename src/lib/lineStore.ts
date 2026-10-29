import type { LogEntry } from "../types";

let nextId = 1;

/** Ring buffer of parsed log entries. Kept outside React state for throughput. */
export class LineStore {
  all: LogEntry[] = [];

  constructor(public readonly max = 20000) {}

  push(entry: Omit<LogEntry, "id">): number {
    const id = nextId++;
    this.all.push({ ...entry, id });
    // Trim in chunks: shift()/splice() on every line is O(n) and kills throughput.
    if (this.all.length > this.max + 2000) {
      this.all.splice(0, this.all.length - this.max);
    }
    return id;
  }

  remove(ids: number[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.all = this.all.filter((entry) => !drop.has(entry.id));
  }

  clear(): void {
    this.all = [];
  }

  get length(): number {
    return this.all.length;
  }
}
