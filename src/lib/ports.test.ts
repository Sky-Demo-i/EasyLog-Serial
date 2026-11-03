import { describe, expect, it } from "vitest";
import type { PortInfo } from "../types";
import { findReconnectPort, nextPortSelection } from "./ports";

const ch340: PortInfo = {
  name: "COM5",
  kind: "USB",
  vid: 0x1a86,
  pid: 0x7523,
  serialNumber: "SN-5",
  product: "USB-SERIAL CH340",
  manufacturer: "wch.cn",
};

const com1: PortInfo = { name: "COM1", kind: "串口" };

describe("findReconnectPort", () => {
  it("stays on the exact same COM name", () => {
    expect(findReconnectPort([com1, ch340], ch340)?.name).toBe("COM5");
  });

  it("does not follow the same USB adapter to another COM name", () => {
    const moved = { ...ch340, name: "COM3" };
    expect(findReconnectPort([com1, moved], ch340)).toBeUndefined();
  });

  it("does not follow a matching serial number to another COM name", () => {
    const moved = { ...ch340, name: "COM7" };
    expect(findReconnectPort([com1, moved], ch340)).toBeUndefined();
  });

  it("returns nothing while the original COM name is absent", () => {
    expect(findReconnectPort([com1], ch340)).toBeUndefined();
  });
});

describe("nextPortSelection", () => {
  it("keeps the current port while it exists", () => {
    expect(nextPortSelection("COM5", [com1, ch340], false)).toBe("COM5");
  });

  it("keeps a missing port while reconnecting", () => {
    expect(nextPortSelection("COM5", [com1], true)).toBe("COM5");
  });

  it("falls back to the first port when not reconnecting", () => {
    expect(nextPortSelection("COM5", [com1], false)).toBe("COM1");
  });

  it("returns empty when there are no ports", () => {
    expect(nextPortSelection("", [], false)).toBe("");
  });
});
