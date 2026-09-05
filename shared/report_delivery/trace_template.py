"""
HTML template for the full investigation trace/process view.

Shows every step the DevOps Agent took during the investigation:
- User prompts
- Agent thinking (if available)
- Tool calls and results
- Assistant responses
- Timestamps and record types

Separate from the final report — this is the "how we got there" view.
"""

import json
import re
from datetime import datetime, timezone


_TITLE_MAX_CHARS = 140
"""标题显示上限。理由同 `html_template._TITLE_MAX_CHARS`（两页要一致）。"""


def generate_trace_html(
    records, status, priority, detail_type,
    task_id, execution_id, agent_space_id,
    created_at, updated_at, title="", timeline_md="", fetch_errors=None,
):
    """Generate an HTML page showing the full investigation process.

    `title`：本次调查的标题 / 问题描述。理由与转义要求见
    `html_template.generate_html_report`（同一段用户原文，同样不许进日志）。

    `timeline_md`：DevOps Agent 自己那张「Investigation timeline」卡片摊平成的
    markdown（`core.da_ui_tree.timeline_md`）。

    🔴 为什么要它（2026-09-05，用户报障 D2 的后半）：本页原来只渲染**原始
    journal 记录**（tool_use / tool_result / thinking 一条一条铺开）。那是给
    我们排障用的视图，不是用户在后台看到的那条「调查时间线」。用户明确要的是
    后台那条 —— 所以现在两段都有：上面是 DA 整理过的时间线，下面是原始记录。

    `fetch_errors`：拉记录时**失败的原因**（`shared.devops_agent
    .list_journal_records_cross_account` 的 `errors` 出参）。

    🔴 为什么必须区分（同一个报障）：原来记录为空时页面只写一句
    "No records found."，而实测那句话有两个完全不同的成因 ——
    「这次调查确实没有记录」和「跨账号取记录失败了（方式A 的
    `trigger_role_arn` 缺字段 → KeyError 被吞 → 恒返回 `[]`）」。
    两者的下一步天差地别，而页面把它们显示成同一句话，
    于是一个**配置缺陷**在现网被当成「调查没留痕」看了很久。
    """
    status_color = {
        "COMPLETED": "#10b981", "FAILED": "#ef4444",
        "TIMED_OUT": "#f59e0b", "CANCELLED": "#6b7280",
    }.get(status, "#3b82f6")

    status_emoji = {
        "COMPLETED": "✅", "FAILED": "❌",
        "TIMED_OUT": "⏰", "CANCELLED": "🚫",
    }.get(status, "ℹ️")

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # Build timeline entries from records
    timeline_html = _build_timeline(records, fetch_errors=fetch_errors)
    entry_count = len(records or ())

    # DA 自己那张时间线卡（curated view）。为空就整段不渲染 —— 留一个空标题
    # 会让人以为「DA 什么都没记」，而实际是这次调查没产出那张卡。
    da_timeline_html = _md_lite(timeline_md)
    da_block = (
        f'    <h2>{_esc(_DA_TIMELINE_HEADING)}</h2>\n'
        f'    <div class="da-timeline">{da_timeline_html}</div>\n'
        if da_timeline_html else ""
    )
    raw_heading = (_RAW_RECORDS_HEADING if da_block else _TIMELINE_HEADING)

    # 🔴 头部元数据一律 HTML-escape 后再插进 f-string。
    #    这些值来自 DevOps Agent 的 callback event（外部输入），而本模板此前
    #    是**裸插**的 —— 与 html_template.py:43-52 那段注释所修的正是同一类
    #    问题，只是当时漏了这一份。
    status = _esc(status)
    priority = _esc(priority)
    detail_type = _esc(detail_type)
    task_id_short = _esc(str(task_id)[:12])
    task_id = _esc(task_id)
    execution_id = _esc(execution_id)
    agent_space_id = _esc(agent_space_id)
    created_at = _esc(created_at)
    updated_at = _esc(updated_at)

    raw_title = " ".join(str(title or "").split())
    if len(raw_title) > _TITLE_MAX_CHARS:
        raw_title = raw_title[:_TITLE_MAX_CHARS - 1] + "…"
    title_esc = _esc(raw_title)
    doc_title = f"🔍 {raw_title}" if raw_title else f"🔍 Investigation Trace — {task_id_short}"
    doc_title = _esc(doc_title)
    title_block = f'\n    <div class="ttl">{title_esc}</div>' if title_esc else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{doc_title}</title>
