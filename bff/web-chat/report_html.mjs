/**
 * HTML 报告模板（BFF 侧 Node 版）。
 *
 * 来源：`core/report_html.py`（agent runtime 侧）**逐行移植**，样式/结构/安全策略完全一致 ——
 * 目的是「深度调查（直连）」生成的报告与老路径（agent 侧）长得一模一样，客户看不出区别。
 * ⚠️ C1 约束：这里是**新增**文件，不改 Python 那份；两边各自独立，改一边不影响另一边。
 *
 * 特性（与 Python 版同）：
 *   - 完全自包含：内联 CSS + 客户端 JS 渲染 markdown（表格/列表/代码/标题/TOC），无外部 CDN。
 *   - 配合 S3 上传时的 ContentType=text/html + ContentDisposition=inline → 点开即看网页。
 *   - XSS 防线两道：①头部元信息服务端 HTML-escape ②正文全部经客户端 esc()，链接 href 过
 *     safeUrl() scheme 白名单。
 */

/** 服务端 HTML 转义（等价 Python html.escape(..., quote=True)）。 */
function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * 通用报告 HTML 渲染（对齐 Python `render_report`）。
 * @param {string} summaryMd  报告正文（markdown）
 * @param {object} opts       { title, subtitle, meta:{task_id,execution_id,agent_space_id,created_at,updated_at}, status, priority }
 */
export function renderReport(summaryMd, { title = "NotiOps Report", subtitle = "", meta = {}, status = "", priority = "" } = {}) {
  return generateHtmlReport({
    summaryMd,
    status,
    priority,
    detailType: subtitle || title,
    taskId: meta.task_id || "",
    executionId: meta.execution_id || "",
    agentSpaceId: meta.agent_space_id || "",
    createdAt: meta.created_at || "",
    updatedAt: meta.updated_at || "",
  });
}

const STATUS_COLOR = { COMPLETED: "#10b981", FAILED: "#ef4444", TIMED_OUT: "#f59e0b", CANCELLED: "#6b7280" };
const STATUS_EMOJI = { COMPLETED: "✅", FAILED: "❌", TIMED_OUT: "⏰", CANCELLED: "🚫" };
const STATUS_BG = { COMPLETED: "#ecfdf5", FAILED: "#fef2f2", TIMED_OUT: "#fffbeb", CANCELLED: "#f9fafb" };
const PRIORITY_COLOR = { CRITICAL: "#ef4444", HIGH: "#f59e0b", MEDIUM: "#3b82f6", LOW: "#10b981", MINIMAL: "#6b7280" };

