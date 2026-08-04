/**
 * Security 仪表盘数据源（只读）。三块各自独立降级，互不阻断：
 *   - trustedAdvisor : Trusted Advisor 安全类检查（support API，需 Business/Enterprise）
 *   - securityHub    : Security Hub 活跃发现按严重度分布 + Top 高危（需已开通 Security Hub）
 *   - bulletins      : 最近 30 天 AWS Security Bulletins（公开 RSS，只展示 + 官方链接）
 *
 * 全部只读（Describe / Get 类 API）。跨账号沿用 accountId（TA/Hub 走 AssumeRole 需目标账号角色；
 * 本期先支持部署账号自身视角，跨账号 TA/Hub 作为后续增强）。
 */
import {
  SupportClient, DescribeTrustedAdvisorChecksCommand, DescribeTrustedAdvisorCheckResultCommand,
} from "@aws-sdk/client-support";
import { SecurityHubClient, GetFindingsCommand } from "@aws-sdk/client-securityhub";
import https from "node:https";
import { credsFor } from "./xacct.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
// Support / Trusted Advisor API 只在 us-east-1
const _support = new SupportClient({ region: "us-east-1" });
const _securityhub = new SecurityHubClient({ region: REGION });
// 跨账号：creds 非空时按目标账号凭证建客户端（xacct.credsFor），空则用默认（部署账号）
const supportFor = (creds) => (creds ? new SupportClient({ region: "us-east-1", credentials: creds }) : _support);
const hubFor = (creds) => (creds ? new SecurityHubClient({ region: REGION, credentials: creds }) : _securityhub);

/* ── Trusted Advisor 安全检查 ── */
async function taSecurity(creds) {
  const client = supportFor(creds);
  try {
    const checks = await client.send(new DescribeTrustedAdvisorChecksCommand({ language: "en" }));
    const secChecks = (checks.checks || []).filter((c) => (c.category || "").toLowerCase() === "security");
    if (secChecks.length === 0) return { available: true, checks: [], summary: { ok: 0, warning: 0, error: 0 } };
    const summary = { ok: 0, warning: 0, error: 0 };
    // 并行取各检查结果（此前逐个 await 串行 ~10-15 次是 Security tab 首屏慢的根因）；
    // allSettled = 单个失败不影响其它。
    const settled = await Promise.allSettled(
      secChecks.map((c) => client.send(new DescribeTrustedAdvisorCheckResultCommand({ checkId: c.id, language: "en" }))),
    );
    const results = [];
    settled.forEach((s, i) => {
      if (s.status !== "fulfilled") return; // 单检查失败跳过
      const c = secChecks[i];
      const r = s.value;
      const status = r.result?.status || "not_available"; // ok | warning | error | not_available
      if (status === "ok" || status === "warning" || status === "error") summary[status]++;
      results.push({
        id: c.id, // 前端下钻（flagged resources）与调查按钮需要
        name: c.name || c.id,
        status,
        flaggedCount: (r.result?.flaggedResources || []).filter((f) => f.status !== "ok").length,
      });
    });
    results.sort((a, b) => ({ error: 0, warning: 1, ok: 2, not_available: 3 })[a.status] - ({ error: 0, warning: 1, ok: 2, not_available: 3 })[b.status]);
    return { available: true, checks: results, summary };
  } catch (e) {
    const name = e?.name || "error";
    // SubscriptionRequiredException → 未开通 Business/Enterprise Support
    return { available: false, reason: name === "SubscriptionRequiredException" ? "support_plan_required" : name };
  }
}

/* ── Security Hub 发现 ── */
async function securityHub(creds) {
  try {
    const out = await hubFor(creds).send(new GetFindingsCommand({
      Filters: {
        RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
        WorkflowStatus: [{ Value: "NEW", Comparison: "EQUALS" }, { Value: "NOTIFIED", Comparison: "EQUALS" }],
      },
      MaxResults: 100,
    }));
    const findings = out.Findings || [];
    const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 };
    for (const f of findings) {
      const s = (f.Severity?.Label || "INFORMATIONAL").toUpperCase();
      if (sev[s] != null) sev[s]++;
    }
    const top = findings
      .filter((f) => ["CRITICAL", "HIGH"].includes((f.Severity?.Label || "").toUpperCase()))
      .slice(0, 8)
      .map((f) => ({
        title: f.Title || "",
        severity: f.Severity?.Label || "",
        resource: (f.Resources || [])[0]?.Id || "",
        product: f.ProductName || "",
      }));
    return { available: true, severity: sev, total: findings.length, top };
  } catch (e) {
    const name = e?.name || "error";
    // InvalidAccessException → Security Hub 未开通
    return { available: false, reason: name === "InvalidAccessException" ? "not_enabled" : name };
  }
}

