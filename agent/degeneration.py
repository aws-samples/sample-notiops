"""输出崩坏守卫（影子模式）：模型一次调用中途崩成乱码时，在日志里记一行「本来会在第几个字停下」。

## 现象（2026-10，默认模型 Kimi K3）

偶发：某一次模型调用从某个字起变成乱码，一路流到停 —— 约 2.5–3.3 万输出 token、6–10 分钟，
用户看到满屏乱码，或者正文 0 字（乱码全在思考里）。见过两种形状：

  形状 1（粘连）：中英词碎片用 `-` 粘在一起，夹着别的文种的字母，第 1 个 token 起就是乱码：
      `1位-Na li still-ish 带 以-ja 刷新 heads项目-panic … wasの是 网站-avar …`
      后段变成一行一个弯引号，再变成撇号串起来的英文词。
  形状 2（复读）：思考写到一半（转向下一步动作那一刻）变成无限重复的 ` @ @ @ @ …`。

## 两个信号（互补：哪一个单独用都会漏掉一种形状）

  · **粘连标记**（抓形状 1，乱码开始后约 140 字就够）：在最近 300 字里数
      HL  ASCII `-` 一边是汉字、另一边是英文字母         `项目-panic`、`1位-Na`
      HH  ASCII `-` 两边都是汉字                        `勒-何-时间`
      D   字母（英文 / 汉字）后面紧跟 ≥2 个 `-`（`-->` 这类箭头不算）   `for--ts`、`Night---s`
      F   提问里没出现过的文种的字母（一串连着的算 1 个）   `の`、`не`、`ز`
    得分 = HL + HH + D + min(F, 2) ≥ 5 → 判。外来文种**最多算 2 分**：在中文回答里整段引用一句
    韩文 / 日文示例是正常的，`-` 粘连才是乱码的主证据，外来字母只当佐证。
    计数前先屏蔽：代码块（含还没闭合的，最多屏蔽 8000 字）、行内代码、URL、markdown 链接目标、
    HTML 标签、`#锚点`（如 `#4-配置项与-im-凭据`）—— 这些地方出现 `-` 粘连是正常的。
  · **重复度**（抓形状 2，复读开始后约 950 字）：最近 1000 字（代码块、URL、链接目标、锚点不算，行内代码照算）
    zlib 压缩后 / 压缩前 < 0.10 → 判。对照：正常回答与中文技术文档最低约 0.30（逐日列成本的明细、
    列 57 个相似函数名的思考）；按「服务 × 组件 × 环境」拼出来的 57 个函数名排成清单能低到 0.17，
    `worker-01 … worker-57` 这种几乎一样的行 0.13；代码块里的 JSON / YAML / ARN 清单 0.14 左右
    （所以代码不进这个窗口）；复读 0.013–0.03。形状 1 后段（一行一个弯引号、中间夹词）约 0.15–0.19，
    这个阈值**不一定**抓得到 —— 形状 1 靠粘连标记，开头第 143 字就判了；阈值放到 0.2 以上去抓它，
    上面那种长清单就会误报。

字母的范围：英文 = ASCII 字母；汉字 = CJK 统一表意文字（含扩展区）。带变音符号的拉丁字母
（São Paulo、法语 / 越南语）、希腊字母（Δ、λ、μ）一律当正常字母；日文假名、韩文、西里尔……
只在提问里出现过时才算正常。

## 影子模式：只记日志，不改任何行为

触发时打**一行**结构化日志（每次模型调用最多一行），不停流、不改事件、不多花 token：

    degeneration guard (shadow, no action taken): signal=glue model=global.moonshotai.kimi-k3 call=2 phase=reasoning at=143 …

字段：`signal`（glue / repeat）、`call`（本轮第几次模型调用）、`phase`（触发时在思考还是正文）、
`at`（本次调用的第几个字，思考 + 正文按到达顺序）、`reasoning_chars` / `text_chars`、`elapsed_s`、
窗口里的各类标记数（`glue` 得分、`han_latin` / `han_han` / `double` / `foreign`、`foreign_scripts`）、
最近一次算出的压缩率 `zlib`。**不记任何正文**（docs/LOGGING_STANDARD.md）—— trace / span id 由
runtime 的 OTEL 日志处理器自动带上，要看原文按 trace 去查。
攒够现网基线之后，才考虑真的停流（停流、这次输出不进历史、告诉用户、可重试一次）—— 那是另一个改动。

守卫自己出错时**本轮关掉自己**（打一行只带异常类型的 warning），不影响回答。

## 已知的误报风险（影子期要看的）

  · 英文里把 `--` 当破折号（`function--which`）、300 字里用到 5 次：只靠 D 就会判（日志里 `double=` 单独计数）。
  · 中文里用 `-` 连汉字表示范围（`周一-周五`、`华东-华北`），一张表里密到 300 字 5 处：只靠 HH 就会判
    （日志里 `han_han=` 单独计数；它在已知的乱码样本里不是先到的那个信号，必要时可以去掉）。
  · 对照：正常模型输出（中 / 英 / 日 / 韩提问，69 万字）任意 300 字最多 2 分；6.6M 字中文技术文档最多 3 分
    （`汉字-英文` 最多 2 处、`汉字-汉字` 最多 3 处、D 0 处）；形状 1 的乱码思考任意 300 字最高 22 分。

## 刻意不做的

  · 不看文种切换率 / 文种占比：乱码基本是拉丁 + 汉字，切换率和正常的中文回答重叠。
  · 不扫工具调用的入参（toolUse 的 JSON 增量）和流式工具直接吐给用户的文字（那不是模型写的）。

## 零依赖

同 paragraphs.py / repeat_calls.py：不 import strands，事件按 Strands 的原始形状读
（`{"event": {"messageStart" | "contentBlockDelta": …}}`）。tests/test_agent_degeneration.py 按文件路径
直接加载本模块。`agent/degeneration.py` 是逐字节相同的副本，同一个测试钉着两份一致。
"""

