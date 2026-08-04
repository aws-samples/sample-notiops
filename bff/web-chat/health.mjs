/**
 * AWS Health Dashboard 实时视图（通知主题的重点区块）。
 *
 * 为什么实时查而不落库:Health Dashboard 本质是"当前状态视图"(尚未处理的问题 /
 * 即将到来的变更),而 AWS Health API 本身就是可查询的历史库 —— 实时查最准、天然
 * 镜像控制台。其它事件源(CloudWatch/Backup/GuardDuty)才用"落库收件箱"模式。
 *
 * 镜像控制台布局(见用户截图):
 *   - 服务运行状况:公共服务事件(eventScopeCode=PUBLIC)的 issue。状态历史→控制台。
 *   - 您的账户运行状况:
 *       · 尚未处理和最近的问题 = 账户级(ACCOUNT_SPECIFIC)的 issue
 *       · 计划的更改 = scheduledChange
 *       · 其他通知 / 事件日志 → 控制台链接
 *
 * 显示逻辑(与控制台一致):issue(未解决)和 scheduledChange(未来待办)都是**当前
 * 有效清单**,显示所有 open/upcoming、按更新时间倒序 —— 不按更新时间做时间窗过滤
 * (否则"很久前发布、未来才生效"的计划更改会被误滤)。仅用每块条数上限 PER_BUCKET_MAX
 * 兜底防爆量;超出给 `moreCount` + 控制台链接,前端提示"还有 N 条,去控制台查看"。
 *
 * Health API 需 Business+ / Enterprise Support 计划,且 endpoint 仅 us-east-1。
 * 无计划 → SubscriptionRequiredException,这里捕获成 {available:false} 让前端优雅降级。
 */
import { HealthClient, DescribeEventsCommand, DescribeEventDetailsCommand, DescribeAffectedEntitiesCommand, DescribeEventsForOrganizationCommand, DescribeAffectedAccountsForOrganizationCommand } from "@aws-sdk/client-health";

// Health 全局 API 端点固定 us-east-1(即便部署主区不同)。
const health = new HealthClient({ region: "us-east-1" });
import { credsFor } from "./xacct.mjs";
// 跨账号（eos.mjs 同款模式）：请求级客户端变量，Lambda 同容器同一时刻单请求，安全。
// getHealthDashboard 入口按 accountId 设置，入口处 **总是** 先重置回默认，
// 保证 count/detail 等其它入口(部署账号视角)不受上一请求影响。
let hc = health;
const healthFor = (creds) => (creds ? new HealthClient({ region: "us-east-1", credentials: creds }) : health);

const PER_BUCKET_MAX = Number(process.env.HEALTH_PER_BUCKET_MAX || "50"); // 每块最多返回条数(兜底防爆量)

// 控制台链接(正确域名/路径,与 AWS Health 控制台一致):
//  - 服务运行状况(公共事件)在独立的 status 页:health.aws.amazon.com/health/status
//  - 账户运行状况各分块在 /health/home#/account/dashboard/*
const STATUS_BASE = "https://health.aws.amazon.com/health/status";
const HOME_BASE = "https://health.aws.amazon.com/health/home";
const consoleLinks = {
  home: `${HOME_BASE}#/account/dashboard/open-issues`,
  // 服务运行状况:公共事件状态页(用户指定)
  serviceOpenIssues: `${STATUS_BASE}?path=open-issues`,
  serviceHistory: `${STATUS_BASE}?path=service-history`,
  // 账户运行状况分块
  openIssues: `${HOME_BASE}#/account/dashboard/open-issues`,
  scheduledChanges: `${HOME_BASE}#/account/dashboard/scheduled-changes`,
  otherNotifications: `${HOME_BASE}#/account/dashboard/other-notifications`,
  eventLog: `${HOME_BASE}#/account/dashboard/event-log`,
};

const ms = (d) => (d ? new Date(d).getTime() : 0);

/** 把一个 Health event 精简成前端卡片所需字段。 */
function slim(ev) {
  return {
    arn: ev.arn || "",
    service: ev.service || "",
    eventTypeCode: ev.eventTypeCode || "",
    category: ev.eventTypeCategory || "",
    region: ev.region || "",
    statusCode: ev.statusCode || "",
    scope: ev.eventScopeCode || "",
    affectedAccounts: ev.affectedAccounts ?? null, // org 视图下：受影响账号数
    account: ev.awsAccountId || "", // org 事件带来源账号（单账号视图为空）
    startTime: ms(ev.startTime),
    endTime: ms(ev.endTime),
    lastUpdatedTime: ms(ev.lastUpdatedTime),
  };
}

