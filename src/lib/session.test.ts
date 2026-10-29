import { describe, expect, it } from "vitest";
import { parseSession } from "./session";

describe("parseSession", () => {
  it("parses meta and rx/tx chunks", () => {
    const text = [
      '{"type":"meta","version":1,"started":1000,"port":"COM5","baud":115200}',
      '{"type":"rx","ts":1001,"data":"AQID"}',
      '{"type":"tx","ts":1002,"data":"BAUG"}',
      "",
    ].join("\n");
    const result = parseSession(text);
    expect(result.meta).toMatchObject({ version: 1, started: 1000, port: "COM5", baud: 115200 });
    expect(result.chunks).toEqual([
      { type: "rx", ts: 1001, data: "AQID" },
      { type: "tx", ts: 1002, data: "BAUG" },
    ]);
    expect(result.skipped).toBe(0);
  });

  it("skips malformed lines without failing the whole file", () => {
    const text = [
      '{"type":"meta","version":1,"started":1}',
      "not json",
      '{"type":"rx","ts":"bad","data":"AQID"}',
      '{"type":"rx","ts":2,"data":"AQID"}',
    ].join("\n");
    const result = parseSession(text);
    expect(result.chunks).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("handles an empty file", () => {
    const result = parseSession("");
    expect(result.meta).toBeNull();
    expect(result.chunks).toHaveLength(0);
  });
});