<style>
:root {{
  --c-dark:#232f3e; --c-blue:#37475a; --c-orange:#ff9900;
  --t1:#1a1a2e; --t2:#4a5568; --t3:#718096;
  --bg1:#fff; --bg2:#f7f8fa; --bg3:#edf2f7;
  --bdr:#e2e8f0; --r-sm:6px; --r-lg:16px;
}}
*{{margin:0;padding:0;box-sizing:border-box}}
html{{scroll-behavior:smooth}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
  line-height:1.6;color:var(--t1);background:var(--bg2);-webkit-font-smoothing:antialiased}}
.page{{max-width:1200px;margin:0 auto;padding:24px}}

.header{{background:linear-gradient(135deg,#1a365d,#2a4365,#1a202c);
  color:#fff;padding:36px 48px;border-radius:var(--r-lg) var(--r-lg) 0 0;position:relative;overflow:hidden}}
.header::before{{content:'';position:absolute;top:-50%;right:-20%;width:500px;height:500px;
  background:radial-gradient(circle,rgba(66,153,225,.15),transparent 70%);border-radius:50%}}
.header h1{{font-size:24px;font-weight:700;position:relative}}
.header .ttl{{font-size:15px;font-weight:500;margin-top:10px;position:relative;
  opacity:.95;line-height:1.5;word-break:break-word;
  padding-left:12px;border-left:3px solid #4299e1}}
.header .sub{{opacity:.7;font-size:13px;margin-top:4px;position:relative}}
.header .bar{{width:60px;height:4px;background:#4299e1;border-radius:2px;margin-top:14px;position:relative}}

.status{{background:#ebf8ff;border-left:4px solid #4299e1;
  padding:12px 48px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:14px}}
.badge{{display:inline-flex;padding:3px 12px;border-radius:16px;font-weight:600;font-size:12px;color:#fff}}

.meta{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
  gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}}
.mc{{background:var(--bg1);padding:12px 20px}}
.mc .l{{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.8px;font-weight:600}}
.mc .v{{font-size:13px;font-weight:600;margin-top:2px;word-break:break-all}}
.mono{{font-family:'SF Mono','Fira Code',monospace;font-size:11px!important}}

.stats{{background:var(--bg1);padding:16px 48px;border-bottom:1px solid var(--bdr);
  display:flex;gap:32px;flex-wrap:wrap;font-size:13px;color:var(--t2)}}
.stats strong{{color:var(--t1)}}

.timeline{{background:var(--bg1);padding:32px 48px;border-radius:0 0 var(--r-lg) var(--r-lg)}}
.timeline h2{{color:var(--c-dark);font-size:18px;margin-bottom:20px;
  padding-bottom:8px;border-bottom:2px solid #4299e1}}
.timeline h2+h2,.da-timeline+h2{{margin-top:36px}}

.da-timeline{{font-size:14px;color:var(--t2);margin-bottom:8px}}
.da-timeline h3{{color:var(--c-blue);font-size:15px;font-weight:600;margin:18px 0 8px;
  padding-left:10px;border-left:3px solid var(--c-orange)}}
.da-timeline p{{margin:8px 0}}
.da-timeline li{{margin:4px 0 4px 20px}}
.da-timeline code{{background:#f1f5f9;color:#be185d;padding:1px 6px;border-radius:3px;
  font-size:12.5px;font-family:'SF Mono','Fira Code','Consolas',monospace}}
.da-timeline strong{{color:var(--t1)}}

.empty{{padding:16px 18px;background:#fffbeb;border-left:4px solid var(--c-orange);
  border-radius:var(--r-sm);font-size:13px;color:var(--t2)}}
.empty ul{{margin:8px 0 0 20px}}
.empty li{{margin:3px 0}}
.empty code{{font-family:'SF Mono','Fira Code',monospace;font-size:12px;
  background:#fff;padding:1px 5px;border-radius:3px}}

.entry{{position:relative;padding:16px 0 16px 32px;border-left:2px solid var(--bdr)}}
.entry:last-child{{border-left-color:transparent}}
.entry::before{{content:'';position:absolute;left:-6px;top:20px;width:10px;height:10px;
  border-radius:50%;border:2px solid var(--bdr);background:var(--bg1)}}

.entry.user::before{{background:#4299e1;border-color:#4299e1}}
.entry.assistant::before{{background:#48bb78;border-color:#48bb78}}
.entry.tool-use::before{{background:#ed8936;border-color:#ed8936}}
.entry.tool-result::before{{background:#9f7aea;border-color:#9f7aea}}
.entry.thinking::before{{background:#fc8181;border-color:#fc8181}}
.entry.system::before{{background:#a0aec0;border-color:#a0aec0}}
.entry.other::before{{background:#cbd5e0;border-color:#cbd5e0}}

.entry-header{{display:flex;align-items:center;gap:10px;margin-bottom:6px}}
.entry-type{{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
  padding:2px 8px;border-radius:4px;color:#fff}}
.type-user{{background:#4299e1}}
.type-assistant{{background:#48bb78}}
.type-tool-use{{background:#ed8936}}
.type-tool-result{{background:#9f7aea}}
.type-thinking{{background:#fc8181}}
.type-system{{background:#a0aec0}}
.type-other{{background:#cbd5e0;color:var(--t1)}}
.entry-time{{font-size:11px;color:var(--t3);font-family:'SF Mono',monospace}}
.entry-id{{font-size:10px;color:var(--t3);font-family:'SF Mono',monospace}}

.entry-body{{font-size:13px;color:var(--t2);max-height:400px;overflow-y:auto;
  padding:10px 14px;background:var(--bg2);border-radius:var(--r-sm);border:1px solid var(--bdr)}}
.entry-body pre{{white-space:pre-wrap;word-break:break-word;font-size:12px;
  font-family:'SF Mono','Fira Code',monospace;margin:0}}
.entry-body.collapsed{{max-height:120px}}
.entry-body.collapsed::after{{content:'... click to expand';display:block;
  text-align:center;color:var(--c-orange);font-size:11px;margin-top:4px;cursor:pointer}}

.toggle-btn{{font-size:11px;color:var(--c-orange);cursor:pointer;border:none;
  background:none;padding:2px 6px;margin-left:8px}}
.toggle-btn:hover{{text-decoration:underline}}

.footer{{text-align:center;padding:16px;font-size:11px;color:var(--t3);margin-top:8px}}

@media print{{body{{background:#fff}}.page{{padding:0}}.header,.timeline{{border-radius:0}}
  .entry-body{{max-height:none!important}}}}
@media(max-width:768px){{.header,.timeline,.stats{{padding-left:20px;padding-right:20px}}
  .meta{{grid-template-columns:1fr 1fr}}.entry{{padding-left:20px}}}}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>🔍 Investigation Trace — Analysis Process</h1>{title_block}
    <div class="sub">{detail_type} &middot; {generated_at}</div>
    <div class="bar"></div>
  </div>
  <div class="status">
    <span class="badge" style="background:{status_color}">{status}</span>
    <span>Task: <code style="font-size:12px">{task_id}</code></span>
    <span>Execution: <code style="font-size:12px">{execution_id}</code></span>
  </div>
  <div class="meta">
    <div class="mc"><div class="l">Started</div><div class="v">{created_at}</div></div>
    <div class="mc"><div class="l">Completed</div><div class="v">{updated_at}</div></div>
    <div class="mc"><div class="l">Agent Space</div><div class="v mono">{agent_space_id}</div></div>
    <div class="mc"><div class="l">Priority</div><div class="v">{priority}</div></div>
  </div>
  <div class="stats">
    <span>Total steps: <strong>{entry_count}</strong></span>
  </div>
  <div class="timeline">
{da_block}    <h2>{raw_heading}</h2>
{timeline_html}
  </div>
  <div class="footer">
    Investigation Trace &middot; Generated by DevOps Agent Report Handler
  </div>
</div>
<script>
document.querySelectorAll('.toggle-btn').forEach(btn => {{
  btn.addEventListener('click', () => {{
    const body = btn.closest('.entry').querySelector('.entry-body');
    body.classList.toggle('collapsed');
    btn.textContent = body.classList.contains('collapsed') ? 'expand' : 'collapse';
  }});
}});
</script>
</body>
</html>"""


_DA_TIMELINE_HEADING = "Investigation Timeline"
"""DA 那张整理过的时间线卡的小标题（与后台面板同名，便于对照）。"""

_RAW_RECORDS_HEADING = "Raw Journal Records"
"""原始记录段的小标题 —— 只在上面那段**也在**时用，避免两个 Timeline 打头。"""

_TIMELINE_HEADING = "Investigation Timeline"
"""只有原始记录时沿用原标题（保持既有页面观感不变）。"""


def _build_timeline(records, fetch_errors=None):
    """Convert journal records into timeline HTML entries.

    `fetch_errors`：取记录失败的原因列表。空/None = 取成功。
    见 `generate_trace_html` 里为什么必须把「取失败」和「确实没有」分开。
    """
    entries = []
    for i, r in enumerate(records or ()):
        record_type = r.get("recordType", "unknown")
        record_id = r.get("recordId", "")
        created = r.get("createdAt", "")
        if isinstance(created, datetime):
            created = created.strftime("%H:%M:%S")
        elif isinstance(created, str) and len(created) > 19:
            created = created[11:19]  # Extract HH:MM:SS from ISO

        content = r.get("content", "")
        role, display_type, body_html = _parse_record(content, record_type)

        css_class = _type_to_css(role or record_type)
        type_label = role or record_type or "unknown"
        collapsed = "collapsed" if len(body_html) > 500 else ""

        entries.append(f"""
    <div class="entry {css_class}">
      <div class="entry-header">
        <span class="entry-type type-{css_class}">{_esc(type_label)}</span>
        <span class="entry-time">{_esc(created)}</span>
        <span class="entry-id">{_esc(record_id[:20])}</span>
        {"<button class='toggle-btn'>expand</button>" if collapsed else ""}
      </div>
      <div class="entry-body {collapsed}">
        <pre>{body_html}</pre>
      </div>
    </div>""")

    if entries:
        return "\n".join(entries)

    # ── 空态。**两个完全不同的成因，必须显示成两句不同的话。** ──────────────
    #    以前这里恒是 "No records found."，于是一个跨账号取数**失败**在现网
    #    被当成「这次调查没留痕」看了很久（用户 2026-09-05 报障 D2）。
    if fetch_errors:
        items = "\n".join(f"      <li>{_esc(str(m))}</li>"
                          for m in list(fetch_errors)[:5])
        return (
            '    <div class="empty">\n'
            "      <b>无法读取调查记录</b>（不是「本次调查没有记录」）。"
            "报告正文不受影响，只有这一页取不到数据。原因：\n"
            f"      <ul>\n{items}\n      </ul>\n"
            "      如果原因里提到 <code>trigger_role_arn</code>，"
            "请到管理页重新接入该账号（接入会创建 Trigger Role 并回写 ARN）。\n"
            "    </div>"
        )
    return (
        '    <div class="empty">\n'
        "      本次调查没有留下逐步记录（DevOps Agent 未产出 journal 记录）。"
        "调查结论请看「查看调查报告」那一页。\n"
        "    </div>"
    )


# 只处理 `core.da_ui_tree` 会产出的那几种记号 —— 它不是通用 markdown 渲染器。
_MD_H3_RE = re.compile(r"^(#{3,6})\s+(.*)$")
_MD_LI_RE = re.compile(r"^[-*]\s+(.*)$")
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_MD_CODE_RE = re.compile(r"`([^`]+)`")


def _md_lite(md: str) -> str:
    """把 `core.da_ui_tree` 产出的**受限** markdown 渲染成 HTML 片段。

    支持：`### ~ ###### 标题` / `- 列表项` / `**粗体**` / `` `行内代码` `` /
    其余按段落。产出为空（入参空/全空白）时返回空串，由调用方决定整段不渲染。

    🔴 **先 escape 再套记号**：`_esc` 走在最前面，所以之后的正则只可能在
    已转义的文本上加我们自己生成的标签 —— 内容里的 `<script>` 早已成为
    `&lt;script&gt;`，没有注入面。顺序颠倒就是一个 XSS。

    ⚠️ 故意**不**支持表格 / 链接 / 代码块。这一段的来源是 DA 的组件树
    （`markdown` / `badge` / `list-item` 叶子），实测只有上面那几种记号；
    多写的分支既没有输入能覆盖，也就没有测试能守住。要渲染任意 markdown
    请走 `html_template` 那份客户端渲染器。
    """
    text = (md or "").strip()
    if not text:
        return ""
    out: list[str] = []
    in_list = False

    def _inline(s: str) -> str:
        s = _esc(s)
        s = _MD_BOLD_RE.sub(r"<strong>\1</strong>", s)
        s = _MD_CODE_RE.sub(r"<code>\1</code>", s)
        return s

    def _close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            _close_list()
            continue
        m = _MD_H3_RE.match(stripped)
        if m:
            _close_list()
            out.append(f"<h3>{_inline(m.group(2))}</h3>")
            continue
        m = _MD_LI_RE.match(stripped)
        if m:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_inline(m.group(1))}</li>")
            continue
        _close_list()
        out.append(f"<p>{_inline(stripped)}</p>")
    _close_list()
    return "\n".join(out)


def _parse_record(content, record_type):
    """Parse a record's content and return (role, display_type, body_html)."""
    # Try JSON parse
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return (record_type, record_type, _esc(content))

    if not isinstance(content, dict):
        return (record_type, record_type, _esc(str(content)))

    role = content.get("role", record_type)

    # Extract content blocks
    inner = content.get("content", "")
    if isinstance(inner, str):
        try:
            inner = json.loads(inner)
        except (json.JSONDecodeError, TypeError):
            return (role, role, _esc(inner))

    if isinstance(inner, list):
        parts = []
        for block in inner:
            if not isinstance(block, dict):
                parts.append(_esc(str(block)[:1000]))
                continue

            btype = block.get("type", "")

            if btype == "text":
                text = block.get("text", "")
                parts.append(f"<b>[text]</b>\n{_esc(text)}")

            elif btype == "thinking":
                text = block.get("thinking", "")
                if text:
                    # Show first 2000 chars of thinking (usually very long with signatures)
                    display = text[:2000]
                    suffix = f"\n\n... ({len(text)} chars total)" if len(text) > 2000 else ""
                    parts.append(f"<b>[thinking]</b>\n{_esc(display)}{suffix}")

            elif btype == "tool_use":
                name = block.get("tool_name", "unknown")
                inp = block.get("input", {})
                inp_str = json.dumps(inp, indent=2, ensure_ascii=False, default=str)
                parts.append(f"<b>[tool_use: {_esc(name)}]</b>\n{_esc(inp_str)}")

            elif btype == "tool_result":
                tid = block.get("id", "")
                rc = block.get("content", "")
                if isinstance(rc, list):
                    rc = "\n".join(
                        b.get("text", str(b)) if isinstance(b, dict) else str(b)
                        for b in rc
                    )
                elif isinstance(rc, dict):
                    rc = json.dumps(rc, indent=2, ensure_ascii=False, default=str)
                rc_str = str(rc)
                # Truncate very large tool results (>10K) but keep most content
                if len(rc_str) > 10000:
                    rc_str = rc_str[:10000] + f"\n\n... ({len(str(rc))} chars total, truncated)"
                parts.append(f"<b>[tool_result]</b>\n{_esc(rc_str)}")

            else:
                parts.append(f"<b>[{_esc(btype)}]</b>\n{_esc(str(block))}")

        return (role, role, "\n\n".join(parts))

    # Fallback: dump the dict
    return (role, role, _esc(json.dumps(content, indent=2, ensure_ascii=False, default=str)))


def _type_to_css(t):
    """Map record type/role to CSS class."""
    t = t.lower()
    if t in ("user",):
        return "user"
    if t in ("assistant",):
        return "assistant"
    if "tool_use" in t or "tool-use" in t:
        return "tool-use"
    if "tool_result" in t or "tool-result" in t:
        return "tool-result"
    if "thinking" in t:
        return "thinking"
    if "system" in t:
        return "system"
    return "other"


def _esc(text):
    """Escape HTML."""
    if not isinstance(text, str):
        text = str(text)
    # Remove surrogates
    text = re.sub(r"[\ud800-\udfff]", "", text)
    return (text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;"))
