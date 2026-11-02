import type { PortInfo } from "../types";

/**
 * Find the same USB device after unplug/replug. Serial number wins, then a
 * unique VID/PID, then the same COM name as a last resort.
 */
export function findReconnectPort(
  ports: PortInfo[],
  remembered: PortInfo,
): PortInfo | undefined {
  const serial = remembered.serialNumber?.trim();
  if (serial) {
    const match = ports.find((port) => port.serialNumber?.trim() === serial);
    if (match) return match;
  }

  if (remembered.vid !== undefined && remembered.pid !== undefined) {
    const sameIds = ports.filter(
      (port) => port.vid === remembered.vid && port.pid === remembered.pid,
    );
    if (sameIds.length === 1) return sameIds[0];
    if (sameIds.length > 1) {
      const product = remembered.product?.trim();
      if (product) {
        const byProduct = sameIds.filter((port) => port.product?.trim() === product);
        if (byProduct.length === 1) return byProduct[0];
      }
      const manufacturer = remembered.manufacturer?.trim();
      if (manufacturer) {
        const byManufacturer = sameIds.filter(
          (port) => port.manufacturer?.trim() === manufacturer,
        );
        if (byManufacturer.length === 1) return byManufacturer[0];
      }
    }
  }

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
