/**
 * 客户 CUR 数据源的**失败边界**：这是可选外部数据源，挂了不许拖垮别的功能。
 *
 * 判据（用户明确要求「CUR MCP 有问题不要 block 整个工具」）：
 *   1. 未配置        → available:false, reason:"not-configured"（不抛异常、不打 500）。
 *   2. MCP 挂了/超时 → available:false, reason:"unavailable"（同样是正常返回值，
 *      前端只把这 4 个 sheet 显示成"暂时不可用 + 去对话里问（CE 口径兜底）"）。
 *   3. 每次 MCP 调用都带 AbortSignal —— 少了它，一个挂住的 Lambda URL 会让请求
 *      一直等到 BFF Lambda 超时（15 分钟），那才是真正的"整个工具被 block"。
 *
 * 只测 curCube：它在没有 DATA_BUCKET/SKILLS_BUCKET 时**完全不碰 DynamoDB/S3**，
 * 于是这个测试零网络（除被 stub 掉的 fetch），可在 CI 里稳定跑。
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.error(`  FAIL ${name}`); } };

// SigV4 签名需要凭证：给假的 env 凭证，避免 defaultProvider 去摸 IMDS（网络）。
process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-not-a-real-key";
process.env.AWS_REGION = "us-east-1";
// 缓存旁路：没有桶 → cachedS3 直接调 fetcher，不产生任何 AWS SDK 调用。
delete process.env.DATA_BUCKET;
delete process.env.SKILLS_BUCKET;

// ── 1. 未配置 ──
delete process.env.COST_AGENT_MCP_URL;
{
  const m = await import("../cur_dashboard.mjs?case=unset");
  const r = await m.curCube(30);
  ok("未配置 → available:false / not-configured", r.available === false && r.reason === "not-configured");
}

// ── 2. 配了但 MCP 不可达 ──
process.env.COST_AGENT_MCP_URL = "https://example.lambda-url.us-east-1.on.aws/";
{
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { seen.push({ url: String(url), opts }); throw new Error("ECONNREFUSED"); };
  try {
    const m = await import("../cur_dashboard.mjs?case=down");
    const r = await m.curCube(30);
    ok("MCP 不可达 → available:false / unavailable（不抛异常）", r.available === false && r.reason === "unavailable");
    ok("确实发起过一次 MCP 调用", seen.length >= 1);
    ok("每次调用都带超时 AbortSignal", seen.every((c) => !!c.opts?.signal));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 3. 配了但返回 HTTP 403（IAM 没配到：缺 lambda:InvokeFunctionUrl / 资源策略）──
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "" });
  try {
    const m = await import("../cur_dashboard.mjs?case=403");
    const r = await m.curCube(30);
    ok("HTTP 403 → available:false / unavailable（不冒泡成 500）", r.available === false && r.reason === "unavailable");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(pass + " ok, " + fail + " failed");
if (fail) process.exit(1);