/** 取一批事件的详情描述(latestDescription)。describe-event-details 一次最多 10 个 ARN。 */
async function fetchDescriptions(arns) {
  const out = {};
  for (let i = 0; i < arns.length; i += 10) {
    const batch = arns.slice(i, i + 10);
    try {
      const r = await hc.send(new DescribeEventDetailsCommand({ eventArns: batch }));
      for (const d of r.successfulSet || []) {
        const arn = d.event?.arn || "";
        if (arn) out[arn] = d.eventDescription?.latestDescription || "";
      }
    } catch { /* 单批失败不影响其它 */ }
  }
  return out;
}

/**
 * 拉取 Health Dashboard 数据,组织成三块。返回:
 *   { available, serviceIssues, accountIssues, scheduledChanges, otherCount, links }
 * 每块是 { items:[...], moreCount:n }（moreCount>0 → 前端提示"还有 n 条去控制台"）。
 */
export async function getHealthDashboard(accountId) {
  hc = health; // 请求级重置（见上）
  try {
    const creds = await credsFor(accountId); // null = 部署账号
    if (creds) hc = healthFor(creds);
  } catch {
    return { ok: true, accountId: String(accountId || ""), available: false, reason: "cross_account_unavailable" };
  }
  let events = [];
  // org 模式且未选具体账号 → 组织视图（Health organizational view，一次调用全组织事件；
  // 管理账号需已 enable-health-service-access。失败自动回退单账号视角）。
  const orgWide = !String(accountId || "").trim() && !!(process.env.ORGANIZATION_ID || "").trim();
  let orgUsed = false;
  if (orgWide) {
    try {
      let nextToken;
      do {
        const r = await hc.send(new DescribeEventsForOrganizationCommand({
          filter: { eventStatusCodes: ["open", "upcoming"] },
          maxResults: 100, nextToken,
        }));
        events.push(...(r.events || []));
        nextToken = r.nextToken;
      } while (nextToken && events.length < 300);
      orgUsed = true;
      // 每个非公共事件补受影响账号数（前端可标"影响 N 个账号"）
      await Promise.allSettled(events.filter((e) => e.eventScopeCode !== "PUBLIC").slice(0, 30).map(async (e) => {
        try {
          const a = await hc.send(new DescribeAffectedAccountsForOrganizationCommand({ eventArn: e.arn, maxResults: 50 }));
          e.affectedAccounts = (a.affectedAccounts || []).length;
        } catch { /* 单事件失败忽略 */ }
      }));
    } catch { events = []; orgUsed = false; /* 回退单账号 */ }
  }
  if (!orgUsed) try {
    // 拉全部 open/upcoming 事件(不按更新时间过滤 —— issue 是"未解决"、
    // scheduledChange 是"未来待办",都是当前有效清单,应全显示,与控制台一致)。
    // 分页,上限保护防意外爆量。
    let nextToken;
    do {
      const r = await hc.send(new DescribeEventsCommand({
        filter: { eventStatusCodes: ["open", "upcoming"] },
        maxResults: 100,
        nextToken,
      }));
      events.push(...(r.events || []));
      nextToken = r.nextToken;
    } while (nextToken && events.length < 300);
  } catch (e) {
    const msg = String(e?.name || e?.message || e);
    if (/Subscription/i.test(msg)) {
      // 无 Business+ Support 计划 → 优雅降级,前端显示"需 Business+ 计划 + 控制台链接"。
      return { available: false, reason: "subscription_required", links: consoleLinks };
    }
    return { available: false, reason: "error", message: msg, links: consoleLinks };
  }

  // 按控制台的分块归类。
  const byUpdated = (a, b) => b.lastUpdatedTime - a.lastUpdatedTime;
  const slimmed = events.map(slim);
  const serviceIssuesAll = slimmed.filter((e) => e.category === "issue" && e.scope === "PUBLIC").sort(byUpdated);
  const accountIssuesAll = slimmed.filter((e) => e.category === "issue" && e.scope !== "PUBLIC").sort(byUpdated);
  const scheduledAll = slimmed.filter((e) => e.category === "scheduledChange").sort(byUpdated);
  const otherAll = slimmed.filter((e) => e.category === "accountNotification" || e.category === "investigation");

  // 只对要展示的三块(service/account issues + scheduled)取描述,控制成本。
  const shown = [
    ...serviceIssuesAll.slice(0, PER_BUCKET_MAX),
    ...accountIssuesAll.slice(0, PER_BUCKET_MAX),
    ...scheduledAll.slice(0, PER_BUCKET_MAX),
  ];
  const descs = await fetchDescriptions(shown.map((e) => e.arn).filter(Boolean));
  const withDesc = (e) => ({ ...e, description: (descs[e.arn] || "").slice(0, 800) });

  const bucket = (all) => ({
    items: all.slice(0, PER_BUCKET_MAX).map(withDesc),
    moreCount: Math.max(0, all.length - PER_BUCKET_MAX),
  });

  return {
    available: true,
    scope: orgUsed ? "organization" : (String(accountId || "").trim() || "deployment-account"),
    serviceIssues: bucket(serviceIssuesAll),
    accountIssues: bucket(accountIssuesAll),
    scheduledChanges: bucket(scheduledAll),
    otherCount: otherAll.length,   // 其他通知只给计数 + 控制台链接
    links: consoleLinks,
  };
}

