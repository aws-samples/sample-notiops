"""正文分段：一轮回答里**工具调用前后**的两段正文之间补一个空行。

## 为什么需要

一轮 agentic 回答是好几段模型正文夹着工具调用：

    我先取证：……变更事件。      ← 第 1 个 cycle 的正文
    （调 describe_alarms）
    当前活跃告警里没有……再查：  ← 第 2 个 cycle
    （调 lookup_events）
    # 排查结果：……               ← 第 3 个 cycle

每段都是模型新起的一个文本块，可 Strands 的流里它们只是一串 `contentBlockDelta.text`，
**块与块之间没有任何分隔**。entrypoint 原样转发、BFF 原样转发（`bff/web-chat/agentcore.mjs`）、
前端 `acc += delta`、IM 的 `core/agent_chat.py::Sink.say` 也是 `+=` —— 于是三段被拼成一段：
`…再查：# 排查结果`，ReactMarkdown 把它当一个段落渲染，`#` 原样露出来（2026-10-13 现网，
调查 / 成本 / DynamoDB 三类回答都见过）。IM 那条（`/agent notiops`）读的是同一条流，同一个病。

修在**发出端**（这里）而不是各消费端：只有 agent 知道"这里刚发生过一次工具调用"，
BFF / IM 只看得到一串字；在发出端修一处，web 的实时显示、web 落库（BFF 存的就是这些 delta
拼起来的全文）、IM 的卡片三处天然一致。DevOps 对话那条直连路径早就这么做了
（`core/devops_chat.py::Sink.gap` / `bff/web-chat/devops_chat.mjs`），这里是同一条规矩。

## 规则

  · 正文按"段"记：模型正文的段号 = 本轮已经开始过几次工具调用；流式工具（如
    `investigate_live`）直接吐给用户的文字另算一种来源。
  · 一段**非空白**正文开始时，若上一段已发正文属于另一段 → 先补足换行，保证两段之间至少
    一个空行（已有的换行算数：上一段以 `\\n` 结尾、或这一段以 `\\n` 开头，都只补差额，
    不会叠出三四个空行）。
  · 本轮第一段正文、同一段里的后续 delta、纯空白 delta → 什么都不补。

## 刻意不做的

  · **不改 Strands 的 chunk**：分隔符由调用方作为一个**单独的**文本事件先发出去
    （见 `main.py::_stream_events`），不往模型的 delta 里拼 —— Strands 在我们处理完事件之后
    才把 delta 累积进 `agent.messages`，就地改会把这些换行写进模型自己的历史（AgentCore Memory）。
  · **不按 `contentBlockIndex` 变化分段**：同一条消息里连续几个文本块（如带引用的回答）
    本来就该连着读，只有工具调用才是"另起一段"的信号。

零依赖、纯逻辑：`tests/test_agent_paragraphs.py` 按文件路径直接加载它来钉（同 `thinking_steps.py`）。
`agent/paragraphs.py` 是它逐字节相同的副本（权威手写副本那棵树用），同一个测试钉着两份一致。
"""

from __future__ import annotations

# 只用来数已发正文结尾的换行，留几个字符就够（多于 2 个换行的情况一律视为"已经分好段"）。
_TAIL_KEEP = 8


def _trailing_newlines(s: str) -> int:
    """结尾空白里有几个换行（`"a\\n \\n "` → 2）。"""
    return s[len(s.rstrip()):].count("\n")


def _leading_newlines(s: str) -> int:
    """开头空白里有几个换行。"""
    return s[:len(s) - len(s.lstrip())].count("\n")


class ParagraphJoiner:
    """一轮回答一个实例。只做两件事：记"上一段正文是哪一段"，算"这段前面要补几个换行"。"""

    def __init__(self) -> None:
        self._tail = ""      # 已发正文的末尾几个字符（只用来数换行）
        self._seg = 0        # 本轮已开始过几次工具调用
        self._last = None    # 上一段**非空白**正文的段键 (来源, 段号)；None = 本轮还没发过正文

    def tool_call(self) -> None:
        """模型发起了一次工具调用（`contentBlockStart.start.toolUse`）。之后的模型正文是新的一段。"""
        self._seg += 1

    def lead(self, text: str, source: str = "model") -> str:
        """`text` 即将作为正文发出：返回要在它**前面**单独发出的分隔符（`""` / `"\\n"` / `"\\n\\n"`），
        并把（分隔符 +）`text` 记为已发。

        `source`："model" = 模型正文；"tool" = 流式工具直接吐给用户的文字。
        """
        if not text:
            return ""
        sep = ""
        if text.strip():
            key = (source, self._seg)
            if self._last is not None and key != self._last:
                sep = "\n" * max(0, 2 - _trailing_newlines(self._tail) - _leading_newlines(text))
            self._last = key
        self._tail = (self._tail + sep + text)[-_TAIL_KEEP:]
        return sep
