import type { PointerEvent as ReactPointerEvent } from "react";
import type { KeywordColorRule, LogCounts, LogFilter, LogLevel } from "../types";
import { LEVELS, LEVEL_LABEL } from "../lib/elog";

const COLOR_PALETTE = [
  "#ff8a80",
  "#ffd08a",
  "#7ee787",
  "#79c0ff",
  "#f0a6ff",
  "#ffb86c",
  "#8be9fd",
  "#ff79c6",
];

interface Props {
  filter: LogFilter;
  counts: LogCounts;
  total: number;
  visible: number;
  width: number;
  elogMode: boolean;
  colorRules: KeywordColorRule[];
  onChange: (filter: LogFilter) => void;
  onReset: () => void;
  onWidthChange: (width: number) => void;
  onColorRulesChange: (rules: KeywordColorRule[]) => void;
}

export default function FilterPanel({
  filter,
  counts,
  total,
  visible,
  width,
  elogMode,
  colorRules,
  onChange,
  onReset,
  onWidthChange,
  onColorRulesChange,
}: Props) {
  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.classList.add("col-resizing");

    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(
        Math.min(360, Math.max(150, startWidth + (moveEvent.clientX - startX))),
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

  const toggleLevel = (level: LogLevel) => {
    const next = new Set(filter.levels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    onChange({ ...filter, levels: next });
  };

  const setLevels = (levels: LogLevel[]) => {
    onChange({ ...filter, levels: new Set(levels) });
  };

  const toggleTag = (tag: string) => {
    const next = new Set(filter.tags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange({ ...filter, tags: next });
  };

  const addColorRule = () => {
    onColorRulesChange([
      ...colorRules,
      {
        id: `kw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        keyword: "",
        color: COLOR_PALETTE[colorRules.length % COLOR_PALETTE.length],
      },
    ]);
  };

  const updateColorRule = (id: string, patch: Partial<KeywordColorRule>) => {
    onColorRulesChange(
      colorRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );
  };

  const removeColorRule = (id: string) => {
    onColorRulesChange(colorRules.filter((rule) => rule.id !== id));
  };

  return (
    <aside className="filter-pane">
      <div
        className="v-resizer right"
        title="拖动调整过滤面板宽度"
        onPointerDown={startResize}
      />
      <div className="pane-header">
        <span className="filter-heading">
          过滤
          <span className={`filter-mode ${elogMode ? "elog" : "raw"}`}>
            {elogMode ? "EasyLog" : "原始"}
          </span>
        </span>
        <button
          className="link-btn"
          onClick={onReset}
          title={elogMode ? "恢复全部级别、清空 Tag 与关键字" : "清空关键字过滤"}
        >
          重置
        </button>
      </div>

      {elogMode && (
        <div className="filter-section">
          <div className="filter-title">
            <span>级别</span>
            <span className="filter-actions">
              <button className="link-btn" onClick={() => setLevels(["A", "E", "W"])}>
                告警+
              </button>
              <button className="link-btn" onClick={() => setLevels(LEVELS)}>
                全部
              </button>
            </span>
          </div>
          <div className="level-list">
            {LEVELS.map((level) => (
              <label className={`level-item lvl-${level}`} key={level} title={LEVEL_LABEL[level]}>
                <input
                  type="checkbox"
                  checked={filter.levels.has(level)}
                  onChange={() => toggleLevel(level)}
                />
                <span className="level-letter">{level}</span>
                <span className="level-count">{counts.levels[level]}</span>
              </label>
            ))}
          </div>
          {filter.levels.size === 0 && <div className="filter-hint">所有级别都被隐藏了</div>}
        </div>
      )}

      {elogMode && (
        <div className="filter-section grow">
          <div className="filter-title">
            <span>Tag</span>
            {filter.tags.size > 0 ? (
              <button className="link-btn" onClick={() => onChange({ ...filter, tags: new Set() })}>
                清除 ({filter.tags.size})
              </button>
            ) : (
              <span className="level-count">{counts.tags.length}</span>
            )}
          </div>
          <div className="tag-list">
            {counts.tags.length === 0 && <div className="filter-hint">还没有解析到 Tag</div>}
            {counts.tags.map(({ tag, count }) => (
              <button
                key={tag}
                className={`tag-item ${filter.tags.has(tag) ? "active" : ""}`}
                onClick={() => toggleTag(tag)}
                title={filter.tags.has(tag) ? "取消该 Tag" : "只看该 Tag"}
              >
                <span className="tag-name">{tag}</span>
                <span className="level-count">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!elogMode && (
        <div className="filter-raw-note">
          原始模式：级别 / Tag 不参与过滤，按下方关键字和颜色规则原样显示。
        </div>
      )}

      <div className="filter-section">
        <div className="filter-title">
          <span>关键字着色</span>
          <button className="link-btn" onClick={addColorRule}>
            ＋ 添加
          </button>
        </div>
        <div className="color-rule-list">
          {colorRules.length === 0 && (
            <div className="filter-hint">
              {elogMode
                ? "添加关键字后整行使用该颜色，优先级高于级别颜色"
                : "添加关键字后，命中的整行按颜色显示"}
            </div>
          )}
          {colorRules.map((rule) => (
            <div className="color-rule" key={rule.id}>
              <input
                type="color"
                className="color-rule-swatch"
                value={rule.color}
                title="选择颜色"
                onChange={(e) => updateColorRule(rule.id, { color: e.target.value })}
              />
              <input
                className="color-rule-keyword"
                value={rule.keyword}
                placeholder="关键字，如 ERROR"
                onChange={(e) => updateColorRule(rule.id, { keyword: e.target.value })}
              />
              <button
                className="link-btn"
                title="删除这条颜色规则"
                onClick={() => removeColorRule(rule.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="filter-section">
        <div className="filter-title">
          <span>关键字</span>
          {filter.keyword && (
            <button className="link-btn" onClick={() => onChange({ ...filter, keyword: "" })}>
              清除
            </button>
          )}
        </div>
        <input
          className="filter-input"
          value={filter.keyword}
          placeholder="包含的文本，如 rollover"
          onChange={(e) => onChange({ ...filter, keyword: e.target.value })}
        />
        <div className="filter-checks">
          <label className="check">
            <input
              type="checkbox"
              checked={filter.regex}
              onChange={(e) => onChange({ ...filter, regex: e.target.checked })}
            />
            正则
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filter.invert}
              onChange={(e) => onChange({ ...filter, invert: e.target.checked })}
            />
            反向
          </label>
        </div>
      </div>

      <div className="filter-summary">
        显示 <b>{visible.toLocaleString()}</b> / {total.toLocaleString()}
        {elogMode && filter.tags.size > 0 && (
          <div className="filter-hint">Tag 过滤时隐藏未解析行</div>
        )}
      </div>
    </aside>
  );
}
