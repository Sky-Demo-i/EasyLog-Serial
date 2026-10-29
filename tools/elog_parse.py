#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EasyLogger 日志行解析器（参考实现 / 格式验证原型）

用途：
  1. 验证 EasyLogger 在真实设备上的输出格式能否被稳定解析；
  2. 作为上位机解析模块的“可执行规格”，后续可 1:1 移植到 Rust / C++ / C#；
  3. 直接用来分析已经抓下来的串口日志文件。

支持的输入形态：
  - 设备原始输出（含 ANSI 颜色，行尾 \\r\\n / \\n / \\r）
  - 被串口助手加了前缀的抓包，如： [16:02:22.722]收←◆<ESC>[34;22mV/TRK ...
  - ESC 被终端吞掉、只剩 "[34;22m" 的“残缺”日志（仅在行首兼容）

典型行：
  <ESC>[34;22mV/TRK    (185 jm_pal_get_utc_time)[480],1970-1-1 8:32:54, 480<ESC>[0m
  <ESC>[32;22mD/TRK    (255 track_master_rollover_norm_check)x:y:z=1:22:20 ...<ESC>[0m

用法：
  python elog_parse.py --demo
  python elog_parse.py capture.txt
  python elog_parse.py capture.txt --json
  python elog_parse.py --selftest
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from typing import Iterator, Optional

ESC = "\x1b"

# ---------------------------------------------------------------------------
# ANSI 处理
# ---------------------------------------------------------------------------

# CSI 序列：ESC [ 参数字节 中间字节 终止字节
CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
# OSC 序列：ESC ] ... (BEL | ESC \)
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
# 兼容：ESC 丢失后行首残留的 SGR，如 "[34;22m"
LITERAL_SGR_RE = re.compile(r"^\[(?:\d{1,3}(?:;\d{1,3})*)m")
# 只提取 SGR（颜色）参数，用于“设备配色”还原
SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")


def strip_ansi(text: str, literal: bool = False) -> str:
    """去掉 ANSI 转义，返回纯文本。

    literal=True 表示这一行已经确认“ESC 被吞掉”，此时把行内所有
    "[34;22m" / "[0m" 形态的残留也一并清掉（正常日志里不应出现这种串）。
    """
    text = OSC_RE.sub("", text)
    text = CSI_RE.sub("", text)
    if literal:
        text = re.sub(r"\[[0-9;]*m", "", text)
    else:
        text = LITERAL_SGR_RE.sub("", text)
    return text


def extract_sgr(text: str) -> list[str]:
    """提取行内出现过的 SGR 参数串，例如 ['34;22', '0']。"""
    return [m.group(1) for m in SGR_RE.finditer(text)]


# ---------------------------------------------------------------------------
# 行解析
# ---------------------------------------------------------------------------

# 串口助手（SSCOM 等）加的前缀：[16:02:22.722]收←◆
HOST_PREFIX_RE = re.compile(
    r"^\[(?P<host_ts>\d{2}:\d{2}:\d{2}\.\d{1,3})\](?P<mark>收←◆|发→◇)?\s?"
)

# 设备侧时间前缀（如果 ELOG_FMT_TIME 打开）：
#   [2026-10-28 16:02:22.722] 或 [16:02:22.722]
DEV_TIME_RE = re.compile(
    r"^\[(?P<dev_ts>"
    r"\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?"
    r"|\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?"
    r")\]\s*"
)

# EasyLogger 默认格式：LEVEL/TAG    (line func)message
# 注意：tag 后面是“填充空格”，宽度不固定，必须用 \s* 而不是固定空格数
FULL_RE = re.compile(
    r"^(?P<level>[AEWIDV])/"
    r"(?P<tag>[A-Za-z0-9_.\-]+)\s*"
    r"\((?P<line>\d+)\s+(?P<func>[A-Za-z_][A-Za-z0-9_]*)\)"
    r"(?P<msg>.*)$"
)

# 变体：没有 line/func（ELOG_FMT_LINE / ELOG_FMT_FUNC 关闭）
TAG_ONLY_RE = re.compile(
    r"^(?P<level>[AEWIDV])/(?P<tag>[A-Za-z0-9_.\-]+)\s+(?P<msg>.*)$"
)

# 变体：连 tag 都没有（ELOG_FMT_TAG 关闭）
LEVEL_ONLY_RE = re.compile(r"^(?P<level>[AEWIDV])/\s*(?P<msg>.*)$")

LEVEL_NAMES = {
    "A": "ASSERT",
    "E": "ERROR",
    "W": "WARN",
    "I": "INFO",
    "D": "DEBUG",
    "V": "VERBOSE",
}


@dataclass
class LogRecord:
    seq: int
    host_time: str = ""      # 抓包工具前缀时间（仅导入旧日志时有）
    dev_time: str = ""       # 设备侧时间（若格式里带）
    level: str = "?"         # A E W I D V，未知为 ?
    level_name: str = ""
    tag: str = ""
    line: int = 0
    func: str = ""
    message: str = ""        # 去 ANSI 后的消息
    raw: str = ""            # 原始行（含 ANSI，去掉行尾 CR）
    ansi: list[str] = None   # 行内 SGR 参数
    parsed: bool = False
    ignored: bool = False    # 仅含 ANSI 复位/空白的行，可安全忽略

    def to_dict(self) -> dict:
        d = asdict(self)
        if d["ansi"] is None:
            d["ansi"] = []
        return d


def parse_line(raw_line: str, seq: int = 0) -> LogRecord:
    """解析一行（不含行尾 \\n，可含 \\r）。"""
    raw = raw_line.rstrip("\r")
    rec = LogRecord(seq=seq, raw=raw, ansi=extract_sgr(raw))

    text = raw

    m = HOST_PREFIX_RE.match(text)
    if m:
        rec.host_time = m.group("host_ts")
        text = text[m.end():]

    # 有些终端/截图会吞掉 ESC，只剩 "[34;22m"；仅在行首命中时按残缺 ANSI 处理
    literal_ansi = bool(LITERAL_SGR_RE.match(text))

    # 去掉 ANSI 后再匹配结构，避免转义序列插在字段中间
    text = strip_ansi(text, literal=literal_ansi)

    m = DEV_TIME_RE.match(text)
    if m:
        rec.dev_time = m.group("dev_ts")
        text = text[m.end():]

    for pattern in (FULL_RE, TAG_ONLY_RE, LEVEL_ONLY_RE):
        m = pattern.match(text)
        if not m:
            continue
        gd = m.groupdict()
        rec.level = gd["level"]
        rec.level_name = LEVEL_NAMES.get(rec.level, "")
        rec.tag = (gd.get("tag") or "").strip()
        rec.line = int(gd.get("line") or 0)
        rec.func = gd.get("func") or ""
        rec.message = gd.get("msg") or ""
        rec.parsed = True
        break

    if not rec.parsed:
        # 设备消息里可能自带 \r\n（如 NMEA 语句），导致 ANSI 复位码单独成行。
        # 这类“只有转义码/空白”的行不是日志，统计时应排除。
        if strip_ansi(text).strip() == "":
            rec.ignored = True
        # 解析失败：保留全文，交给 UI 以“未解析”样式显示，不能丢
        rec.message = text
    return rec


# ---------------------------------------------------------------------------
# 流式组包（处理串口分片）
# ---------------------------------------------------------------------------

class LineFramer:
    """把任意分片的字节流切成行；超长行强制截断，避免内存无限增长。"""

    def __init__(self, max_line: int = 8192):
        self.buf = bytearray()
        self.max_line = max_line
        self.truncated = 0

    def feed(self, data: bytes) -> Iterator[bytes]:
        self.buf.extend(data)
        while True:
            idx = self.buf.find(b"\n")
            if idx >= 0:
                line = bytes(self.buf[:idx])
                del self.buf[: idx + 1]
                yield line
                continue
            if len(self.buf) > self.max_line:
                self.truncated += 1
                line = bytes(self.buf[: self.max_line])
                del self.buf[: self.max_line]
                yield line
                continue
            return


def parse_stream(chunks: Iterator[bytes], encoding: str = "utf-8",
                 max_line: int = 8192) -> Iterator[LogRecord]:
    framer = LineFramer(max_line=max_line)
    seq = 0
    for chunk in chunks:
        for raw in framer.feed(chunk):
            seq += 1
            yield parse_line(raw.decode(encoding, errors="replace"), seq)


# ---------------------------------------------------------------------------
# 示例与自测
# ---------------------------------------------------------------------------

SAMPLES = [
    "\x1b[34;22mV/TRK    (185 jm_pal_get_utc_time)[480],1970-1-1 8:32:54, 480\x1b[0m",
    "\x1b[34;22mV/TRK    (360 jm_sensor_sc7a20h_get_xyz)raw:80 07 60 09 70 c4, "
    "X = 30  Y = 37  Z = -239 \x1b[0m",
    "\x1b[32;22mD/TRK    (255 track_master_rollover_norm_check)"
    "x:y:z=1:22:20 over:2 acc:243 stage_t:1,  (30:37:-239)\x1b[0m",
]


def selftest() -> int:
    failures = []

    def check(name: str, cond: bool, detail: str = ""):
        if not cond:
            failures.append(f"{name}: {detail}")

    # 1. 三行真实样例
    r1 = parse_line(SAMPLES[0], 1)
    check("sample1.level", r1.level == "V", r1.level)
    check("sample1.tag", r1.tag == "TRK", r1.tag)
    check("sample1.line", r1.line == 185, str(r1.line))
    check("sample1.func", r1.func == "jm_pal_get_utc_time", r1.func)
    check("sample1.msg", r1.message.startswith("[480],1970-1-1"), r1.message)

    r2 = parse_line(SAMPLES[1], 2)
    check("sample2.func", r2.func == "jm_sensor_sc7a20h_get_xyz", r2.func)
    check("sample2.msg", "X = 30" in r2.message, r2.message)

    r3 = parse_line(SAMPLES[2], 3)
    check("sample3.level", r3.level == "D", r3.level)
    check("sample3.line", r3.line == 255, str(r3.line))
    check("sample3.msg", "stage_t:1" in r3.message, r3.message)

    # 2. 串口助手前缀
    r4 = parse_line("[16:02:22.722]收←◆" + SAMPLES[0], 4)
    check("host_prefix.time", r4.host_time == "16:02:22.722", r4.host_time)
    check("host_prefix.level", r4.level == "V", r4.level)
    check("host_prefix.no_mark", "收←" not in r4.message, r4.message)

    # 3. ESC 丢失（只剩 [34;22m）
    r5 = parse_line("[34;22mV/TRK    (185 jm_pal_get_utc_time)hello[0m", 5)
    check("no_esc.level", r5.level == "V", r5.level)
    check("no_esc.msg", r5.message == "hello", r5.message)

    # 4. 分片组包（每 7 字节切一次）
    stream = (SAMPLES[0] + "\r\n").encode("utf-8")
    recs = list(parse_stream((stream[i:i + 7] for i in range(0, len(stream), 7))))
    check("framer.count", len(recs) == 1, str(len(recs)))
    check("framer.level", recs and recs[0].level == "V", str(recs))

    # 5. 变体与降级
    r6 = parse_line("E/TRK something bad happened", 6)
    check("tag_only.level", r6.level == "E", r6.level)
    check("tag_only.msg", r6.message == "something bad happened", r6.message)

    r7 = parse_line("this is raw output from elog_raw()", 7)
    check("raw.parsed_false", r7.parsed is False, str(r7.parsed))
    check("raw.kept", r7.message == "this is raw output from elog_raw()", r7.message)

    # 6. 设备时间前缀
    r8 = parse_line("[2026-10-28 16:02:22.722]V/TRK (18 foo)hi", 8)
    check("dev_time.value", r8.dev_time == "2026-10-28 16:02:22.722", r8.dev_time)
    check("dev_time.level", r8.level == "V", r8.level)

    # 7. 空行 / 超长行不应崩
    check("empty.line", parse_line("", 9).parsed is False, "empty")

    # 8. 仅 ANSI 复位码的行：应标记为 ignored，而不是“解析失败”
    r9 = parse_line("\x1b[0m", 10)
    check("ansi_only.ignored", r9.ignored and not r9.parsed, repr(r9.raw))

    if failures:
        print("SELFTEST FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print(f"SELFTEST OK ({len(SAMPLES)} real samples + variants)")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def print_table(records: list[LogRecord], max_msg: int = 96) -> None:
    if not records:
        print("(no records)")
        return
    header = f"{'#':>4}  {'HOST TIME':<12}  {'DEV TIME':<19}  {'LVL':<3}  {'TAG':<8}  {'FUNC':<30}  {'LINE':>5}  MSG"
    print(header)
    print("-" * len(header))
    for r in records:
        func = (r.func[:28] + "..") if len(r.func) > 30 else r.func
        msg = r.message if len(r.message) <= max_msg else r.message[: max_msg - 2] + ".."
        print(
            f"{r.seq:>4}  {r.host_time:<12}  {r.dev_time:<19}  "
            f"{r.level:<3}  {r.tag:<8}  {func:<30}  {r.line:>5}  {msg}"
        )


def print_stats(records: list[LogRecord]) -> None:
    total = len(records)
    parsed = sum(1 for r in records if r.parsed)
    ignored = sum(1 for r in records if r.ignored)
    unparsed = sum(1 for r in records if not r.parsed and not r.ignored)
    levels: dict[str, int] = {}
    tags: dict[str, int] = {}
    for r in records:
        if r.ignored:
            continue
        levels[r.level] = levels.get(r.level, 0) + 1
        if r.tag:
            tags[r.tag] = tags.get(r.tag, 0) + 1
    print()
    print(f"total={total} parsed={parsed} ignored={ignored} unparsed={unparsed}")
    print("levels:", ", ".join(f"{k}={v}" for k, v in sorted(levels.items())))
    top = sorted(tags.items(), key=lambda kv: -kv[1])[:10]
    print("tags  :", ", ".join(f"{k}={v}" for k, v in top))


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="EasyLogger 日志行解析器（参考实现）")
    ap.add_argument("path", nargs="?", help="日志文件路径；省略则进入 --demo")
    ap.add_argument("--demo", action="store_true", help="用内置真实样例演示")
    ap.add_argument("--json", action="store_true", help="输出 JSON Lines")
    ap.add_argument("--encoding", default="utf-8", help="文件编码，默认 utf-8（可选 gbk）")
    ap.add_argument("--selftest", action="store_true", help="运行自测")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    if args.demo or not args.path:
        lines = SAMPLES
        records = [parse_line(s, i + 1) for i, s in enumerate(lines)]
    else:
        with open(args.path, "rb") as f:
            records = list(parse_stream(iter(lambda: f.read(65536), b""), args.encoding))

    if args.json:
        for r in records:
            print(json.dumps(r.to_dict(), ensure_ascii=False))
        return 0

    print_table(records)
    print_stats(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
