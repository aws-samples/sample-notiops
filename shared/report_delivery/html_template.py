"""
HTML report template for DevOps Agent investigation results.

Uses client-side Markdown rendering via inline JavaScript for accurate
formatting of tables, lists, code blocks, headings, etc.
No external CDN dependencies — fully self-contained.
"""

import html
import json
import re
from datetime import datetime, timezone

_TITLE_MAX_CHARS = 140
"""报告页标题的显示上限（字符数）。

用户在 IM 里问的那句话可能很长（实测有贴一整段报错的）。整段塞进 `<h1>` 会
把页头撑成一屏，也塞不进 `<title>`。超出部分以 `…` 收尾 —— 正文里有完整问题，
这里只需要「一眼认出是哪次调查」。
"""


def generate_html_report(
    summary_md, status, priority, detail_type,
    task_id, execution_id, agent_space_id,
    created_at, updated_at, title="",
):
    """Generate a polished, self-contained HTML report from Markdown content.

    `title`：本次调查的**标题 / 问题描述**（通常就是用户在 IM 里问的那句话）。

    🔴 为什么加这个参数（2026-09-05，用户报障 D1）：在此之前整页只有
    「NotiOps Report」+ task_id/execution_id 两串 uuid。用户跑了几次调查之后
    收到几个链接，点开谁也认不出哪个报告对应哪次提问 —— 报告本身写得再好，
    找不到就等于没有。

    ⚠️ 空串是**合法**入参（`task#` 行 TTL 24h 过期、或调查不是从聊天发起的），
    此时页面退回原来的通用标题，**不要**编一个占位标题假装有。

    ⚠️ 这段文字是用户原文（不可信输入 + 隐私内容）：
      · 必须 HTML-escape 后再插进 f-string（下面统一做）；
      · **SHALL NOT 进任何日志、SHALL NOT 进 S3 key** —— key 会进 CloudTrail
        data event 并长期留存。
    """
    status_color = {
        "COMPLETED": "#10b981", "FAILED": "#ef4444",
        "TIMED_OUT": "#f59e0b", "CANCELLED": "#6b7280",
    }.get(status, "#3b82f6")

    status_emoji = {
        "COMPLETED": "✅", "FAILED": "❌",
        "TIMED_OUT": "⏰", "CANCELLED": "🚫",
    }.get(status, "ℹ️")

    status_bg = {
        "COMPLETED": "#ecfdf5", "FAILED": "#fef2f2",
        "TIMED_OUT": "#fffbeb", "CANCELLED": "#f9fafb",
    }.get(status, "#eff6ff")

    priority_color = {
        "CRITICAL": "#ef4444", "HIGH": "#f59e0b",
        "MEDIUM": "#3b82f6", "LOW": "#10b981", "MINIMAL": "#6b7280",
    }.get(priority, "#3b82f6")

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # 头部元数据是服务端 f-string 直接插进 HTML（不经客户端 esc()），来自 DevOps Agent
    # callback event，须在此 HTML-escape 防属性/标签注入（XSS）。color/emoji 仍用原始值查表。
    status = html.escape(str(status), quote=True)
    priority = html.escape(str(priority), quote=True)
    detail_type = html.escape(str(detail_type), quote=True)
    task_id = html.escape(str(task_id), quote=True)
    execution_id = html.escape(str(execution_id), quote=True)
    agent_space_id = html.escape(str(agent_space_id), quote=True)
    created_at = html.escape(str(created_at), quote=True)
    updated_at = html.escape(str(updated_at), quote=True)

    # 标题：先按显示长度截断**再** escape（反过来会把 `&amp;` 切成 `&am`）。
    raw_title = " ".join(str(title or "").split())      # 折叠换行/多空格
    if len(raw_title) > _TITLE_MAX_CHARS:
        raw_title = raw_title[:_TITLE_MAX_CHARS - 1] + "…"
    title_esc = html.escape(raw_title, quote=True)
    # <title> 里也带上，浏览器标签页/收藏夹/IM 链接预览都直接可读。
    doc_title = f"{status_emoji} {raw_title}" if raw_title else f"{status_emoji} NotiOps Report"
    doc_title = html.escape(doc_title, quote=True)
    title_block = f'\n    <div class="ttl">{title_esc}</div>' if title_esc else ""

    # Escape markdown for safe embedding in JS template literal
    md_escaped = (summary_md
        .replace("\\", "\\\\")
        .replace("`", "\\`")
        .replace("${", "\\${")
        .replace("</script>", "<\\/script>"))

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{doc_title}</title>
<style>
:root {{
  --c-dark:#232f3e; --c-blue:#37475a; --c-orange:#ff9900; --c-orange-l:#ffb84d;
  --t1:#1a1a2e; --t2:#4a5568; --t3:#718096;
  --bg1:#fff; --bg2:#f7f8fa; --bg3:#edf2f7;
  --bdr:#e2e8f0; --bdr-l:#f0f0f0;
  --r-sm:6px; --r-lg:16px;
}}
*{{margin:0;padding:0;box-sizing:border-box}}
html{{scroll-behavior:smooth}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
  line-height:1.7;color:var(--t1);background:var(--bg2);-webkit-font-smoothing:antialiased}}