from __future__ import annotations

import logging
import time
import unicodedata
import zlib
from collections import deque

# ── 阈值 ──────────────────────────────────────────────────────────────────────
GLUE_WINDOW = 300       # 粘连标记：数最近这么多字
GLUE_LIMIT = 5          # 得分到这个数就判
FOREIGN_CAP = 2         # 外来文种最多算几分
REPEAT_WINDOW = 1000    # 重复度：最近这么多字（不含被屏蔽的）
REPEAT_STEP = 100       # 每进来这么多字算一次（压缩一次约几十微秒）
REPEAT_RATIO = 0.10     # 压缩后 / 压缩前低于它就判
# 各种屏蔽区最多屏蔽多长：乱码里偶然冒出一个 ``` 或 ` 时，不能让守卫从此瞎掉。
FENCE_CAP = 8000
INLINE_CAP = 200
TAG_CAP = 200
LINK_CAP = 300
URL_CAP = 2048
ANCHOR_CAP = 100

_BASE_SCRIPTS = frozenset({"HAN", "LATIN", "GREEK"})
_MARK = "mark"          # 组合附加符（变音符、emoji 变体选择符）：透明，既不算字母也不打断字母串

# 每个字的状态
_CLEAR, _HELD, _MASKED = 0, 1, 2
# 屏蔽模式
_PLAIN, _FENCE, _INLINE, _URL, _LINK, _TAG, _ANCHOR = range(7)

_URL_END = frozenset("<>\"'`()[]{}|\\^，。！？；：、（）【】《》「」『』〈〉")
_ANCHOR_EXTRA = frozenset("-_.%~")
_NAME_SCRIPT = {"CJK": "HAN", "IDEOGRAPHIC": "HAN", "LATIN": "LATIN", "GREEK": "GREEK",
                "COPTIC": "GREEK", "HIRAGANA": "KANA", "KATAKANA": "KANA",
                "KATAKANA-HIRAGANA": "KANA", "HANGUL": "HANGUL"}
# 名字以这些词开头的「字母」其实是符号（ª 那种修饰字母、数学字母）：不算任何文种。
_NOT_A_SCRIPT = frozenset({"MODIFIER", "MATHEMATICAL", "SCRIPT", "DOUBLE-STRUCK", "BLACK-LETTER"})

_scripts: dict = {}


def _is_han(o: int) -> bool:
    return (0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0xF900 <= o <= 0xFAFF
            or 0x20000 <= o <= 0x3134F)


