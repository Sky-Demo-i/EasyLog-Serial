import { describe, expect, it } from "vitest";
import {
  buildPayload,
  formatHexFrame,
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

describe("formatHexFrame", () => {
  it("formats one frame as uppercase hex on a single line", () => {
    expect(formatHexFrame([0x01, 0x03, 0x00, 0xab])).toBe("01 03 00 AB");
  });

  it("keeps long frames on one line", () => {
    const bytes = Array.from({ length: 20 }, (_, index) => index);
    expect(formatHexFrame(bytes)).toBe(
      "00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13",
    );
  });

  it("returns an empty string for an empty frame", () => {
    expect(formatHexFrame([])).toBe("");
  });
});

describe("parseEscapes", () => {
  it("decodes CR/LF and hex escapes", () => {
    expect(parseEscapes(String.raw`a\r\n\x41`)).toBe("a\r\nA");
  });
});
