import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { QuickCommand } from "../types";

interface Props {
  commands: QuickCommand[];
  connected: boolean;
  width: number;
  onChange: (commands: QuickCommand[]) => void;
  onSend: (command: QuickCommand) => void;
  onSendAll: (commands: QuickCommand[]) => void;
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

function formatDelay(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

export default function QuickCommands({
  commands,
  connected,
  width,
  onChange,
  onSend,
  onSendAll,
  onLoad,
  onImport,
  onExport,
  onWidthChange,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
        Math.min(560, Math.max(260, startWidth - (moveEvent.clientX - startX))),
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

    const data = raw;
    const name = draft.name.trim() || body.slice(0, 24);
    const command: QuickCommand = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      data,
      hex: false,
      append: "global",
      enabled: true,
      category,
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

  const needle = query.trim().toLowerCase();
  const filtered = commands.filter((command) => {
    if (activeCategory && categoryOf(command) !== activeCategory) return false;
    if (!needle) return true;
    return (
      command.name.toLowerCase().includes(needle) ||
      command.data.toLowerCase().includes(needle) ||
      categoryOf(command).toLowerCase().includes(needle)
    );
  });

  const groups = categoryNames
    .map((category) => ({
      category,
      items: filtered.filter((command) => categoryOf(command) === category),
    }))
    .filter(
      (group) =>
        group.items.length > 0 ||
        (commands.length === 0 &&
          !needle &&
          !activeCategory &&
          group.category === UNCATEGORIZED),
    );

  const toggleCollapse = (category: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const confirmNewCategory = () => {
    const name = newCategoryName.trim();
    if (!name || !newCategoryFor) return;
    update(newCategoryFor, { category: name });
    setActiveCategory(name);
    setNewCategoryFor(null);
    setNewCategoryName("");
  };

  const sendable = filtered.filter((command) => command.enabled);

  return (
    <aside className="quick-pane">
      <div
        className="v-resizer"
        title="拖动调整快捷指令面板宽度"
        onPointerDown={startResize}
      />
      <div className="pane-header">
        <span>快捷指令</span>
        <span className="counter">
          {needle || activeCategory ? `${filtered.length}/${commands.length}` : commands.length}
        </span>
      </div>

      <div className="quick-toolbar">
        <button onClick={() => fileRef.current?.click()} title="从 txt / json / sscom51.ini 导入">
          导入
        </button>
        <button onClick={onExport} disabled={commands.length === 0} title="导出为 JSON">
          导出
        </button>
        <button
          onClick={() => onSendAll(sendable)}
          disabled={!connected || sendable.length === 0}
          title={
            activeCategory
              ? `发送“${activeCategory}”里勾选的指令`
              : "依次发送当前列表里勾选的指令"
          }
        >
          发送勾选
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

      <div className="quick-cat-bar">
        <select
          value={activeCategory}
          onChange={(e) => setActiveCategory(e.target.value)}
          title="按分类抽屉筛选"
        >
          <option value="">全部分类（{commands.length}）</option>
          {categoryNames.map((category) => (
            <option key={category} value={category}>
              {category}（{categoryCounts.get(category) ?? 0}）
            </option>
          ))}
        </select>
        {activeCategory && (
          <button className="link-btn" onClick={() => setActiveCategory("")}>
            全部
          </button>
        )}
      </div>

      <div className="quick-list">
        {commands.length > 0 && filtered.length === 0 && (
          <div className="quick-empty">没有匹配的指令</div>
        )}

        {groups.map(({ category, items }) => {
          const isCollapsed = !needle && collapsed.has(category);
          const draft = draftFor(category);
          return (
            <div className="quick-group" key={category}>
              <button
                className="quick-group-header"
                onClick={() => toggleCollapse(category)}
                title={isCollapsed ? "展开" : "收起"}
              >
                <span className="group-arrow">{isCollapsed ? "▸" : "▾"}</span>
                <span className="group-name">{category}</span>
                <span className="group-count">{items.length}</span>
              </button>

              {!isCollapsed &&
                items.map((command) => (
                  <div
                    className={`quick-item ${command.enabled ? "" : "disabled"}`}
                    key={command.id}
                    title={`双击载入到发送框｜分类：${categoryOf(command)}｜${
                      command.append === "global" ? "跟随发送框结尾" : `结尾 ${command.append}`
                    }${command.delayMs ? `｜延时 ${command.delayMs}ms` : ""}`}
                    onDoubleClick={() => onLoad(command)}
                  >
                    <input
                      type="checkbox"
                      checked={command.enabled}
                      title="参与“全部发送”"
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
                    <input
                      className="quick-data"
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
                    {command.hex && (
                      <span className="badge hex" title="HEX 发送">
                        H
                      </span>
                    )}
                    {command.delayMs && command.delayMs !== 1000 ? (
                      <span className="badge" title={`发送后延时 ${command.delayMs}ms`}>
                        {formatDelay(command.delayMs)}
                      </span>
                    ) : null}
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
                ))}

              {!isCollapsed && !needle && (
                <div className="quick-new">
                  <span className="quick-new-plus">＋</span>
                  <input
                    ref={(element) => {
                      draftNameRefs.current[category] = element;
                    }}
                    className="quick-name"
                    value={draft.name}
                    placeholder="新指令名称（可留空）"
                    onChange={(e) => patchDraft(category, { name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDraft(category);
                      }
                    }}
                  />
                  <input
                    className="quick-data quick-new-data"
                    value={draft.data}
                    spellCheck={false}
                    placeholder="指令内容"
                    onChange={(e) => patchDraft(category, { data: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDraft(category);
                      }
                    }}
                  />
                  <button
                    className="quick-new-add"
                    disabled={!draft.data.trim()}
                    onClick={() => addDraft(category)}
                  >
                    添加
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="quick-hint">点分类标题折叠 · 行首分类可移动/新建 · 指令可直接编辑</div>

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