.page{{max-width:1100px;margin:0 auto;padding:24px}}

.header{{background:linear-gradient(135deg,var(--c-dark),#1a2332,#0d1b2a);
  color:#fff;padding:40px 48px;border-radius:var(--r-lg) var(--r-lg) 0 0;position:relative;overflow:hidden}}
.header::before{{content:'';position:absolute;top:-50%;right:-20%;width:500px;height:500px;
  background:radial-gradient(circle,rgba(255,153,0,.15),transparent 70%);border-radius:50%}}
.header h1{{font-size:26px;font-weight:700;position:relative}}
.header .ttl{{font-size:16px;font-weight:500;margin-top:10px;position:relative;
  opacity:.95;line-height:1.5;word-break:break-word;
  padding-left:12px;border-left:3px solid var(--c-orange)}}
.header .sub{{opacity:.7;font-size:14px;margin-top:4px;position:relative}}
.header .bar{{width:60px;height:4px;background:var(--c-orange);border-radius:2px;margin-top:16px;position:relative}}

.status{{background:{status_bg};border-left:4px solid {status_color};
  padding:14px 48px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}}
.badge{{display:inline-flex;padding:4px 14px;border-radius:20px;font-weight:600;font-size:13px;color:#fff}}

.meta{{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}}
.mc{{background:var(--bg1);padding:14px 24px}}
.mc .l{{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.8px;font-weight:600}}
.mc .v{{font-size:14px;font-weight:600;margin-top:2px;word-break:break-all}}
.mono{{font-family:'SF Mono','Fira Code',monospace;font-size:11px!important}}

#toc{{background:var(--bg1);border-bottom:1px solid var(--bdr);
  padding:14px 48px;display:none;flex-wrap:wrap;gap:6px;align-items:center}}
#toc.show{{display:flex}}
#toc .tt{{font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;
  letter-spacing:.8px;margin-right:8px}}
#toc a{{font-size:12px;color:var(--c-blue);text-decoration:none;
  padding:3px 10px;border-radius:4px;background:var(--bg3);transition:all .15s}}
#toc a:hover{{background:var(--c-orange);color:#fff}}

.content{{background:var(--bg1);padding:40px 48px;border-radius:0 0 var(--r-lg) var(--r-lg)}}
.content h1{{display:none}}
.content h2{{color:var(--c-dark);font-size:20px;font-weight:700;
  margin:32px 0 14px;padding-bottom:8px;border-bottom:3px solid var(--c-orange)}}
.content h2:first-child{{margin-top:0}}
.content h3{{color:var(--c-blue);font-size:16px;font-weight:600;
  margin:24px 0 10px;padding-left:12px;border-left:3px solid var(--c-orange-l)}}
