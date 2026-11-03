import { useEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { QuickCommand } from "../types";
import {
  collectCategories,
  deleteCategory as removeCategory,
  moveCategory as reorderCategories,
  renameCategory,
  UNCATEGORIZED_CATEGORY,
} from "../lib/commands";

interface Props {
  commands: QuickCommand[];
  connected: boolean;
  width: number;
  looping: boolean;
  categories: string[];
  categoryOrder: string[];
  onChange: (commands: QuickCommand[]) => void;
  onCategoriesChange: (categories: string[]) => void;
  onCategoryOrderChange: (order: string[]) => void;
  onSend: (command: QuickCommand) => void;
  onSendAll: (commands: QuickCommand[]) => void;
  onStartLoop: () => void;
  onStopLoop: () => void;
  onLoad: (command: QuickCommand) => void;
  onImport: (text: string, filename: string) => void;
  onExport: () => void;
  onWidthChange: (width: number) => void;
}

const UNCATEGORIZED = UNCATEGORIZED_CATEGORY;
const AT_PREFIX = "AT^GT_CM=";

interface Draft {
  name: string;
  data: string;
}

const EMPTY_DRAFT: Draft = { name: "", data: "" };

function categoryOf(command: QuickCommand): string {
  return command.category?.trim() || UNCATEGORIZED;
}

function clampNumber(value: string, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(Number(value) || 0)));
}

function compactHex(value: string): string {
  return value.replace(/0x/gi, "").replace(/[\s,;:-]/g, "");
}

function looksLikeHex(value: string): boolean {
  const compact = compactHex(value);
  return compact.length > 0 && compact.length % 2 === 0 && /^[0-9a-f]+$/i.test(compact);
}

function normalizeHex(value: string): string {
  return compactHex(value)
    .match(/.{2}/g)
    ?.map((part) => part.toUpperCase())
    .join(" ") ?? "";
}

