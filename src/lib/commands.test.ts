import { describe, expect, it } from "vitest";
import type { QuickCommand } from "../types";
import {
  collectCategories,
  deleteCategory,
  mergeCommands,
  migrateCommandAppend,
  moveCategory,
  parseCommandText,
  renameCategory,
  resolveAppend,
  serializeCommands,
  UNCATEGORIZED_CATEGORY,
} from "./commands";
import { buildPayload } from "./format";

describe("parseCommandText", () => {
  it("parses name<TAB>command and name|command", () => {
    const result = parseCommandText("重启\treset\\r\\n\n查询版本|ver");
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toMatchObject({
      name: "重启",
      data: "reset\r\n",
      hex: false,
      append: "none",
    });
    expect(result.commands[1]).toMatchObject({
      name: "查询版本",
      data: "ver",
      append: "global",
    });
  });

  it("parses HEX: prefixes and comments", () => {
    const result = parseCommandText("# comment\n// comment\nHEX: 01 03 00 00\nAT+CSQ");
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toMatchObject({
      data: "01 03 00 00",
      hex: true,
      append: "global",
    });
    expect(result.commands[1]).toMatchObject({ name: "AT+CSQ", hex: false });
  });

  it("imports JSON exports", () => {
    const json = JSON.stringify({
      version: 1,
      commands: [
        { name: "a", data: "01", hex: true, append: "crlf" },
        { name: "b", data: "hello", hex: false, append: "none" },
        { name: "c", data: "world", hex: false },
      ],
    });
    const result = parseCommandText(json);
    expect(result.commands).toHaveLength(3);
    expect(result.commands[0]).toMatchObject({ hex: true, append: "crlf" });
    expect(result.commands[1]).toMatchObject({ data: "hello", append: "none" });
    expect(result.commands[2]).toMatchObject({ data: "world", append: "global" });
  });

  it("imports SSCOM sscom51.ini rows", () => {
    const ini = [
      "; SSCOM 设置文件",
      "N101=0,查询版本号,1000",
      "N1=A,AT^GT_CM=VERSION",
      "",
      "N102=1,重启,500",
      "N2=A,AT^GT_CM=RESET2",
      "N103=0,读寄存器,1000",
      "N3=H,01 03 00 00 00 01 84 0A",
      "N104=0,打开日记,1000",
      "N4=A,AT^GT_CM=LOG\x02255",
    ].join("\r\n");
    const result = parseCommandText(ini);
    expect(result.commands).toHaveLength(4);
    expect(result.commands[0]).toMatchObject({
      name: "查询版本号",
      data: "AT^GT_CM=VERSION",
      hex: false,
      delayMs: 1000,
      append: "global",
    });
    expect(result.commands[2]).toMatchObject({
      name: "读寄存器",
      hex: true,
      data: "01 03 00 00 00 01 84 0A",
      append: "global",
    });
    expect(result.commands[3]).toMatchObject({
      name: "打开日记",
      data: "AT^GT_CM=LOG,255",
    });
  });

  it("returns a warning for empty input", () => {
    const result = parseCommandText("   ");
    expect(result.commands).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects session files", () => {
    const text = [
      '{"type":"meta","version":1,"started":1}',
      '{"type":"rx","ts":1,"data":"AQID"}',
    ].join("\n");
    const result = parseCommandText(text);
    expect(result.commands).toHaveLength(0);
    expect(result.warnings[0]).toContain("会话文件");
  });
});

describe("migrateCommandAppend", () => {
  it("migrates old none commands to follow the send box", () => {
    const old = { id: "1", name: "a", data: "AT", hex: false, append: "none" as const, enabled: true };
    expect(migrateCommandAppend(old).append).toBe("global");
  });

  it("keeps none when the command already ends with a newline", () => {
    const old = { id: "1", name: "a", data: "AT\r\n", hex: false, append: "none" as const, enabled: true };
    expect(migrateCommandAppend(old).append).toBe("none");
  });
});

describe("resolveAppend", () => {
  it("uses the send box tail for imported SSCOM commands", () => {
    const ini = ["N101=0,CSQ,1000", "N1=A,AT+CSQ"].join("\r\n");
    const command = parseCommandText(ini).commands[0];
    const payload = buildPayload(command.data, command.hex, resolveAppend(command.append, "crlf"));
    expect(Array.from(payload.slice(-2))).toEqual([13, 10]);
  });

  it("keeps an explicit per-command tail", () => {
    expect(resolveAppend("lf", "crlf")).toBe("lf");
  });
});

