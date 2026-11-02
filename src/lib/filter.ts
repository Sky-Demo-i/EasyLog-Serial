import type { LogCounts, LogEntry, LogFilter, LogLevel } from "../types";
import { LEVELS } from "./elog";

export function createFilter(): LogFilter {
  return {
    levels: new Set(LEVELS),
    tags: new Set(),
    keyword: "",
    regex: false,
    invert: false,
  };
}

/** Whether the filter can hide rows in the current display mode. */
export function isFilterActive(filter: LogFilter, elogMode = true): boolean {
  if (filter.keyword.trim().length > 0) return true;
  if (!elogMode) return false;
  return filter.levels.size !== LEVELS.length || filter.tags.size > 0;
}

function makeKeywordMatcher(filter: LogFilter): (text: string) => boolean {
  const keyword = filter.keyword.trim();
  if (!keyword) return () => true;

  if (filter.regex) {
    try {
      const regex = new RegExp(keyword, "i");
      return (text) => regex.test(text);
    } catch {
      // Invalid regex: fall back to substring rather than hiding everything.
    }
  }
  const needle = keyword.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

export interface FilterResult {
  visible: LogEntry[];
  counts: LogCounts;
}

export function applyFilter(
  entries: LogEntry[],
  filter: LogFilter,
  elogMode = true,
): FilterResult {
  const levels: Record<LogLevel, number> = { A: 0, E: 0, W: 0, I: 0, D: 0, V: 0, "?": 0 };
  const tagCounts = new Map<string, number>();

  for (const entry of entries) {
    levels[entry.level] += 1;
    if (entry.tag) tagCounts.set(entry.tag, (tagCounts.get(entry.tag) ?? 0) + 1);
  }

  const tags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const matchKeyword = makeKeywordMatcher(filter);
  const hasTagFilter = filter.tags.size > 0;
  const visible: LogEntry[] = [];

  for (const entry of entries) {
    const hit = matchKeyword(entry.text);
    if (filter.invert ? hit : !hit) continue;

    if (elogMode) {
      if (entry.parsed) {
        if (!filter.levels.has(entry.level)) continue;
        if (hasTagFilter && !filter.tags.has(entry.tag)) continue;
      } else if (hasTagFilter) {
        // Raw/continuation lines are noise once the user filters by tag.
        continue;
      }
    }

    visible.push(entry);
  }

  return {
    visible,
    counts: { levels, tags, total: entries.length },
  };
}
