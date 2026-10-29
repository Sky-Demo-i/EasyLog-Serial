import { describe, expect, it } from "vitest";
import type { LogEntry, LogFilter, LogLevel } from "../types";
import { makeEntry } from "./elog";
import { applyFilter, createFilter } from "./filter";

const entries: LogEntry[] = [
  makeEntry(1, "rx", "V/TRK    (10 main_start)boot ok"),
  makeEntry(2, "rx", "D/TRK    (20 read_xyz)x:y:z=1:2:3"),
  makeEntry(3, "rx", "W/TRK    (30 rollover_check)rollover margin low"),
  makeEntry(4, "rx", "I/SYS    (40 heartbeat)tick=1024"),
  makeEntry(5, "rx", "E/TRK    (50 assert_failed)assert failed"),
  makeEntry(6, "rx", "raw output without prefix"),
].map((entry, index) => ({ ...entry, id: index + 1 }));

function withFilter(patch: Partial<LogFilter>): LogFilter {
  return { ...createFilter(), ...patch };
}

describe("applyFilter", () => {
  it("shows everything by default", () => {
    const result = applyFilter(entries, createFilter());
    expect(result.visible).toHaveLength(6);
    expect(result.counts.levels).toMatchObject({ A: 0, E: 1, W: 1, I: 1, D: 1, V: 1, "?": 1 });
    expect(result.counts.tags.find((item) => item.tag === "TRK")?.count).toBe(4);
  });

  it("filters by level while keeping raw lines", () => {
    const result = applyFilter(entries, withFilter({ levels: new Set<LogLevel>(["E"]) }));
    expect(result.visible.map((entry) => entry.level)).toEqual(["E", "?"]);
  });

  it("filters by tag and hides raw lines", () => {
    const result = applyFilter(entries, withFilter({ tags: new Set(["TRK"]) }));
    expect(result.visible).toHaveLength(4);
    expect(result.visible.every((entry) => entry.tag === "TRK")).toBe(true);
  });

  it("filters by keyword", () => {
    const result = applyFilter(entries, withFilter({ keyword: "rollover" }));
    expect(result.visible).toHaveLength(1);
    expect(result.visible[0].level).toBe("W");
  });

  it("supports regular expressions", () => {
    const result = applyFilter(entries, withFilter({ keyword: "^I/", regex: true }));
    expect(result.visible).toHaveLength(1);
    expect(result.visible[0].tag).toBe("SYS");
  });

  it("inverts the keyword match", () => {
    const result = applyFilter(entries, withFilter({ keyword: "rollover", invert: true }));
    expect(result.visible).toHaveLength(5);
  });

  it("ignores level/tag filters in raw SSCOM mode", () => {
    const result = applyFilter(
      entries,
      withFilter({ levels: new Set<LogLevel>(["E"]), tags: new Set(["SYS"]) }),
      false,
    );
    expect(result.visible).toHaveLength(6);
  });

  it("falls back to substring when the regex is invalid", () => {
    const result = applyFilter(entries, withFilter({ keyword: "[", regex: true }));
    expect(result.visible).toHaveLength(0);
  });
});
