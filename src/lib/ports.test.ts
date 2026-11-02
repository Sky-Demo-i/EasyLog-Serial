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
  it("prefers the serial number over the old COM name", () => {
    const moved = { ...ch340, name: "COM7" };
    expect(findReconnectPort([com1, moved], ch340)?.name).toBe("COM7");
  });

  it("matches a unique VID/PID when there is no serial number", () => {
    const remembered = { ...ch340, serialNumber: undefined };
    const moved = { ...remembered, name: "COM7" };
    expect(findReconnectPort([com1, moved], remembered)?.name).toBe("COM7");
  });

  it("uses product to disambiguate identical adapters", () => {
    const remembered = { ...ch340, serialNumber: undefined, product: "Adapter B" };
    const other = { ...remembered, name: "COM7", product: "Adapter A" };
    const moved = { ...remembered, name: "COM8", product: "Adapter B" };
    expect(findReconnectPort([other, moved], remembered)?.name).toBe("COM8");
  });

  it("falls back to the same COM name", () => {
    const replaced = { ...ch340, serialNumber: "OTHER", vid: 0x9999 };
    expect(findReconnectPort([com1, replaced], ch340)?.name).toBe("COM5");
  });

  it("returns nothing when neither identity nor name matches", () => {
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