def script_of(ch: str):
    """一个字属于哪种文字：字母返回文种名（"HAN" / "LATIN" / "KANA" / "CYRILLIC" …），
    组合附加符返回 `_MARK`，其余（数字、标点、空白、符号、字母样式的符号如 ℹ）返回 None。"""
    s = _scripts.get(ch, 0)
    if s != 0:
        return s
    o = ord(ch)
    if o < 0x80:
        s = "LATIN" if ch.isalpha() else None
    elif _is_han(o):
        s = "HAN"
    else:
        cat = unicodedata.category(ch)
        if cat[0] == "M":
            s = _MARK
        elif cat[0] != "L" or 0x2100 <= o <= 0x214F:   # 后者是 Letterlike Symbols（ℹ ℓ ℃ 那一块）
            s = None
        elif o < 0x250:                                  # Latin-1 / Latin Extended-A/B（含 ª º µ）
            s = "LATIN"
        else:
            words = unicodedata.name(ch, "").split()
            if len(words) > 1 and words[0] in ("FULLWIDTH", "HALFWIDTH"):
                words = words[1:]
            first = words[0] if words else ""
            s = None if first in _NOT_A_SCRIPT else _NAME_SCRIPT.get(first, first or "OTHER")
    if len(_scripts) > 20000:   # 长寿进程里的上限（正常只会见到几千种字）
        _scripts.clear()
    _scripts[ch] = s
    return s


def scripts_in(text: str) -> frozenset:
    """`text` 里出现过的字母的文种集合。"""
    out = set()
    for ch in text or "":
        s = script_of(ch)
        if s is not None and s is not _MARK:
            out.add(s)
    return frozenset(out)


class Verdict:
    """一次判定：哪个信号、在第几个字、当时窗口里的计数。只有元数据，不带正文。"""

    __slots__ = ("signal", "at", "phase", "reasoning_chars", "text_chars", "glue", "han_latin",
                 "han_han", "double", "foreign", "foreign_scripts", "zlib_ratio")

    def __init__(self, **fields) -> None:
        for name in self.__slots__:
            setattr(self, name, fields.get(name))

    def __repr__(self) -> str:
        return "Verdict(%s)" % ", ".join("%s=%r" % (n, getattr(self, n)) for n in self.__slots__)


