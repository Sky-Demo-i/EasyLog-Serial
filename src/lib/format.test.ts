import { describe, expect, it } from "vitest";
import {
  buildPayload,
  formatHexRow,
  parseEscapes,
  parseHexInput,
  stripAnsi,
} from "./format";

describe("stripAnsi", () => {
  it("removes SGR color sequences", () => {
    expect(stripAnsi("\x1b[34;22mV/TRK    (185 foo)\x1b[0m")).toBe("V/TRK    (185 foo)");
  });

  it("removes reset-only lines", () => {
    expect(stripAnsi("\x1b[0m")).toBe("");
  });
});

describe("parseHexInput", () => {
  it("parses space separated bytes", () => {
    expect(Array.from(parseHexInput("01 03 00 0A"))).toEqual([1, 3, 0, 10]);
  });

  it("parses 0x and comma forms", () => {
    expect(Array.from(parseHexInput("0x01,0x03;0xFF"))).toEqual([1, 3, 255]);
  });

  it("parses contiguous hex", () => {
    expect(Array.from(parseHexInput("0103000A"))).toEqual([1, 3, 0, 10]);
  });

  it("rejects invalid input", () => {
    expect(() => parseHexInput("GG")).toThrow();
    expect(() => parseHexInput("ABC")).toThrow();
  });
});

describe("buildPayload", () => {
  it("appends CRLF to text", () => {
    expect(Array.from(buildPayload("AT", false, "crlf"))).toEqual([65, 84, 13, 10]);
  });

  it("appends CR to hex bytes", () => {
    expect(Array.from(buildPayload("01 02", true, "cr"))).toEqual([1, 2, 13]);
  });

  it("does not append when mode is none", () => {
    expect(Array.from(buildPayload("A", false, "none"))).toEqual([65]);
  });
});

describe("formatHexRow", () => {
  it("formats offset, hex and ascii", () => {
    const row = formatHexRow([0x01, 0x41, 0x7f], 0x10);
    expect(row).toContain("00000010");
    expect(row).toContain("01 41 7F");
    expect(row).toContain("|.A.");
  });
});

describe("parseEscapes", () => {
  it("decodes CR/LF and hex escapes", () => {
    expect(parseEscapes(String.raw`a\r\n\x41`)).toBe("a\r\nA");
  });
});