describe("mergeCommands", () => {
  const ini = ["N101=0,CSQ,1000", "N1=A,AT+CSQ", "N102=0,VER,500", "N2=A,AT+CGMR"].join("\r\n");

  it("does not duplicate a re-imported sscom51.ini", () => {
    const parsed = parseCommandText(ini).commands;
    const first = mergeCommands([], parsed);
    expect(first.added).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.commands).toHaveLength(2);

    const second = mergeCommands(first.commands, parseCommandText(ini).commands);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(2);
    expect(second.commands).toHaveLength(2);
    expect(second.commands[0].append).toBe("global");
  });

  it("updates data but preserves an explicit append", () => {
    const existing = [
      { id: "1", name: "CSQ", data: "old", hex: false, append: "lf" as const, enabled: true },
    ];
    const merged = mergeCommands(existing, parseCommandText(ini).commands);
    expect(merged.commands[0].data).toBe("AT+CSQ");
    expect(merged.commands[0].append).toBe("lf");
  });
});

describe("serializeCommands", () => {
  it("drops internal ids", () => {
    const text = serializeCommands([
      { id: "x", name: "a", data: "01", hex: true, append: "none", enabled: true },
    ]);
    const parsed = JSON.parse(text);
    expect(parsed.commands[0].id).toBeUndefined();
    expect(parsed.commands[0].data).toBe("01");
  });
});

describe("collectCategories", () => {
  it("keeps empty stored categories and merges command categories", () => {
    const commands = [
      {
        id: "1",
        name: "a",
        data: "01",
        hex: false,
        append: "global" as const,
        enabled: true,
        category: "net",
      },
      {
        id: "2",
        name: "b",
        data: "02",
        hex: false,
        append: "global" as const,
        enabled: true,
      },
    ];
    expect(collectCategories([" net ", "net", "log", ""], commands)).toEqual([
      "未分类",
      "log",
      "net",
    ]);
  });

  it("falls back to 未分类 when nothing exists", () => {
    expect(collectCategories([], [])).toEqual(["未分类"]);
  });

  it("respects the persisted display order", () => {
    const commands = [command("1", "net"), command("2")];
    expect(collectCategories(["net", "log"], commands, ["log", "net"])).toEqual([
      "log",
      "net",
      "未分类",
    ]);
  });

  it("appends categories missing from the saved order", () => {
    const commands = [command("1", "net"), command("2", "log"), command("3")];
    expect(collectCategories([], commands, ["net"])).toEqual([
      "net",
      "未分类",
      "log",
    ]);
  });

  it("ignores stale names in the saved order", () => {
    expect(collectCategories(["net"], [], ["removed", "net"])).toEqual(["net"]);
  });
});

describe("moveCategory", () => {
  it("moves a category left and right", () => {
    expect(moveCategory(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveCategory(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("keeps the array unchanged at the edges", () => {
    const order = ["a", "b"];
    expect(moveCategory(order, "a", -1)).toBe(order);
    expect(moveCategory(order, "b", 1)).toBe(order);
  });

  it("ignores unknown categories", () => {
    const order = ["a", "b"];
    expect(moveCategory(order, "missing", 1)).toBe(order);
  });
});

function command(id: string, category?: string): QuickCommand {
  return {
    id,
    name: id,
    data: "AT",
    hex: false,
    append: "global",
    enabled: true,
    category,
  };
}

describe("renameCategory", () => {
  it("renames a category and moves its commands", () => {
    const result = renameCategory(
      [command("1", "net"), command("2", "log"), command("3")],
      ["net", "log", "empty"],
      "net",
      "network",
    );
    expect(result.categories).toEqual(["log", "empty", "network"]);
    expect(result.commands.map((item) => item.category)).toEqual([
      "network",
      "log",
      undefined,
    ]);
  });

  it("merges into an existing category without duplicating it", () => {
    const result = renameCategory(
      [command("1", "net")],
      ["net", "log"],
      "net",
      "log",
    );
    expect(result.categories).toEqual(["log"]);
    expect(result.commands[0].category).toBe("log");
  });

  it("moves commands into 未分类", () => {
    const result = renameCategory(
      [command("1", "net")],
      ["net"],
      "net",
      UNCATEGORIZED_CATEGORY,
    );
    expect(result.categories).toEqual([]);
    expect(result.commands[0].category).toBe(UNCATEGORIZED_CATEGORY);
  });
});

describe("deleteCategory", () => {
  it("moves commands to 未分类 when the category is removed", () => {
    const result = deleteCategory(
      [command("1", "net"), command("2", "log")],
      ["net", "log"],
      "net",
      "move",
    );
    expect(result.categories).toEqual(["log"]);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0].category).toBe(UNCATEGORIZED_CATEGORY);
  });

  it("removes commands together with the category", () => {
    const result = deleteCategory(
      [command("1", "net"), command("2", "log")],
      ["net", "log"],
      "net",
      "remove",
    );
    expect(result.commands.map((item) => item.id)).toEqual(["2"]);
    expect(result.categories).toEqual(["log"]);
  });

  it("removes an empty stored category", () => {
    const result = deleteCategory([], ["empty"], "empty", "move");
    expect(result.categories).toEqual([]);
  });
});
