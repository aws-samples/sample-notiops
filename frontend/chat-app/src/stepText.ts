/**
 * 「思考过程」面板单步文字的**极小** markdown 子集 —— 纯函数（无 React、无 DOM），可单测。
 *
 * ## 为什么要有这个模块
 *
 * 面板（ThinkingPanel）收的步骤文字有好几个来源，其中几个**按 markdown 写**：
 *   · 深度调查进度行（`bff/web-chat/devops_investigate.mjs::recordProgressLine`，agent 侧
 *     `core/devops_agent.py::_record_progress_line` 同形）：`**🔭 Observation：标题**`、
 *     `` 🔧 调用工具：`use_aws` ``。这个格式**不能改** —— IM 卡片读同一份、按 markdown 渲染；
 *   · DevOps 对话的过程行：`` 已连接 Agent Space `as-…` ``；
 *   · 模型的明文思考（Kimi K3 常带 `**小标题**` / `### 小节`）。
 * 面板原来把它们当纯文本原样输出，用户看到的是一堆 `**` 和反引号（2026-10-13 现网）。
 *
 * ## 只认三样，其余都是纯文本
 *
 *   1. `**粗体**` —— 开头的 `**` 后面紧跟非空白、结尾的 `**` 前面紧跟非空白、中间至少一个字符，
 *      且必须在**同一行**里成对；不成对的星号原样保留（宁可露一个星号，也不吞内容）；
 *   2. `` `行内代码` `` —— 同一行里成对的单个反引号、中间至少一个字符；代码里的 `**` 不再解析；
 *   3. 行首 `#`~`######` + 空白 的 ATX 标题 —— 去掉井号（和可选的收尾井号），整行加粗。
 *
 * 链接、列表、斜体、表格一律不碰：列表本来就靠 pre-wrap 的换行读得懂，斜体的 `_` / `*` 在
 * `use_aws`、`a * b` 这类内容里误伤面太大，链接在过程行里没有出现过、也不该在面板里变成可点的东西。
 * **不产出 HTML**：返回的是结构化片段，渲染层只拿它们拼 React 文本节点 / `<strong>` / `<code>`。
 */

/** 一行里的一段：纯文本 / 粗体 / 代码（粗体里可以有代码）。 */
export type StepSpan = { text: string; bold?: boolean; code?: boolean };
/** 一行：若干段；`heading` = 这一行原本是 `#` 标题（渲染层整行加粗）。 */
export type StepLine = { spans: StepSpan[]; heading?: boolean };

const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** 从 `from` 起找一个能当闭合的 `**`（跳过代码段；前一个字符非空白）。找不到返回 -1。 */
function closingBold(s: string, from: number): number {
  for (let k = from; k < s.length - 1; k++) {
    if (s[k] === "`") {
      const j = s.indexOf("`", k + 1);
      if (j > k + 1) { k = j; continue; }
    }
    if (s[k] === "*" && s[k + 1] === "*" && !isSpace(s[k - 1])) return k;
  }
  return -1;
}

function parseInline(s: string): StepSpan[] {
  const out: StepSpan[] = [];
  let bold = false;
  let buf = "";
  const push = (text: string, code = false) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (!code && last && !last.code && Boolean(last.bold) === bold) { last.text += text; return; }
    out.push({ text, ...(bold ? { bold: true } : {}), ...(code ? { code: true } : {}) });
  };
  const flush = () => { push(buf); buf = ""; };
  for (let i = 0; i < s.length;) {
    if (s[i] === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) { flush(); push(s.slice(i + 1, j), true); i = j + 1; continue; }
    }
    if (s[i] === "*" && s[i + 1] === "*") {
      // 开：后面紧跟非空白，且这一行后面还有能闭合它的 `**`（至少隔一个字符）。
      if (!bold && !isSpace(s[i + 2]) && closingBold(s, i + 3) >= 0) { flush(); bold = true; i += 2; continue; }
      // 闭：前面紧跟非空白。
      if (bold && !isSpace(s[i - 1])) { flush(); bold = false; i += 2; continue; }
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

/** 把一步的文字拆成行 + 段。空串 → 空数组。行与行之间的换行由渲染层补回（pre-wrap 靠它分段）。 */
export function parseStepText(text: string): StepLine[] {
  if (!text) return [];
  return text.split("\n").map((line) => {
    const h = HEADING_RE.exec(line);
    if (h) return { spans: parseInline(h[1] ?? ""), heading: true };
    return { spans: parseInline(line) };
  });
}