function textToHex(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function hexToText(value: string): string {
  const compact = compactHex(value);
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < compact.length; index += 2) {
    bytes[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export default function QuickCommands({
  commands,
  connected,
  width,
  looping,
  categories,
  categoryOrder,
  onChange,
  onCategoriesChange,
  onCategoryOrderChange,
  onSend,
  onSendAll,
  onStartLoop,
  onStopLoop,
  onLoad,
  onImport,
  onExport,
  onWidthChange,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [categoryDialog, setCategoryDialog] = useState<
    | { kind: "move"; commandId: string }
    | { kind: "create" }
    | { kind: "rename"; from: string }
    | null
  >(null);
  const [categoryName, setCategoryName] = useState("");
  const [deleteCategory, setDeleteCategory] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    after: boolean;
  } | null>(null);
  const [sortMenu, setSortMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    category: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftNameRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const quickListRef = useRef<HTMLDivElement>(null);
  const dragScrollDirRef = useRef(0);
  const dragScrollRafRef = useRef<number | null>(null);
  const pointerDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
    handleRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabMenu(null);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabMenu]);

  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.classList.add("col-resizing");

    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(
        Math.min(760, Math.max(300, startWidth - (moveEvent.clientX - startX))),
      );
      onWidthChange(next);
    };
    const end = () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const update = (id: string, patch: Partial<QuickCommand>) => {
    onChange(commands.map((command) => (command.id === id ? { ...command, ...patch } : command)));
  };

  const toggleHex = (command: QuickCommand) => {
    if (command.hex) {
      const data = looksLikeHex(command.data)
        ? hexToText(command.data)
        : command.data;
      update(command.id, { hex: false, data });
    } else {
      const data = looksLikeHex(command.data)
        ? normalizeHex(command.data)
        : textToHex(command.data);
      update(command.id, { hex: true, data });
    }
  };

  const draftFor = (category: string): Draft => drafts[category] ?? EMPTY_DRAFT;

  const patchDraft = (category: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({
      ...prev,
      [category]: { ...(prev[category] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  const addDraft = (category: string) => {
    const draft = draftFor(category);
    const raw = draft.data.trim();
    if (!raw) return;
    const body = raw.startsWith(AT_PREFIX) ? raw.slice(AT_PREFIX.length) : raw;
    if (!body.trim()) return;

    const command: QuickCommand = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: draft.name.trim() || body.slice(0, 24),
      data: raw,
      hex: false,
      append: "global",
      enabled: true,
      category,
      delayMs: 0,
      order: 0,
    };
    onChange([...commands, command]);
    setDrafts((prev) => ({
      ...prev,
      [category]: { name: "", data: "" },
    }));
    requestAnimationFrame(() => draftNameRefs.current[category]?.focus());
  };

  const categoryNames = collectCategories(categories, commands, categoryOrder);

  const categoryCounts = new Map<string, number>();
  for (const command of commands) {
    const category = categoryOf(command);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const deleteCount = deleteCategory ? categoryCounts.get(deleteCategory) ?? 0 : 0;
  const menuIndex = tabMenu ? categoryNames.indexOf(tabMenu.category) : -1;

  const currentCategory = categoryNames.includes(activeCategory)
    ? activeCategory
    : categoryNames[0];

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentCategory]);

  const needle = query.trim().toLowerCase();
  const filtered = commands.filter((command) => {
    if (!needle) return true;
    return (
      command.name.toLowerCase().includes(needle) ||
      command.data.toLowerCase().includes(needle) ||
      categoryOf(command).toLowerCase().includes(needle)
    );
  });

  const pageItems = needle
    ? filtered
    : filtered.filter((command) => categoryOf(command) === currentCategory);

  const enabledCommands = commands.filter((command) => command.enabled);
  const pageEnabled = pageItems.filter((command) => command.enabled);
  const loopCount = enabledCommands.filter((command) => (command.order ?? 0) > 0).length;

  const selectPage = (enabled: boolean) => {
    const ids = new Set(pageItems.map((command) => command.id));
    onChange(
      commands.map((command) =>
        ids.has(command.id) ? { ...command, enabled } : command,
      ),
    );
  };

  const resetOrder = () => {
    onChange(commands.map((command) => ({ ...command, order: 0 })));
    if (looping) onStopLoop();
  };

  const stopDragScroll = () => {
    dragScrollDirRef.current = 0;
    if (dragScrollRafRef.current !== null) {
      window.cancelAnimationFrame(dragScrollRafRef.current);
      dragScrollRafRef.current = null;
    }
  };

  const updateDropAt = (clientX: number, clientY: number) => {
    const drag = pointerDragRef.current;
    if (!drag?.active) return;
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const row = element?.closest(".quick-item") as HTMLElement | null;
    if (row?.dataset.id) {
      const dragged = commands.find((command) => command.id === drag.id);
      const target = commands.find((command) => command.id === row.dataset.id);
      if (
        !dragged ||
        !target ||
        dragged.id === target.id ||
        categoryOf(dragged) !== categoryOf(target)
      ) {
        setDropTarget(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      const after = clientY > rect.top + rect.height / 2;
      setDropTarget((prev) =>
        prev?.id === target.id && prev.after === after
          ? prev
          : { id: target.id, after },
      );
      return;
    }
    if (element?.closest(".quick-drop-tail")) {
      setDropTarget({ id: "__tail__", after: true });
      return;
    }
    setDropTarget(null);
  };

  const updateDragScroll = (clientY: number) => {
    const list = quickListRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const edge = 42;
    let direction = 0;
    if (clientY < rect.top + edge) direction = -1;
    else if (clientY > rect.bottom - edge) direction = 1;
    if (dragScrollDirRef.current === direction) return;
    dragScrollDirRef.current = direction;
    if (direction === 0) {
      if (dragScrollRafRef.current !== null) {
        window.cancelAnimationFrame(dragScrollRafRef.current);
        dragScrollRafRef.current = null;
      }
      return;
    }
    if (dragScrollRafRef.current !== null) return;
    const tick = () => {
      const current = dragScrollDirRef.current;
      if (current === 0) {
        dragScrollRafRef.current = null;
        return;
      }
      list.scrollTop += current * 16;
      const drag = pointerDragRef.current;
      if (drag) updateDropAt(drag.lastX, drag.lastY);
      dragScrollRafRef.current = window.requestAnimationFrame(tick);
    };
    dragScrollRafRef.current = window.requestAnimationFrame(tick);
  };

  const clearDrag = () => {
    pointerDragRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    stopDragScroll();
    document.body.classList.remove("quick-dragging");
  };

  const reorderCommand = (dragId: string, targetId: string, after: boolean) => {
    const dragged = commands.find((command) => command.id === dragId);
    const target = commands.find((command) => command.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;
    if (categoryOf(dragged) !== categoryOf(target)) return;
    const rest = commands.filter((command) => command.id !== dragId);
    const targetIndex = rest.findIndex((command) => command.id === targetId);
    if (targetIndex < 0) return;
    rest.splice(targetIndex + (after ? 1 : 0), 0, dragged);
    onChange(rest);
  };

  const moveCommandToEdge = (command: QuickCommand, edge: "top" | "bottom") => {
    const category = categoryOf(command);
    const rest = commands.filter((item) => item.id !== command.id);
    const categoryItems = rest.filter((item) => categoryOf(item) === category);
    if (categoryItems.length === 0) return;
    const insertAt =
      edge === "top"
        ? rest.findIndex((item) => categoryOf(item) === category)
        : rest.findIndex(
            (item) => item.id === categoryItems[categoryItems.length - 1].id,
          ) + 1;
    rest.splice(insertAt, 0, command);
    onChange(rest);
  };

  const moveCommand = (command: QuickCommand, delta: number) => {
    const category = categoryOf(command);
    const ids = commands
      .filter((item) => categoryOf(item) === category)
      .map((item) => item.id);
    const from = ids.indexOf(command.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    reorderCommand(command.id, ids[to], delta > 0);
  };

  const openSortMenu = (command: QuickCommand, rect: DOMRect) => {
    const width = 132;
    const height = 156;
    const x = Math.min(
      window.innerWidth - width - 8,
      Math.max(8, rect.right - width),
    );
    const below = rect.bottom + 4;
    const y =
      below + height <= window.innerHeight
        ? below
        : Math.max(8, rect.top - height - 4);
    setSortMenu({ id: command.id, x, y });
  };

  const removePointerListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerCancel);
  };

  const handlePointerMove = (event: PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.active) {
      if (
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5
      ) {
        return;
      }
      drag.active = true;
      setDraggingId(drag.id);
      document.body.classList.add("quick-dragging");
    }
    event.preventDefault();
    updateDropAt(event.clientX, event.clientY);
    updateDragScroll(event.clientY);
  };

  const handlePointerUp = (event: PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    removePointerListeners();
    if (!drag.active) {
      const command = commands.find((item) => item.id === drag.id);
      clearDrag();
      if (command) openSortMenu(command, drag.handleRect);
      return;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const row = element?.closest(".quick-item") as HTMLElement | null;
    if (row?.dataset.id) {
      const rect = row.getBoundingClientRect();
      reorderCommand(
        drag.id,
        row.dataset.id,
        event.clientY > rect.top + rect.height / 2,
      );
    } else if (element?.closest(".quick-drop-tail")) {
      const command = commands.find((item) => item.id === drag.id);
      if (command) moveCommandToEdge(command, "bottom");
    }
    clearDrag();
  };

  const handlePointerCancel = () => {
    removePointerListeners();
    clearDrag();
  };

  const startPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    command: QuickCommand,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    pointerDragRef.current = {
      id: command.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      handleRect: event.currentTarget.getBoundingClientRect(),
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  };

  useEffect(() => {
    if (!sortMenu) return;
    const close = () => setSortMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [sortMenu]);

  useEffect(
    () => () => {
      stopDragScroll();
      removePointerListeners();
    },
    [],
  );

  const openCategoryDialog = (
    mode:
      | { kind: "move"; commandId: string }
      | { kind: "create" }
      | { kind: "rename"; from: string },
  ) => {
    setCategoryDialog(mode);
    setCategoryName(mode.kind === "rename" ? mode.from : "");
  };

  const closeCategoryDialog = () => {
    setCategoryDialog(null);
    setCategoryName("");
  };

  const confirmCategoryDialog = () => {
    const name = categoryName.trim();
    if (!name || !categoryDialog) return;

    if (categoryDialog.kind === "rename") {
      const from = categoryDialog.from;
      if (name === from) {
        closeCategoryDialog();
        return;
      }
      const result = renameCategory(commands, categories, from, name);
      onCategoriesChange(result.categories);
      onChange(result.commands);
      if (categoryOrder.length > 0) {
        onCategoryOrderChange(
          Array.from(
            new Set(categoryNames.map((item) => (item === from ? name : item))),
          ),
        );
      }
      setDrafts((prev) => {
        if (!(from in prev)) return prev;
        const { [from]: draft, ...rest } = prev;
        return { ...rest, [name]: draft };
      });
      setActiveCategory(name);
      setQuery("");
      closeCategoryDialog();
      return;
    }

    if (!categoryNames.includes(name)) {
      onCategoriesChange([...categories, name]);
      if (categoryOrder.length > 0) {
        onCategoryOrderChange([...categoryNames, name]);
      }
    }
    if (categoryDialog.kind === "move") {
      update(categoryDialog.commandId, { category: name });
    }
    setActiveCategory(name);
    setQuery("");
    closeCategoryDialog();
  };

  const openDeleteCategory = (name: string) => {
    if (name === UNCATEGORIZED) return;
    setTabMenu(null);
    setDeleteCategory(name);
  };

  const confirmDeleteCategory = (removeCommands: boolean) => {
    const name = deleteCategory;
    if (!name) return;
    const result = removeCategory(
      commands,
      categories,
      name,
      removeCommands ? "remove" : "move",
    );
    onChange(result.commands);
    onCategoriesChange(result.categories);
    if (categoryOrder.length > 0) {
      onCategoryOrderChange(categoryNames.filter((item) => item !== name));
    }
    setDrafts((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (currentCategory === name) setActiveCategory(UNCATEGORIZED);
    setQuery("");
    setDeleteCategory(null);
  };

  const openTabMenu = (event: ReactMouseEvent, category: string) => {
    event.preventDefault();
    event.stopPropagation();
    setTabMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 230),
      category,
    });
  };

  const shiftCategory = (name: string, delta: number) => {
    const next = reorderCategories(categoryNames, name, delta);
    if (next !== categoryNames) onCategoryOrderChange(next);
  };

  return (
    <aside className="quick-pane">
      <div
        className="v-resizer"
        title="拖动调整快捷指令面板宽度"
        onPointerDown={startResize}
      />
      <div className="pane-header">
        <span>快捷指令</span>
        <span className="counter">{commands.length}</span>
      </div>

      <div className="quick-toolbar">
        <button onClick={() => fileRef.current?.click()} title="从 txt / json / sscom51.ini 导入">
          导入
        </button>
        <button onClick={onExport} disabled={commands.length === 0} title="导出为 JSON">
          导出
        </button>
        <button
          onClick={() => onSendAll(pageEnabled)}
          disabled={!connected || pageEnabled.length === 0}
          title="按列表顺序发送当前分类页里勾选的指令"
        >
          发送勾选
        </button>
        <button
          className={looping ? "rec-btn recording" : ""}
          onClick={looping ? onStopLoop : onStartLoop}
          disabled={!connected || (!looping && loopCount === 0)}
          title="按序号循环发送；序号 0 不参与"
        >
          {looping ? "停止循环" : "循环发送"}
        </button>
        <button
          onClick={resetOrder}
          disabled={!commands.some((command) => (command.order ?? 0) !== 0)}
          title="把所有指令的循环序号设为 0（不参与循环）"
        >
          序号清零
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.json,.csv,.ini,text/plain,application/json"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const buffer = await file.arrayBuffer();
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            } catch {
              try {
                text = new TextDecoder("gbk").decode(buffer);
              } catch {
                text = new TextDecoder("utf-8").decode(buffer);
              }
            }
            onImport(text.replace(/^\uFEFF/, ""), file.name);
          }}
        />
      </div>

      <div className="quick-search">
        <input
          value={query}
          placeholder="搜索名称 / 指令 / 分类…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="link-btn" onClick={() => setQuery("")}>
            清除
          </button>
        )}
      </div>

      <div
        className="quick-tabs"
        role="tablist"
        aria-label="指令分类"
        onContextMenu={(event) => openTabMenu(event, currentCategory)}
      >
        {categoryNames.map((category) => (
          <button
            key={category}
            type="button"
            role="tab"
            ref={!needle && category === currentCategory ? activeTabRef : undefined}
            aria-selected={!needle && category === currentCategory}
            className={`quick-tab ${!needle && category === currentCategory ? "active" : ""}`}
            onClick={() => setActiveCategory(category)}
            onContextMenu={(event) => openTabMenu(event, category)}
            title={`${category}｜右击可排序、重命名或删除分类`}
          >
            <span>{category}</span>
            <small>{categoryCounts.get(category) ?? 0}</small>
          </button>
        ))}
      </div>

      <div
        className="quick-page-bar"
        onContextMenu={(event) => openTabMenu(event, currentCategory)}
      >
        <span className="quick-page-title">
          {needle ? "搜索结果" : currentCategory}
        </span>
        <span className="quick-page-count">
          {pageItems.length} 条 / 已选 {pageItems.filter((command) => command.enabled).length}
        </span>
        <span className="spacer" />
        <button
          className="link-btn"
          onClick={() => selectPage(true)}
          disabled={pageItems.length === 0}
        >
          {needle ? "全选结果" : "全选本类"}
        </button>
        <button
          className="link-btn"
          onClick={() => selectPage(false)}
          disabled={pageItems.length === 0}
        >
          {needle ? "取消结果" : "取消本类"}
        </button>
      </div>

      <div className="quick-list" ref={quickListRef}>
        {commands.length > 0 && pageItems.length === 0 && (
          <div className="quick-empty">
            {needle ? "没有匹配的指令" : "这个分类还没有指令"}
          </div>
        )}

        {pageItems.map((command) => (
          <div
            className={`quick-item ${command.enabled ? "" : "disabled"} ${
              draggingId === command.id ? "dragging" : ""
            } ${
              dropTarget?.id === command.id
                ? dropTarget.after
                  ? "drop-after"
                  : "drop-before"
                : ""
            }`}
            key={command.id}
            data-id={command.id}
            title={`双击载入到发送框｜分类：${categoryOf(command)}｜${
              command.append === "global" ? "跟随发送框结尾" : `结尾 ${command.append}`
            }`}
            onDoubleClick={() => onLoad(command)}
          >
            <div className="quick-item-top">
              <input
                type="checkbox"
                checked={command.enabled}
                title="参与发送勾选 / 循环发送"
                onChange={(e) => update(command.id, { enabled: e.target.checked })}
              />
              <select
                className="quick-cat"
                value={categoryOf(command)}
                title="移动到分类"
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    openCategoryDialog({ kind: "move", commandId: command.id });
                    return;
                  }
                  update(command.id, { category: e.target.value });
                }}
              >
                {categoryNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value="__new__">＋ 新建…</option>
              </select>
              <input
                className="quick-name"
                value={command.name}
                onChange={(e) => update(command.id, { name: e.target.value })}
                onDoubleClick={(e) => e.stopPropagation()}
                title="指令名称（可编辑）"
              />
              <span
                className="quick-order-wrap"
                title="循环发送序号：1、2、3… 相同序号按列表前后执行；0 不参与"
              >
                <span>#</span>
                <input
                  className="quick-order"
                  type="number"
                  min={0}
                  max={9999}
                  step={1}
                  value={command.order ?? 0}
                  aria-label="循环发送序号"
                  onDoubleClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    update(command.id, { order: clampNumber(e.target.value, 9999) })
                  }
                />
              </span>
              <span className="quick-delay-wrap" title="发送完成后等待的时间">
                <input
                  className="quick-delay"
                  type="number"
                  min={0}
                  max={10000}
                  step={50}
                  value={command.delayMs ?? 0}
                  aria-label="发送后延时（毫秒）"
                  onDoubleClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    update(command.id, { delayMs: clampNumber(e.target.value, 10000) })
                  }
                />
                <span>ms</span>
              </span>
              <button
                type="button"
                className={`quick-hex ${command.hex ? "active" : ""}`}
                title={
                  command.hex
                    ? "当前按 HEX 发送，点击改为文本"
                    : "当前按文本发送，点击改为 HEX"
                }
                onClick={() => toggleHex(command)}
              >
                HEX
              </button>
              <button
                type="button"
                className="quick-send"
                title="发送这条指令"
                disabled={!connected}
                onClick={() => onSend(command)}
              >
                发送
              </button>
              <button
                className="icon-btn"
                title="载入到发送框"
                onClick={() => onLoad(command)}
              >
                ↧
              </button>
              <button
                className="icon-btn danger"
                title="删除"
                onClick={() => onChange(commands.filter((c) => c.id !== command.id))}
              >
                ×
              </button>
              <span
                className="quick-drag"
                tabIndex={0}
                title="拖动排序；单击打开快速移动菜单；Alt+↑/↓ 微调，Ctrl+Home/End 置顶/置底"
                onPointerDown={(e) => startPointerDrag(e, command)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSortMenu(command, e.currentTarget.getBoundingClientRect());
                }}
                onKeyDown={(e) => {
                  if (e.altKey && e.key === "ArrowUp") {
                    e.preventDefault();
                    moveCommand(command, -1);
                  } else if (e.altKey && e.key === "ArrowDown") {
                    e.preventDefault();
                    moveCommand(command, 1);
                  } else if (e.ctrlKey && e.key === "Home") {
                    e.preventDefault();
                    moveCommandToEdge(command, "top");
                  } else if (e.ctrlKey && e.key === "End") {
                    e.preventDefault();
                    moveCommandToEdge(command, "bottom");
                  }
                }}
              >
                ⋮⋮
              </span>
            </div>
            <div className="quick-item-sub">
              <input
                className={`quick-data ${command.hex ? "hex" : ""}`}
                value={command.data}
                spellCheck={false}
                onChange={(e) => update(command.id, { data: e.target.value })}
                onDoubleClick={(e) => e.stopPropagation()}
                title={`${command.data}\n\n可直接编辑；回车载入到发送框`}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onLoad(command);
                  }
                }}
              />
            </div>
          </div>
        ))}

        {draggingId && (
          <div
            className={`quick-drop-tail ${
              dropTarget?.id === "__tail__" ? "active" : ""
            }`}
          >
            拖到这里移到本类末尾
          </div>
        )}

        {!needle && (
          <div className="quick-new">
            <span className="quick-new-plus">＋</span>
            <input
              ref={(element) => {
                draftNameRefs.current[currentCategory] = element;
              }}
              className="quick-name"
              value={draftFor(currentCategory).name}
              placeholder="新指令名称（可留空）"
              onChange={(e) => patchDraft(currentCategory, { name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft(currentCategory);
                }
              }}
            />
            <input
              className="quick-data quick-new-data"
              value={draftFor(currentCategory).data}
              spellCheck={false}
              placeholder="指令内容（HEX 也可先添加再切换）"
              onChange={(e) => patchDraft(currentCategory, { data: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft(currentCategory);
                }
              }}
            />
            <button
              className="quick-new-add"
              disabled={!draftFor(currentCategory).data.trim()}
              onClick={() => addDraft(currentCategory)}
            >
              添加
            </button>
          </div>
        )}
      </div>

      <div className="quick-hint">
        左侧页签切换分类 · 拖动行尾 ⋮⋮ 排序（Alt+↑↓ 微调，Ctrl+Home/End 置顶/置底） · 序号 1 起循环，0 不参与
      </div>

      {categoryDialog && (
        <div className="quick-modal-backdrop" onPointerDown={closeCategoryDialog}>
          <div className="quick-modal" onPointerDown={(e) => e.stopPropagation()}>
            <div className="quick-modal-title">
              {categoryDialog.kind === "rename" ? "重命名分类" : "新建分类"}
            </div>
            <input
              autoFocus
              value={categoryName}
              placeholder={
                categoryDialog.kind === "rename"
                  ? "输入新的分类名"
                  : "例如：网络、日志、查询"
              }
              onChange={(e) => setCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmCategoryDialog();
                if (e.key === "Escape") closeCategoryDialog();
              }}
            />
            <div className="quick-modal-actions">
              <button onClick={confirmCategoryDialog} disabled={!categoryName.trim()}>
                确定
              </button>
              <button onClick={closeCategoryDialog}>取消</button>
            </div>
          </div>
        </div>
      )}

      {deleteCategory && (
        <div
          className="quick-modal-backdrop"
          onPointerDown={() => setDeleteCategory(null)}
        >
          <div
            className="quick-modal quick-modal-wide"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="quick-modal-title">删除分类「{deleteCategory}」</div>
            <div className="quick-modal-note">
              {deleteCount > 0
                ? `该分类下有 ${deleteCount} 条指令。可以把它们移到“未分类”，或连同分类一起删除。`
                : "该分类为空，删除后不可恢复。"}
            </div>
            <div className="quick-modal-actions">
              {deleteCount > 0 && (
                <button onClick={() => confirmDeleteCategory(false)}>移到未分类</button>
              )}
              <button className="danger" onClick={() => confirmDeleteCategory(true)}>
                {deleteCount > 0 ? "连同指令删除" : "删除分类"}
              </button>
              <button onClick={() => setDeleteCategory(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {tabMenu && (
        <div
          className="quick-tab-menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="quick-tab-menu-head" title={tabMenu.category}>
            {tabMenu.category}
            {tabMenu.category === UNCATEGORIZED ? "（默认）" : ""}
          </div>
          <button
            type="button"
            disabled={menuIndex <= 0}
            title="把这个分类向左移动"
            onClick={() => shiftCategory(tabMenu.category, -1)}
          >
            ← 左移
          </button>
          <button
            type="button"
            disabled={menuIndex < 0 || menuIndex >= categoryNames.length - 1}
            title="把这个分类向右移动"
            onClick={() => shiftCategory(tabMenu.category, 1)}
          >
            右移 →
          </button>
          <span className="quick-tab-menu-sep" />
          <button
            type="button"
            disabled={tabMenu.category === UNCATEGORIZED}
            title={
              tabMenu.category === UNCATEGORIZED
                ? "默认分类不可重命名"
                : "重命名这个分类"
            }
            onClick={() => {
              const category = tabMenu.category;
              setTabMenu(null);
              if (category !== UNCATEGORIZED) {
                openCategoryDialog({ kind: "rename", from: category });
              }
            }}
          >
            重命名分类
          </button>
          <button
            type="button"
            className="danger"
            disabled={tabMenu.category === UNCATEGORIZED}
            title={
              tabMenu.category === UNCATEGORIZED
                ? "默认分类不可删除"
                : "删除这个分类"
            }
            onClick={() => openDeleteCategory(tabMenu.category)}
          >
            删除分类
          </button>
          <span className="quick-tab-menu-sep" />
          <button
            type="button"
            onClick={() => {
              setTabMenu(null);
              openCategoryDialog({ kind: "create" });
            }}
          >
            ＋ 新建分类页
          </button>
        </div>
      )}
      {sortMenu &&
        (() => {
          const command = commands.find((item) => item.id === sortMenu.id);
          if (!command) return null;
          return (
            <div
              className="quick-sort-menu"
              style={{ left: sortMenu.x, top: sortMenu.y }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="quick-sort-title" title={command.name}>
                {command.name || "未命名指令"}
              </div>
              <button
                type="button"
                onClick={() => {
                  moveCommandToEdge(command, "top");
                  setSortMenu(null);
                }}
              >
                移到顶部
              </button>
              <button
                type="button"
                onClick={() => {
                  moveCommand(command, -1);
                  setSortMenu(null);
                }}
              >
                上移一位
              </button>
              <button
                type="button"
                onClick={() => {
                  moveCommand(command, 1);
                  setSortMenu(null);
                }}
              >
                下移一位
              </button>
              <button
                type="button"
                onClick={() => {
                  moveCommandToEdge(command, "bottom");
                  setSortMenu(null);
                }}
              >
                移到底部
              </button>
            </div>
          );
        })()}
    </aside>
  );
}