class CollapseDetector:
    """一次模型调用一个实例。`feed(增量, phase)` 按到达顺序喂思考（"reasoning"）和正文（"text"），
    两个信号里任一个第一次成立时返回 `Verdict`（之后不再计算），否则返回 None。"""

    def __init__(self, question: str = "", allowed=None) -> None:
        # 正常的文种：汉字 / 拉丁 / 希腊 + 提问里出现过的。`allowed` 可由调用方预先算好传进来。
        self._allowed = allowed if allowed is not None else _BASE_SCRIPTS | scripts_in(question)
        self.pos = 0                          # 本次调用已处理完的字数
        self.chars = {"reasoning": 0, "text": 0}   # 已处理完的增量，按 phase 分
        self._chunk_start = 0                 # 当前这段增量从第几个字开始
        self._seen = 0                        # 判定那一刻已经看到的字数（含正在处理的那个字）
        self.verdict = None
        self.zlib_ratio = None                # 最近一次算出的压缩率
        self._phase = None
        # 粘连标记：窗口里的 (位置, 类型, 文种)，以及按类型的计数
        self._marks: deque = deque()
        self._counts = {"HL": 0, "HH": 0, "D": 0, "F": 0}
        self._held = None                     # 还没确认是不是行内代码 / 标签时，里面找到的标记先放这
        self._prev = "o"                      # 上一个字的类别：a 英文字母 / h 汉字 / f 外来文种 / x 其它字母 / o 非字母
        self._prev_script = None
        self._dashes = 0                      # 刚刚连着看到几个 `-`
        self._dash_before = "o"               # 这串 `-` 前面那个字的类别
        # 屏蔽
        self._mode = _PLAIN
        self._since = 0                       # 当前屏蔽区从第几个字开始
        self._lead = True                     # 本行到目前为止只有（≤3 个）空格
        self._lead_spaces = 0
        self._ticks = 0                       # 刚刚连着看到几个反引号
        self._ticks_at_lead = False
        self._tildes = 0
        self._inline_ticks = 0
        self._fence_char = ""
        self._fence_len = 0
        self._fence_line = ""                 # 代码块里当前这一行（只留开头一小段，判断是不是收尾的 ```）
        self._recent = ""                     # 最近几个原字（认 `://` 和 `](`）
        self._after = ""                      # 上一个字是 `#` / `<`：要看下一个字才知道是不是锚点 / 标签
        # 重复度
        self._rep_tail = ""
        self._rep_new: list = []
        self._rep_count = 0

    # ── 对外 ──────────────────────────────────────────────────────────────────
    def feed(self, text: str, phase: str = "text"):
        if self.verdict is not None or not text:
            return None
        self._chunk_start = self._seen = self.pos
        if phase != self._phase:
            if self._phase is not None:
                self._boundary()              # 可能补记出标记而判定 —— 算在上一段 phase 头上
                if self.verdict is not None:
                    return self.verdict
            self._phase = phase
        for ch in text:
            self._step(ch)
            if self.verdict is not None:
                return self.verdict
        self.chars[phase] = self.chars.get(phase, 0) + len(text)
        self._flush_repeat()
        return None

    # ── 判定 ──────────────────────────────────────────────────────────────────
    def _fire(self, signal: str) -> None:
        c = self._counts
        scripts = sorted({s for _, t, s in self._marks if t == "F" and s})
        seen = dict(self.chars)               # 加上这一段增量里已经看过的部分
        seen[self._phase] = seen.get(self._phase, 0) + self._seen - self._chunk_start
        self.verdict = Verdict(
            signal=signal, at=self._seen, phase=self._phase,
            reasoning_chars=seen.get("reasoning", 0), text_chars=seen.get("text", 0),
            glue=self._glue_score(), han_latin=c["HL"], han_han=c["HH"], double=c["D"],
            foreign=c["F"], foreign_scripts=",".join(scripts) or "-", zlib_ratio=self.zlib_ratio)

    def _glue_score(self) -> int:
        c = self._counts
        return c["HL"] + c["HH"] + c["D"] + min(c["F"], FOREIGN_CAP)

    def _mark(self, offset: int, kind: str, script=None) -> None:
        if self._held is not None:
            self._held.append((offset, kind, script))
        else:
            self._commit(offset, kind, script)

    def _commit(self, offset: int, kind: str, script) -> None:
        marks, counts = self._marks, self._counts
        marks.append((offset, kind, script))
        counts[kind] += 1
        low = offset - GLUE_WINDOW
        while marks[0][0] < low:
            counts[marks.popleft()[1]] -= 1
        if self.verdict is None and self._glue_score() >= GLUE_LIMIT:
            self._fire("glue")

    def _release(self, confirmed: bool) -> None:
        """结束一段待定区：确认是代码 / 标签 → 丢掉里面的标记；不是 → 按原位置补记。"""
        held, self._held = self._held, None
        if held and not confirmed:
            for m in held:
                self._commit(*m)

    def _flush_repeat(self) -> None:
        if self._rep_new:
            self._rep_tail = (self._rep_tail + "".join(self._rep_new))[-REPEAT_WINDOW:]
            self._rep_new = []

    def _check_repeat(self) -> None:
        self._flush_repeat()
        raw = self._rep_tail.encode("utf-8")
        self.zlib_ratio = len(zlib.compress(raw, 9)) / max(1, len(raw))
        if self.verdict is None and self.zlib_ratio < REPEAT_RATIO:
            self._fire("repeat")

    # ── 逐字 ──────────────────────────────────────────────────────────────────
    def _boundary(self) -> None:
        """思考 ↔ 正文切换：当成一个硬换行（屏蔽区不跨过去，`-` 也不跨过去粘连）。"""
        self._release(confirmed=False)
        self._mode = _PLAIN
        self._lead, self._lead_spaces = True, 0
        self._ticks = self._tildes = 0
        self._after = ""
        self._recent = ""
        self._detect("\n", _MASKED)

    def _step(self, ch: str) -> None:
        self._seen = self.pos + 1
        state = self._mask(ch)
        nl = ch == "\n"
        if nl:
            self._lead, self._lead_spaces = True, 0
        elif self._lead:
            if ch == " " and self._lead_spaces < 3:
                self._lead_spaces += 1
            elif ch not in "`~":
                self._lead = False
        self._recent = (self._recent + ch)[-8:]
        self._detect(ch, state)
        if state != _MASKED and self.verdict is None:
            self._rep_new.append(ch)
            self._rep_count += 1
            if self._rep_count % REPEAT_STEP == 0 and self._rep_count >= REPEAT_WINDOW:
                self._check_repeat()
        self.pos += 1

    def _enter(self, mode: int) -> None:
        self._mode = mode
        self._since = self.pos
        if mode in (_INLINE, _TAG):
            self._held = []

    def _mask(self, ch: str) -> int:
        """这个字落在哪：`_CLEAR` 正常数 / `_HELD` 先记着（可能是代码）/ `_MASKED` 不数。顺带推进屏蔽模式。"""
        # 1) 上一个字留下的悬念：一串反引号 / 波浪线刚结束，或者上一个字是 `#` / `<`
        if self._ticks and ch != "`":
            n, self._ticks = self._ticks, 0
            if self._mode == _INLINE:
                if n == self._inline_ticks:
                    self._release(confirmed=True)
                    self._mode = _PLAIN
            elif self._mode == _PLAIN:
                if self._ticks_at_lead and n >= 3:
                    self._enter(_FENCE)
                    self._fence_char, self._fence_len, self._fence_line = "`", n, None
                else:
                    self._enter(_INLINE)
                    self._inline_ticks = n
        if self._tildes and ch != "~":
            n, self._tildes = self._tildes, 0
            if self._mode == _PLAIN and n >= 3:
                self._enter(_FENCE)
                self._fence_char, self._fence_len, self._fence_line = "~", n, None
        if self._after:
            after, self._after = self._after, ""
            if self._mode == _PLAIN:
                if after == "#" and (ch.isalnum() or ch in _ANCHOR_EXTRA):
                    self._enter(_ANCHOR)
                elif after == "<" and (ch.isalpha() or ch in "/!?"):
                    self._enter(_TAG)

        # 2) 正在某个屏蔽区里
        mode, age = self._mode, self.pos - self._since
        if mode == _FENCE:
            if age > FENCE_CAP:
                self._mode = _PLAIN
            else:
                if ch == "\n":
                    line, self._fence_line = self._fence_line, ""
                    if line is not None and self._closes_fence(line):
                        self._mode = _PLAIN
                elif self._fence_line is not None and len(self._fence_line) < 40:
                    self._fence_line += ch
                return _MASKED
        elif mode == _INLINE:
            if ch == "`":
                self._ticks += 1
                return _MASKED
            if ch == "\n" or age > INLINE_CAP:
                self._release(confirmed=False)
                self._mode = _PLAIN
            else:
                return _HELD
        elif mode == _TAG:
            if ch == ">":
                self._release(confirmed=True)
                self._mode = _PLAIN
                return _MASKED
            if ch == "\n" or age > TAG_CAP:
                self._release(confirmed=False)
                self._mode = _PLAIN
            else:
                return _HELD
        elif mode == _URL:
            if ch.isspace() or ch in _URL_END or age > URL_CAP:
                self._mode = _PLAIN
            else:
                return _MASKED
        elif mode == _LINK:
            if ch == ")":
                self._mode = _PLAIN
                return _MASKED
            if ch.isspace() or age > LINK_CAP:
                self._mode = _PLAIN
            else:
                return _MASKED
        elif mode == _ANCHOR:
            if (ch.isalnum() or ch in _ANCHOR_EXTRA) and age <= ANCHOR_CAP:
                return _MASKED
            self._mode = _PLAIN

        # 3) 正文：看这个字是不是某个屏蔽区的开头
        if ch == "`":
            if not self._ticks:
                self._ticks_at_lead = self._lead
            self._ticks += 1
            return _MASKED
        if ch == "~" and self._lead:
            self._tildes += 1
        elif ch == "/" and self._recent.endswith(":/") and len(self._recent) >= 3 \
                and self._recent[-3].isascii() and self._recent[-3].isalnum():
            self._enter(_URL)                 # http:// https:// s3:// ……
            return _MASKED
        elif ch == "(" and self._recent.endswith("]"):
            self._enter(_LINK)                # [文字](目标)
            return _MASKED
        elif ch in "#<":
            self._after = ch
        return _CLEAR

    def _closes_fence(self, line: str) -> bool:
        body = line.rstrip(" ")
        stripped = body.lstrip(" ")
        return (len(body) - len(stripped) <= 3 and len(stripped) >= self._fence_len
                and stripped == self._fence_char * len(stripped))

    def _detect(self, ch: str, state: int) -> None:
        """粘连标记检测。被屏蔽的字当成一个中性的分隔符。"""
        pos = self.pos
        if state == _MASKED:
            kind, script = "o", None
        elif ch == "-":
            if not self._dashes:
                self._dash_before = self._prev
            self._dashes += 1
            self._prev, self._prev_script = "o", None
            return
        else:
            script = script_of(ch)
            if script is _MARK:
                return
            if script is None:
                kind = "o"
            elif script == "HAN":
                kind = "h"
            elif script == "LATIN":
                kind = "a" if ch.isascii() else "x"
            elif script in self._allowed:
                kind = "x"
            else:
                kind = "f"
        if self._dashes:
            before, n = self._dash_before, self._dashes
            self._dashes = 0
            if n == 1:
                if before in "ah" and kind in "ah" and "h" in (before, kind):
                    self._mark(pos, "HH" if before == kind else "HL")
            elif before in "ah" and ch != ">":
                self._mark(pos, "D")
        if kind == "f" and not (self._prev == "f" and self._prev_script == script):
            self._mark(pos + 1, "F", script)
        self._prev, self._prev_script = kind, script