.content h4{{color:var(--t2);font-size:14px;font-weight:600;margin:18px 0 8px}}
.content p{{margin:8px 0;color:var(--t2);font-size:14px}}
.content strong{{color:var(--t1)}}
.content em{{color:var(--t2)}}
.content hr{{border:none;height:1px;background:linear-gradient(to right,var(--bdr),transparent);margin:28px 0}}
.content blockquote{{border-left:3px solid var(--c-orange);padding:8px 16px;
  margin:12px 0;background:#fffbeb;border-radius:0 6px 6px 0;color:var(--t2)}}

.content pre{{background:#1e293b;color:#e2e8f0;padding:18px 22px;
  border-radius:var(--r-sm);overflow-x:auto;font-size:12.5px;line-height:1.6;
  margin:14px 0;border:1px solid #334155;
  font-family:'SF Mono','Fira Code','Consolas',monospace}}
.content code{{background:#f1f5f9;color:#be185d;padding:1px 6px;border-radius:3px;
  font-size:12.5px;font-family:'SF Mono','Fira Code','Consolas',monospace}}
.content pre code{{background:none;color:inherit;padding:0;font-size:inherit}}

.content table{{width:100%;border-collapse:separate;border-spacing:0;
  margin:14px 0;border-radius:var(--r-sm);overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid var(--bdr);font-size:13px}}
.content th{{background:var(--c-dark);color:#fff;padding:10px 14px;
  text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}}
.content td{{padding:8px 14px;border-bottom:1px solid var(--bdr-l)}}
.content tr:last-child td{{border-bottom:none}}
.content tr:nth-child(even) td{{background:#fafbfc}}
.content tr:hover td{{background:#f0f4ff}}

.content ul,.content ol{{padding-left:22px;margin:8px 0}}
.content li{{margin:5px 0;color:var(--t2);font-size:14px}}
.content li::marker{{color:var(--c-orange)}}
.content li>ul,.content li>ol{{margin:4px 0}}

.footer{{text-align:center;padding:18px;font-size:11px;color:var(--t3);margin-top:8px}}

@media print{{body{{background:#fff}}.page{{padding:0}}.header,.content{{border-radius:0}}
  #toc{{display:none}}.content pre{{white-space:pre-wrap}}}}
@media(max-width:768px){{.header,.content,.status{{padding-left:20px;padding-right:20px}}
  #toc{{padding-left:20px;padding-right:20px}}.meta{{grid-template-columns:1fr 1fr}}}}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>{status_emoji} NotiOps Report</h1>{title_block}
    <div class="sub">{detail_type} &middot; {generated_at}</div>
    <div class="bar"></div>
  </div>
  <div class="status">
    <span class="badge" style="background:{status_color}">{status}</span>
    <span class="badge" style="background:{priority_color}">Priority: {priority}</span>
  </div>
  <div class="meta">
    <div class="mc"><div class="l">Task ID</div><div class="v mono">{task_id}</div></div>
    <div class="mc"><div class="l">Execution ID</div><div class="v mono">{execution_id}</div></div>
    <div class="mc"><div class="l">Started</div><div class="v">{created_at}</div></div>
    <div class="mc"><div class="l">Completed</div><div class="v">{updated_at}</div></div>
    <div class="mc"><div class="l">Agent Space</div><div class="v mono">{agent_space_id}</div></div>
  </div>
  <nav id="toc"></nav>
  <div class="content" id="rc"></div>
  <div class="footer">Generated by DevOps Agent Report Handler</div>
</div>
<script>
(function(){{
const md=`{md_escaped}`;
function esc(s){{return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}}
// URL scheme 白名单：只允许 http/https/mailto/相对(#、/)链接，拦截 javascript:/data:/vbscript:
// 等可执行 scheme（防 XSS：markdown 链接里的 URL 是不可信内容）。不安全则退回 '#'。
function safeUrl(u){{
  var t=(u||'').trim();
  if(/^(https?:|mailto:)/i.test(t))return t;
  if(/^(#|\\/)/.test(t))return t;               // 页内锚点 / 站内相对路径
  if(/^[a-z][a-z0-9+.-]*:/i.test(t))return '#'; // 其它带 scheme 的一律拒绝
  return t;                                       // 无 scheme 的普通文本路径
}}
function inl(s){{
  return esc(s)
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/(?<!\\*)\\*(?!\\*)(.+?)(?<!\\*)\\*(?!\\*)/g,'<em>$1</em>')
    .replace(/~~(.+?)~~/g,'<del>$1</del>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,function(m,txt,url){{
      return '<a href="'+esc(safeUrl(url))+'" target="_blank" rel="noopener noreferrer" style="color:var(--c-orange)">'+txt+'</a>';}});
}}
const lines=md.split('\\n');let h='',i=0,stk=[];
function cls(){{while(stk.length)h+='</'+stk.pop()+'>'}}
while(i<lines.length){{
  const L=lines[i],T=L.trim();
  // code block
  if(T.startsWith('```')){{cls();i++;let c='';
    while(i<lines.length&&!lines[i].trim().startsWith('```')){{c+=esc(lines[i])+'\\n';i++}}
    h+='<pre><code>'+c+'</code></pre>';i++;continue}}
  // table
  if(T.startsWith('|')&&T.endsWith('|')){{cls();let rows=[];
    while(i<lines.length&&lines[i].trim().startsWith('|')){{rows.push(lines[i].trim());i++}}
    if(rows.length>=2){{h+='<table><thead><tr>';
      rows[0].split('|').filter(c=>c.trim()).forEach(c=>h+='<th>'+inl(c.trim())+'</th>');
      h+='</tr></thead><tbody>';
      for(let r=2;r<rows.length;r++){{h+='<tr>';
        rows[r].split('|').filter(c=>c.trim()).forEach(c=>h+='<td>'+inl(c.trim())+'</td>');
        h+='</tr>'}}
      h+='</tbody></table>'}}continue}}
  // headings
  if(T.startsWith('#### ')){{cls();h+='<h4>'+inl(T.slice(5))+'</h4>';i++;continue}}
  if(T.startsWith('### ')){{cls();const id='s'+i;h+='<h3 id="'+id+'">'+inl(T.slice(4))+'</h3>';i++;continue}}
  if(T.startsWith('## ')){{cls();const id='s'+i;h+='<h2 id="'+id+'">'+inl(T.slice(3))+'</h2>';i++;continue}}
  if(T.startsWith('# ')){{cls();h+='<h2>'+inl(T.slice(2))+'</h2>';i++;continue}}
  // hr
  if(/^[-*_]{{3,}}$/.test(T)){{cls();h+='<hr>';i++;continue}}
  // blockquote
  if(T.startsWith('> ')){{cls();h+='<blockquote>'+inl(T.slice(2))+'</blockquote>';i++;continue}}
  // unordered list
  if(/^[-*] /.test(T)){{
    if(!stk.length||stk[stk.length-1]!=='ul'){{cls();h+='<ul>';stk.push('ul')}}
    h+='<li>'+inl(T.replace(/^[-*] /,''))+'</li>';i++;continue}}
  // ordered list
  if(/^\\d+\\.\\s/.test(T)){{
    if(!stk.length||stk[stk.length-1]!=='ol'){{cls();h+='<ol>';stk.push('ol')}}
    h+='<li>'+inl(T.replace(/^\\d+\\.\\s/,''))+'</li>';i++;continue}}
  // empty
  if(!T){{cls();i++;continue}}
  // paragraph
  cls();h+='<p>'+inl(T)+'</p>';i++}}
cls();
// h 完全由本渲染器构造：所有文本都过 esc()（转义 &<>"'，含引号防属性注入），链接 href 过
// safeUrl() 白名单。无原始不可信 HTML 注入路径。故此处 innerHTML 赋值安全。
// TOC 同理：el.textContent 会解码实体，故拼进 toc.innerHTML 前必须再过一次 esc()（见下）。
document.getElementById('rc').innerHTML=h;
// TOC
const hs=document.querySelectorAll('#rc h2,#rc h3');
if(hs.length>1){{let t='<span class="tt">Contents</span>';
  hs.forEach(el=>{{if(!el.id)el.id='s'+Math.random().toString(36).slice(2,8);
    t+='<a href="#'+el.id+'">'+esc(el.textContent)+'</a>'}});
  const toc=document.getElementById('toc');toc.innerHTML=t;toc.classList.add('show')}}
}})();
</script>
</body>
</html>"""
