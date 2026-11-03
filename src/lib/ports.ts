import type { PortInfo } from "../types";

/**
 * Auto-reconnect must stay on the exact COM port that disappeared. USB
 * VID/PID and product strings are not unique (two CH340 adapters can share
 * them), so following them can silently reconnect another device such as a
 * different AT port. Only the same COM name is safe.
 */
export function findReconnectPort(
  ports: PortInfo[],
  remembered: PortInfo,
): PortInfo | undefined {
  return ports.find((port) => port.name === remembered.name);
}

/**
 * Keep the last port selected while a device is reconnecting. Otherwise a
 * refresh would silently switch to the first available port (often COM1).
 */
export function nextPortSelection(
  current: string,
  ports: PortInfo[],
  keepMissing: boolean,
): string {
  if (current && ports.some((port) => port.name === current)) return current;
  if (keepMissing) return current;
  return ports[0]?.name ?? "";
}