function generateHtmlReport({ summaryMd, status, priority, detailType, taskId, executionId, agentSpaceId, createdAt, updatedAt }) {
  const statusColor = STATUS_COLOR[status] || "#3b82f6";
  const statusEmoji = STATUS_EMOJI[status] || "ℹ️";
  const statusBg = STATUS_BG[status] || "#eff6ff";
  const priorityColor = PRIORITY_COLOR[priority] || "#3b82f6";
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // 头部元数据直接插进 HTML（不经客户端 esc()），须在此 HTML-escape 防属性/标签注入。
  const _status = escAttr(status);
  const _priority = escAttr(priority);
  const _detailType = escAttr(detailType);
  const _taskId = escAttr(taskId);
  const _executionId = escAttr(executionId);
  const _agentSpaceId = escAttr(agentSpaceId);
  const _createdAt = escAttr(createdAt);
  const _updatedAt = escAttr(updatedAt);

  // 正文嵌进客户端 JS 模板字面量前，转义反斜杠/反引号/${/</script>（与 Python 版同）。
  const mdEscaped = String(summaryMd || "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")
    .replace(/<\/script>/gi, "<\\/script>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${statusEmoji} NotiOps Report</title>
<style>
:root {
  --c-dark:#232f3e; --c-blue:#37475a; --c-orange:#ff9900; --c-orange-l:#ffb84d;
  --t1:#1a1a2e; --t2:#4a5568; --t3:#718096;
  --bg1:#fff; --bg2:#f7f8fa; --bg3:#edf2f7;
  --bdr:#e2e8f0; --bdr-l:#f0f0f0;
  --r-sm:6px; --r-lg:16px;
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
  line-height:1.7;color:var(--t1);background:var(--bg2);-webkit-font-smoothing:antialiased}
.page{max-width:1100px;margin:0 auto;padding:24px}

.header{background:linear-gradient(135deg,var(--c-dark),#1a2332,#0d1b2a);
  color:#fff;padding:40px 48px;border-radius:var(--r-lg) var(--r-lg) 0 0;position:relative;overflow:hidden}
.header::before{content:'';position:absolute;top:-50%;right:-20%;width:500px;height:500px;
  background:radial-gradient(circle,rgba(255,153,0,.15),transparent 70%);border-radius:50%}
.header h1{font-size:26px;font-weight:700;position:relative}
.header .sub{opacity:.7;font-size:14px;margin-top:4px;position:relative}
.header .bar{width:60px;height:4px;background:var(--c-orange);border-radius:2px;margin-top:16px;position:relative}

.status{background:${statusBg};border-left:4px solid ${statusColor};
  padding:14px 48px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.badge{display:inline-flex;padding:4px 14px;border-radius:20px;font-weight:600;font-size:13px;color:#fff}

.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.mc{background:var(--bg1);padding:14px 24px}
.mc .l{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.8px;font-weight:600}
.mc .v{font-size:14px;font-weight:600;margin-top:2px;word-break:break-all}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:11px!important}

#toc{background:var(--bg1);border-bottom:1px solid var(--bdr);
  padding:14px 48px;display:none;flex-wrap:wrap;gap:6px;align-items:center}
#toc.show{display:flex}
#toc .tt{font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;
  letter-spacing:.8px;margin-right:8px}
#toc a{font-size:12px;color:var(--c-blue);text-decoration:none;
  padding:3px 10px;border-radius:4px;background:var(--bg3);transition:all .15s}
#toc a:hover{background:var(--c-orange);color:#fff}

.content{background:var(--bg1);padding:40px 48px;border-radius:0 0 var(--r-lg) var(--r-lg)}
.content h1{display:none}
.content h2{color:var(--c-dark);font-size:20px;font-weight:700;
  margin:32px 0 14px;padding-bottom:8px;border-bottom:3px solid var(--c-orange)}
.content h2:first-child{margin-top:0}
.content h3{color:var(--c-blue);font-size:16px;font-weight:600;
  margin:24px 0 10px;padding-left:12px;border-left:3px solid var(--c-orange-l)}
.content h4{color:var(--t2);font-size:14px;font-weight:600;margin:18px 0 8px}
.content p{margin:8px 0;color:var(--t2);font-size:14px}
.content strong{color:var(--t1)}
.content em{color:var(--t2)}
.content hr{border:none;height:1px;background:linear-gradient(to right,var(--bdr),transparent);margin:28px 0}
.content blockquote{border-left:3px solid var(--c-orange);padding:8px 16px;
  margin:12px 0;background:#fffbeb;border-radius:0 6px 6px 0;color:var(--t2)}

.content pre{background:#1e293b;color:#e2e8f0;padding:18px 22px;
  border-radius:var(--r-sm);overflow-x:auto;font-size:12.5px;line-height:1.6;
  margin:14px 0;border:1px solid #334155;
  font-family:'SF Mono','Fira Code','Consolas',monospace}
.content code{background:#f1f5f9;color:#be185d;padding:1px 6px;border-radius:3px;
  font-size:12.5px;font-family:'SF Mono','Fira Code','Consolas',monospace}
.content pre code{background:none;color:inherit;padding:0;font-size:inherit}

.content table{width:100%;border-collapse:separate;border-spacing:0;
  margin:14px 0;border-radius:var(--r-sm);overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid var(--bdr);font-size:13px}
.content th{background:var(--c-dark);color:#fff;padding:10px 14px;
  text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.content td{padding:8px 14px;border-bottom:1px solid var(--bdr-l)}
.content tr:last-child td{border-bottom:none}
.content tr:nth-child(even) td{background:#fafbfc}
.content tr:hover td{background:#f0f4ff}

.content ul,.content ol{padding-left:22px;margin:8px 0}
.content li{margin:5px 0;color:var(--t2);font-size:14px}
.content li::marker{color:var(--c-orange)}
.content li>ul,.content li>ol{margin:4px 0}

.footer{text-align:center;padding:18px;font-size:11px;color:var(--t3);margin-top:8px}

@media print{body{background:#fff}.page{padding:0}.header,.content{border-radius:0}
  #toc{display:none}.content pre{white-space:pre-wrap}}
@media(max-width:768px){.header,.content,.status{padding-left:20px;padding-right:20px}
  #toc{padding-left:20px;padding-right:20px}.meta{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>${statusEmoji} NotiOps Report</h1>
    <div class="sub">${_detailType} &middot; ${generatedAt}</div>
    <div class="bar"></div>
  </div>
  <div class="status">
    <span class="badge" style="background:${statusColor}">${_status}</span>
    <span class="badge" style="background:${priorityColor}">Priority: ${_priority}</span>
  </div>
  <div class="meta">
    <div class="mc"><div class="l">Task ID</div><div class="v mono">${_taskId}</div></div>
    <div class="mc"><div class="l">Execution ID</div><div class="v mono">${_executionId}</div></div>
    <div class="mc"><div class="l">Started</div><div class="v">${_createdAt}</div></div>
    <div class="mc"><div class="l">Completed</div><div class="v">${_updatedAt}</div></div>
    <div class="mc"><div class="l">Agent Space</div><div class="v mono">${_agentSpaceId}</div></div>
  </div>
  <nav id="toc"></nav>
  <div class="content" id="rc"></div>
  <div class="footer">Generated by NotiOps Deep Dive (Direct)</div>
</div>
<script>
(function(){
const md=\`${mdEscaped}\`;
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
// URL scheme 白名单：只允许 http/https/mailto/相对(#、/)链接，拦截 javascript:/data:/vbscript:
// 等可执行 scheme（防 XSS：markdown 链接里的 URL 是不可信内容）。不安全则退回 '#'。
function safeUrl(u){
  var t=(u||'').trim();
  if(/^(https?:|mailto:)/i.test(t))return t;
  if(/^(#|\\/)/.test(t))return t;               // 页内锚点 / 站内相对路径
  if(/^[a-z][a-z0-9+.-]*:/i.test(t))return '#'; // 其它带 scheme 的一律拒绝
  return t;                                     // 无 scheme 的普通文本路径
}
function inl(s){
  return esc(s)
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/(?<!\\*)\\*(?!\\*)(.+?)(?<!\\*)\\*(?!\\*)/g,'<em>$1</em>')
    .replace(/~~(.+?)~~/g,'<del>$1</del>')
    .replace(/\\\`([^\\\`]+)\\\`/g,'<code>$1</code>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,function(m,txt,url){
      return '<a href="'+esc(safeUrl(url))+'" target="_blank" rel="noopener noreferrer" style="color:var(--c-orange)">'+txt+'</a>';});
}
const lines=md.split('\\n');let h='',i=0,stk=[];
function cls(){while(stk.length)h+='</'+stk.pop()+'>'}
while(i<lines.length){
  const L=lines[i],T=L.trim();
  // code block
  if(T.startsWith('\\\`\\\`\\\`')){cls();i++;let c='';
    while(i<lines.length&&!lines[i].trim().startsWith('\\\`\\\`\\\`')){c+=esc(lines[i])+'\\n';i++}
    h+='<pre><code>'+c+'</code></pre>';i++;continue}
  // table
  if(T.startsWith('|')&&T.endsWith('|')){cls();let rows=[];
    while(i<lines.length&&lines[i].trim().startsWith('|')){rows.push(lines[i].trim());i++}
    if(rows.length>=2){h+='<table><thead><tr>';
      rows[0].split('|').filter(c=>c.trim()).forEach(c=>h+='<th>'+inl(c.trim())+'</th>');
      h+='</tr></thead><tbody>';
      for(let r=2;r<rows.length;r++){h+='<tr>';
        rows[r].split('|').filter(c=>c.trim()).forEach(c=>h+='<td>'+inl(c.trim())+'</td>');
        h+='</tr>'}
      h+='</tbody></table>'}continue}
  // headings
  if(T.startsWith('#### ')){cls();h+='<h4>'+inl(T.slice(5))+'</h4>';i++;continue}
  if(T.startsWith('### ')){cls();const id='s'+i;h+='<h3 id="'+id+'">'+inl(T.slice(4))+'</h3>';i++;continue}
  if(T.startsWith('## ')){cls();const id='s'+i;h+='<h2 id="'+id+'">'+inl(T.slice(3))+'</h2>';i++;continue}
  if(T.startsWith('# ')){cls();h+='<h2>'+inl(T.slice(2))+'</h2>';i++;continue}
  // hr
  if(/^[-*_]{3,}$/.test(T)){cls();h+='<hr>';i++;continue}
  // blockquote
  if(T.startsWith('> ')){cls();h+='<blockquote>'+inl(T.slice(2))+'</blockquote>';i++;continue}
  // unordered list
  if(/^[-*] /.test(T)){
    if(!stk.length||stk[stk.length-1]!=='ul'){cls();h+='<ul>';stk.push('ul')}
    h+='<li>'+inl(T.replace(/^[-*] /,''))+'</li>';i++;continue}
  // ordered list
  if(/^\\d+\\.\\s/.test(T)){
    if(!stk.length||stk[stk.length-1]!=='ol'){cls();h+='<ol>';stk.push('ol')}
    h+='<li>'+inl(T.replace(/^\\d+\\.\\s/,''))+'</li>';i++;continue}
  // empty
  if(!T){cls();i++;continue}
  // paragraph
  cls();h+='<p>'+inl(T)+'</p>';i++}
cls();
// h 完全由本渲染器构造：所有文本都过 esc()（转义 &<>"'，含引号防属性注入），链接 href 过
// safeUrl() 白名单。无原始不可信 HTML 注入路径。故此处 innerHTML 赋值安全。
document.getElementById('rc').innerHTML=h;
// TOC（el.textContent 会解码实体，故拼进 innerHTML 前必须再过一次 esc()）
const hs=document.querySelectorAll('#rc h2,#rc h3');
if(hs.length>1){let t='<span class="tt">Contents</span>';
  hs.forEach(el=>{if(!el.id)el.id='s'+Math.random().toString(36).slice(2,8);
    t+='<a href="#'+el.id+'">'+esc(el.textContent)+'</a>'});
  const toc=document.getElementById('toc');toc.innerHTML=t;toc.classList.add('show')}
})();
</script>
</body>
</html>`;
}