class DegenerationGuard:
    """一轮（一次 invoke）一个实例，挂在 `agent.stream_async` 的循环里：每个原始事件先给它看一眼。

    `observe(event)` 只读事件、从不改它，也从不抛异常：自己出错就本轮关掉（打一行只带异常类型的
    warning）。每次模型调用（`messageStart`）重新计数；一次调用里第一次判定时打一行 warning，
    同一次调用里不再计算（省 CPU，也不刷屏）。
    """

    def __init__(self, question: str = "", model: str = "", log=None, clock=time.monotonic) -> None:
        self._log = log or logging.getLogger(__name__)
        self._clock = clock
        self._model = "_".join(str(model or "").split()) or "-"   # 日志是 key=value，值里不能有空格
        self._calls = 0
        self._detector = None
        self._started = 0.0
        self._done = False                    # 本次调用已判定过
        self._off = False
        try:
            self._allowed = _BASE_SCRIPTS | scripts_in(str(question or ""))
        except Exception as e:  # noqa: BLE001 — 同 observe：出错只关掉自己
            self._off = True
            self._log.warning("degeneration guard disabled for this turn: %s", type(e).__name__)

    def observe(self, event) -> None:
        if self._off:
            return
        try:
            self._observe(event)
        except Exception as e:  # noqa: BLE001 — 影子模式：守卫失败只关掉自己，不影响回答
            self._off = True
            self._log.warning("degeneration guard disabled for this turn: %s", type(e).__name__)

    def _observe(self, event) -> None:
        ev = event.get("event") if isinstance(event, dict) else None
        if not isinstance(ev, dict):
            return
        if "messageStart" in ev:
            self._new_call()
            return
        if "messageStop" in ev:
            self._detector = None
            return
        block = ev.get("contentBlockDelta")
        delta = block.get("delta") if isinstance(block, dict) else None
        if not isinstance(delta, dict):
            return
        text, phase = delta.get("text"), "text"
        if not isinstance(text, str):
            rc = delta.get("reasoningContent")
            text, phase = (rc.get("text") if isinstance(rc, dict) else None), "reasoning"
        if not isinstance(text, str) or not text:
            return
        if self._detector is None:            # 没收到 messageStart 的模型 / 路径：按新的一次调用算
            self._new_call()
        if self._done:
            return
        verdict = self._detector.feed(text, phase)
        if verdict is not None:
            self._done = True
            self._report(verdict)

    def _new_call(self) -> None:
        self._calls += 1
        self._detector = CollapseDetector(allowed=self._allowed)
        self._started = self._clock()
        self._done = False

    def _report(self, v: Verdict) -> None:
        self._log.warning(
            "degeneration guard (shadow, no action taken): signal=%s model=%s call=%d phase=%s at=%d "
            "reasoning_chars=%d text_chars=%d elapsed_s=%.1f glue=%d han_latin=%d han_han=%d "
            "double=%d foreign=%d foreign_scripts=%s zlib=%s",
            v.signal, self._model, self._calls, v.phase, v.at, v.reasoning_chars, v.text_chars,
            self._clock() - self._started, v.glue, v.han_latin, v.han_han, v.double, v.foreign,
            v.foreign_scripts, "-" if v.zlib_ratio is None else "%.3f" % v.zlib_ratio)
