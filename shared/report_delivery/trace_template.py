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


def generate_trace_html(
    records, status, priority, detail_type,
    task_id, execution_id, agent_space_id,
    created_at, updated_at,
):
    """Generate an HTML page showing the full investigation process."""
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
    timeline_html = _build_timeline(records)
    entry_count = len(records)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🔍 Investigation Trace — {task_id[:12]}</title>
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
    <h1>🔍 Investigation Trace — Analysis Process</h1>
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
    <h2>Investigation Timeline</h2>
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


def _build_timeline(records):
    """Convert journal records into timeline HTML entries."""
    entries = []
    for i, r in enumerate(records):
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

    return "\n".join(entries) if entries else "<p>No records found.</p>"


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
