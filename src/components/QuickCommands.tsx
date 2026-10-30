import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { QuickCommand } from "../types";

interface Props {
  commands: QuickCommand[];
  connected: boolean;
  width: number;
  looping: boolean;
  onChange: (commands: QuickCommand[]) => void;
  onSend: (command: QuickCommand) => void;
  onSendAll: (commands: QuickCommand[]) => void;
  onStartLoop: () => void;
  onStopLoop: () => void;
  onLoad: (command: QuickCommand) => void;
  onImport: (text: string, filename: string) => void;
  onExport: () => void;
  onWidthChange: (width: number) => void;
}

const UNCATEGORIZED = "未分类";
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

export default function QuickCommands({
  commands,
  connected,
  width,
  looping,
  onChange,
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
  const [newCategoryFor, setNewCategoryFor] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftNameRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.classList.add("col-resizing");

    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(
        Math.min(620, Math.max(300, startWidth - (moveEvent.clientX - startX))),
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

  const categoryNames = Array.from(new Set(commands.map(categoryOf)));
  if (categoryNames.length === 0) categoryNames.push(UNCATEGORIZED);
  categoryNames.sort((a, b) =>
    a === UNCATEGORIZED ? -1 : b === UNCATEGORIZED ? 1 : a.localeCompare(b, "zh-CN"),
  );

  const categoryCounts = new Map<string, number>();
  for (const command of commands) {
    const category = categoryOf(command);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  const currentCategory = categoryNames.includes(activeCategory)
    ? activeCategory
    : categoryNames[0];

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

  const confirmNewCategory = () => {
    const name = newCategoryName.trim();
    if (!name || !newCategoryFor) return;
    update(newCategoryFor, { category: name });
    setActiveCategory(name);
    setNewCategoryFor(null);
    setNewCategoryName("");
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
          onClick={() => onSendAll(enabledCommands)}
          disabled={!connected || enabledCommands.length === 0}
          title="按列表顺序发送一次所有勾选指令"
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
          title="把所有指令的循环序号归 0"
        >
          全部归0
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

      <div className="quick-tabs" role="tablist" aria-label="指令分类">
        {categoryNames.map((category) => (
          <button
            key={category}
            type="button"
            role="tab"
            aria-selected={!needle && category === currentCategory}
            className={`quick-tab ${!needle && category === currentCategory ? "active" : ""}`}
            onClick={() => setActiveCategory(category)}
            title={category}
          >
            <span>{category}</span>
            <small>{categoryCounts.get(category) ?? 0}</small>
          </button>
        ))}
      </div>

      <div className="quick-page-bar">
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

      <div className="quick-list">
        {commands.length > 0 && pageItems.length === 0 && (
          <div className="quick-empty">
            {needle ? "没有匹配的指令" : "这个分类还没有指令"}
          </div>
        )}

        {pageItems.map((command) => (
          <div
            className={`quick-item ${command.enabled ? "" : "disabled"}`}
            key={command.id}
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
                    setNewCategoryFor(command.id);
                    setNewCategoryName("");
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
              <button
                type="button"
                className={`quick-hex ${command.hex ? "active" : ""}`}
                title={
                  command.hex
                    ? "当前按 HEX 发送，点击改为文本"
                    : "当前按文本发送，点击改为 HEX"
                }
                onClick={() => update(command.id, { hex: !command.hex })}
              >
                HEX
              </button>
              <button
                className="icon-btn"
                title="载入到发送框"
                onClick={() => onLoad(command)}
              >
                ↧
              </button>
              <button
                className="icon-btn"
                title="发送"
                disabled={!connected}
                onClick={() => onSend(command)}
              >
                ▶
              </button>
              <button
                className="icon-btn danger"
                title="删除"
                onClick={() => onChange(commands.filter((c) => c.id !== command.id))}
              >
                ×
              </button>
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
            </div>
          </div>
        ))}

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
        左侧页签切换分类 · 序号 1 起循环，0 不参与 · 每行可切 HEX/文本
      </div>

      {newCategoryFor && (
        <div
          className="quick-modal-backdrop"
          onPointerDown={() => setNewCategoryFor(null)}
        >
          <div className="quick-modal" onPointerDown={(e) => e.stopPropagation()}>
            <div className="quick-modal-title">新建分类</div>
            <input
              autoFocus
              value={newCategoryName}
              placeholder="例如：网络、日志、查询"
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmNewCategory();
                if (e.key === "Escape") setNewCategoryFor(null);
              }}
            />
            <div className="quick-modal-actions">
              <button onClick={confirmNewCategory} disabled={!newCategoryName.trim()}>
                确定
              </button>
              <button onClick={() => setNewCategoryFor(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