/** 轻量:仅未处理 issue 计数(open issue,服务+账户),供红点/轮询用,不取描述。
 * 与展示一致:不按更新时间过滤(open issue 就是当前未解决的)。 */
export async function getHealthOpenIssueCount() {
  hc = health; // 未读计数恒为部署账号视角（通知聚合是 push 模式，成员事件经转发进入）
  try {
    const r = await hc.send(new DescribeEventsCommand({
      filter: { eventStatusCodes: ["open"], eventTypeCategories: ["issue"] },
      maxResults: 100,
    }));
    return { available: true, openIssues: (r.events || []).length };
  } catch (e) {
    const msg = String(e?.name || e?.message || e);
    if (/Subscription/i.test(msg)) return { available: false, openIssues: 0 };
    return { available: false, openIssues: 0, error: msg };
  }
}

/**
 * 单个 Health 事件的**完整详情**(渐进式加载:列表只给摘要,点"显示完整通知"时才拉这个)。
 * 一次拉齐:元数据(起/止时间、状态)+ 完整描述 + 受影响资源列表(describe-affected-entities)。
 * 返回 { available, arn, service, eventTypeCode, category, region, statusCode,
 *        startTime, endTime, lastUpdatedTime, description, affectedEntities:[{value,status,region,lastUpdatedTime}] }。
 */
export async function getHealthEventDetail(arn) {
  hc = health; // 事件详情恒为部署账号视角（详情按 ARN 查，转发事件的 ARN 属于源账号 —— 成员账号事件详情走推送时已带的摘要）
  if (!arn) return { available: false, reason: "missing_arn" };
  try {
    const [detailResp, entResp] = await Promise.all([
      hc.send(new DescribeEventDetailsCommand({ eventArns: [arn] })),
      // 受影响资源可能很多 —— 只取前 100 个,超出前端提示去控制台。
      hc.send(new DescribeAffectedEntitiesCommand({ filter: { eventArns: [arn] }, maxResults: 100 }))
        .catch(() => ({ entities: [] })),
    ]);
    const d = (detailResp.successfulSet || [])[0];
    if (!d) return { available: false, reason: "not_found" };
    const ev = d.event || {};
    const entities = (entResp.entities || []).map((e) => ({
      value: e.entityValue || "",         // 资源标识(ARN / ID / 名称)
      status: e.statusCode || "",         // IMPAIRED / UNIMPAIRED / UNKNOWN 等
      lastUpdatedTime: ms(e.lastUpdatedTime),
    }));
    return {
      available: true,
      arn: ev.arn || arn,
      service: ev.service || "",
      eventTypeCode: ev.eventTypeCode || "",
      category: ev.eventTypeCategory || "",
      region: ev.region || "",
      statusCode: ev.statusCode || "",
      startTime: ms(ev.startTime),
      endTime: ms(ev.endTime),
      lastUpdatedTime: ms(ev.lastUpdatedTime),
      description: d.eventDescription?.latestDescription || "",
      affectedEntities: entities,
    };
  } catch (e) {
    const msg = String(e?.name || e?.message || e);
    if (/Subscription/i.test(msg)) return { available: false, reason: "subscription_required" };
    return { available: false, reason: "error", message: msg };
  }
}
