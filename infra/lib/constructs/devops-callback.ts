/**
 * DevOps Agent 调查结果**回调**的定义 —— 两条部署路径共用的唯一真源。
 *
 * 「深度调查」是异步的：`core/devops_agent.py` 发起 backlog task 后立刻返回，真正的
 * 结论由 DevOps Agent 在几分钟后以 EventBridge 事件（`aws.aidevops`）投回来，由
 * `devops_agent_callback/handler.py` 拉摘要 → 落 S3 → presign → 推回原来那个飞书/
 * Slack 会话。**没有这个消费者，整条链路会静默地断在最后一步**：IM 面板上进度条一路
 * 走到 100%（那是 progress Lambda 轮询 journal 画的），然后什么都不来 —— 不报错、
 * 没有日志、CloudWatch 上一片绿。
 *
 * **生产端曾经只有方式 B 有**（`notiops-backend-stack.ts` 建 Lambda + DLQ + 两条规则），
 * 一键部署（方式 A）的单栈里一条都没有。2026-09-03 在验证账号上实测到
 * 这个症状：飞书里发起深度调查，面板显示「调查已结束」，而最终报告与公网访问 URL
 * 永远不来。同一类缺陷、同一种静默 —— 与 `web-notif-sources.ts` 文件头记的那次
 * 「方式 A 的通知页面永远是空的」是同一个模式。
 *
 * 所以这些常量必须住在两边都 import 得到的地方。**别把它抄回任何一个栈里** ——
 * 抄一份的代价是：以后加一个 detail-type 只在一条路径上生效，症状同样是静默的
 * （这份文件本身就是从「同一张 7 条清单在方式 B 里被逐字写了两遍」收拢来的）。
 *
 * 两条路径**允许的差异**只有物理命名与总线，功能必须一致：
 *   · 方式 B：函数名 `notiops-devops-callback`；**两条**规则（default bus + Custom Bus，
 *     后者是跨账号转发的落点）。
 *   · 方式 A：函数名带 `${StackName}-` 前缀（同一账号里可能同时存在 setup.sh 部署的
 *     那个，撞名会 already-exists 整栈回滚）；**只要 default bus 那条** —— 方式 A 不建
 *     Custom Bus，本账号的 DevOps Agent 事件本来就发到 default bus。
 */

/** EventBridge 事件的 `source` 字段。写错了规则永不触发，且没有任何报错。 */
export const DEVOPS_EVENT_SOURCE = "aws.aidevops";

/**
 * 要消费的 detail-type 清单。
 *
 * ⚠️ 判据取自官方文档的 10 个 detail-type，**不是** EventBridge schema registry。
 * 实测 registry 里**没有** `InvestigationSkipped`（2026-07 查 ap-northeast-1 与
 * us-east-1 都只有 9 个 Investigation schema）—— registry 滞后于文档。所以
 * 「schema registry 里存在该 schema」对新事件类型不可靠。
 *
 * `Investigation Skipped` 的官方语义是「matched skip criteria defined in a skill」，
 * 而巡检自己上传两份判读 skill → 这条路径**真实可达**。少了它，SKIPPED 只能等对账
 * Lambda 每小时一次去 GetBacklogTask 才发现 —— 在那之前 finding 上一直显示
 * 「判读缺失（原因未知）」。
 */
export const DEVOPS_INVESTIGATION_DETAIL_TYPES: readonly string[] = [
  "Investigation Created",
  "Investigation Completed",
  "Investigation Failed",
  "Investigation Timed Out",
  "Investigation Cancelled",
  "Investigation Linked",
  "Investigation Skipped",
];

/** handler 路径。方式 A 的 `im-code.zip` 与方式 B 的 asset 里，这个包的相对位置一样。 */
export const DEVOPS_CALLBACK_HANDLER = "devops_agent_callback.handler.handler";

/** 方式 B 的函数物理名。方式 A 另加 `${StackName}-` 前缀，见文件头。 */
export const DEVOPS_CALLBACK_FUNCTION_NAME = "notiops-devops-callback";

/** 方式 B 的 DLQ 物理名。方式 A 不指定名字（同上，避免与 setup.sh 部署撞名）。 */
export const DEVOPS_CALLBACK_DLQ_NAME = "notiops-devops-callback-dlq";

/** 一次调用 = 拉摘要 + 一次 Bedrock 精简 + 写 S3/DDB + 发一张卡。 */
export const DEVOPS_CALLBACK_TIMEOUT_SECONDS = 120;
export const DEVOPS_CALLBACK_MEMORY_MB = 256;

/**
 * DLQ 保留期。⚠️ 过了就没了，要在那之前重投 —— 每一条都是一次判读结果永久丢失。
 */
export const DEVOPS_CALLBACK_DLQ_RETENTION_DAYS = 14;

/** EventBridge target 的重试次数（只兜「**投不进去**」；函数抛异常靠函数级 DLQ）。 */
export const DEVOPS_CALLBACK_RETRY_ATTEMPTS = 2;

/**
 * 报告在 S3 上的前缀 —— `shared/report_delivery/report_handler.py` 往
 * `investigations/<task_id>/report.md|report.html|trace.html` 写，再 presign 出公网 URL。
 *
 * ⚠️ 与长回答报告的 `reports/` 前缀**不是**一回事：报告 CDN（OAC）只放行 `reports/*`，
 * 所以调查报告注定走 presigned GET。也就是说签名方**必须自己有 GetObject** ——
 * 缺了链接照样生成，客户点开才 `AccessDenied`（静默降级）。
 */
export const DEVOPS_REPORT_S3_PREFIX = "investigations/";

/**
 * 客户在 Lambda 控制台上看到的说明。**必须纯 ASCII**：一键部署的模板经
 * CloudFormation 时非 ASCII 字符会被服务端换成 `?`
 * （见 `scripts/postprocess_template.py::assert_customer_text_is_ascii`，
 * 资源上的 `Description` 也在它的检查范围内）。
 * 两条路径共用同一句，免得同一个功能在两个环境里自我介绍得不一样。
 */
export const DEVOPS_CALLBACK_FUNCTION_DESCRIPTION =
  "NotiOps: DevOps Agent investigation results (EventBridge) -> the chat thread " +
  "that asked for them. Fetches the summary, stores the full report in S3, then " +
  "posts a card with a pre-signed link back to Feishu / Slack.";

/** 规则物理名。`bus` 决定后缀，与方式 B 历来的两条规则名逐字一致。 */
export function devopsCallbackRuleName(bus: "default" | "custom"): string {
  return `devops-agent-callback-${bus}`;
}

/**
 * 规则的 Description（控制台上那一行）。**必须纯 ASCII**，理由同上。
 */
export function devopsCallbackRuleDescription(bus: "default" | "custom"): string {
  const base =
    "NotiOps: DevOps Agent investigation events (created / completed / failed / " +
    "timed out / cancelled / linked / skipped) -> the callback function.";
  return bus === "custom"
    ? `${base} Custom event bus -- this is where investigation events forwarded ` +
      "from other accounts land."
    : `${base} Default event bus -- this is where this account's own DevOps Agent ` +
      "publishes.";
}