/* ── AWS Security Bulletins（最近 30 天，公开 RSS） ── */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "user-agent": "NotiOps/1.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
        // 跟随一次重定向
        return fetchText(res.headers.location).then(resolve, reject);
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}
async function bulletins() {
  try {
    const xml = await fetchText("https://aws.amazon.com/security/security-bulletins/rss/feed/");
    const items = [];
    const cutoff = Date.now() - 30 * 86400000;
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    const pick = (block, tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      let v = r ? r[1] : "";
      v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
      return v;
    };
    while ((m = re.exec(xml)) !== null && items.length < 30) {
      const block = m[1];
      const title = pick(block, "title");
      const link = pick(block, "link");
      const pubDate = pick(block, "pubDate");
      const ts = pubDate ? Date.parse(pubDate) : NaN;
      if (!isNaN(ts) && ts < cutoff) continue; // 超 30 天跳过
      items.push({ title, link, date: pubDate });
    }
    return { available: true, items };
  } catch (e) {
    return { available: false, reason: String(e?.message || e), items: [] };
  }
}

/** 汇总三块（并行，各自降级）。容器级 5 分钟 TTL 缓存：TA/RSS 数据分钟级新鲜度足够，
 *  重复打开 tab 秒回；按 accountId 分键（当前仅部署账号视角，键恒 "self"，为跨账号增强预留）。 */
const _dashCache = new Map(); // key -> {at, data}
const DASH_TTL_MS = 5 * 60 * 1000;

export async function getSecurityDashboard(accountId) {
  const key = String(accountId || "self");
  const hit = _dashCache.get(key);
  if (hit && Date.now() - hit.at < DASH_TTL_MS) return hit.data;

  let creds = null;
  try {
    creds = await credsFor(accountId); // null = 部署账号自身
  } catch (e) {
    // 成员账号角色不可用（未接入/assume 失败）→ TA/Hub 降级，公告仍可展示
    const reason = "cross_account_unavailable";
    return {
      ok: true, accountId: String(accountId || ""),
      trustedAdvisor: { available: false, reason },
      securityHub: { available: false, reason },
      bulletins: await bulletins(),
    };
  }

  const [trustedAdvisor, securityHubData, bulletinsData] = await Promise.all([
    taSecurity(creds), securityHub(creds), bulletins(),
  ]);
  const data = { ok: true, accountId: String(accountId || ""), trustedAdvisor, securityHub: securityHubData, bulletins: bulletinsData };
  _dashCache.set(key, { at: Date.now(), data });
  return data;
}

/** TA 检查下钻：被标记资源 Top N（调查按钮的前置数据）。 */
export async function taCheckResources(checkId, accountId, limit = 20) {
  const creds = await credsFor(accountId); // 不可用则抛 cross_account_unavailable（路由层转 400）
  const client = supportFor(creds);
  // 检查定义（拿 metadata 列名 + 名称）
  const defs = await client.send(new DescribeTrustedAdvisorChecksCommand({ language: "en" }));
  const def = (defs.checks || []).find((c) => c.id === checkId);
  if (!def) { const e = new Error("check_not_found"); e.code = "bad_request"; throw e; }
  const r = await client.send(new DescribeTrustedAdvisorCheckResultCommand({ checkId, language: "en" }));
  const flagged = (r.result?.flaggedResources || []).filter((f) => f.status !== "ok").slice(0, limit);
  return {
    checkId,
    name: def.name || checkId,
    metadataHeaders: def.metadata || [],
    resources: flagged.map((f) => ({ status: f.status, region: f.region || "", metadata: f.metadata || [] })),
    total: (r.result?.flaggedResources || []).filter((f) => f.status !== "ok").length,
  };
}
