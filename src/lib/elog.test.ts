import { describe, expect, it } from "vitest";
import { makeEntry, parseElogLine } from "./elog";

describe("parseElogLine", () => {
  it("parses the default EasyLogger format", () => {
    const fields = parseElogLine("V/TRK    (185 jm_pal_get_utc_time)[480],1970-1-1 8:32:54");
    expect(fields).toMatchObject({
      level: "V",
      tag: "TRK",
      lineNo: 185,
      func: "jm_pal_get_utc_time",
      tick: "480",
      parsed: true,
    });
    expect(fields.message).toBe(",1970-1-1 8:32:54");
  });

  it("parses the device tick bracket and function name", () => {
    const fields = parseElogLine(
      "D/tracker_misc (2415 jm_poweron_2min_bat_get) [up=76470][rst=0] AverVoltage:4280",
    );
    expect(fields).toMatchObject({
      level: "D",
      tag: "tracker_misc",
      lineNo: 2415,
      func: "jm_poweron_2min_bat_get",
      tick: "up=76470",
      parsed: true,
    });
    expect(fields.message).toBe("[rst=0] AverVoltage:4280");
  });

  it("parses while ANSI colors are still present", () => {
    const fields = parseElogLine(
      "\x1b[34;22mV/TRK    (185 jm_pal_get_utc_time)[480],1970-1-1 8:32:54\x1b[0m",
    );
    expect(fields).toMatchObject({
      level: "V",
      tag: "TRK",
      lineNo: 185,
      func: "jm_pal_get_utc_time",
      tick: "480",
      parsed: true,
    });
    expect(fields.message).toBe(",1970-1-1 8:32:54");
  });

  it("falls back to raw text", () => {
    expect(parseElogLine("raw output")).toMatchObject({ parsed: false, level: "?" });
  });
});

describe("makeEntry", () => {
  it("keeps TX lines raw", () => {
    const entry = makeEntry(1, "tx", "AT+CSQ\\r\\n");
    expect(entry.parsed).toBe(false);
    expect(entry.level).toBe("?");
  });
});
