/**
 * 「通知」收件箱的**生产端**定义 —— 两条部署路径共用的唯一真源。
 *
 * 读端（DynamoDB `notif#` 段、BFF 的 `/notifications*`、`nav:notifications`）本来就在
 * `web-chat-core.ts` 里，两条路径自动对等。**生产端曾经只有方式 B 有**：
 * `notiops-backend-stack.ts` 建 Lambda + 10 条 EventBridge 规则，而一键部署（方式 A）
 * 的单栈里一条都没有 —— 于是方式 A 部署出来的环境里「通知」页面永远是空的，
 * 不报错、不写日志，客户只会觉得"这个产品的通知功能是假的"。
 *
 * 所以这张表必须住在两边都 import 得到的地方。**别把它抄回任何一个栈里** ——
 * 抄一份的代价是：以后加一个事件源只在一条路径上生效，而症状同样是静默的。
 *
 * 两条路径**唯一**的差别是「怎么开关某一个源」（见 `WEB_NOTIF_SOURCES` 的注释）：
 *   · 方式 B：合成期 `-c webNotif<Id>=on|off`（模板由客户本地 synth，可以有 context）
 *   · 方式 A：EventBridge 控制台上 Enable / Disable 那条规则（发布出去的静态模板
 *     没有 context，而给 10 个源各开一个 CFN Parameter 会把参数页淹掉）
 * 这个差别是机制固有的，不是功能差异 —— 默认开哪 5 个、规则名叫什么，两边完全一致。
 */

/** 一个 EventBridge 事件源。`id` 同时决定规则名与方式 B 的 context 键。 */
export interface WebNotifSource {
  /** 驼峰式短名。规则名 = `notiops-web-notif-<id 小写>`；方式 B 的开关 = `-c webNotif<id>`。 */
  readonly id: string;
  /** 事件的 `source` 字段。 */
  readonly source: string;
  /** 事件的 `detail-type` 字段。 */
  readonly detailType: string;
  /** 出厂默认是否启用。 */
  readonly on: boolean;
  /** 全局服务：只在 us-east-1 发事件，部署在别的区域时这条规则永不触发。 */
  readonly globalOnly?: boolean;
}

/** Lambda 物理名。两条路径同名 —— 文档、日志排查、控制台搜索都按这个名字讲。 */
export const WEB_NOTIF_FUNCTION_NAME = "notiops-web-notif-handler";

/** handler 路径。方式 A 的 zip 与方式 B 的 asset 里，这两个包的相对位置是一样的。 */
export const WEB_NOTIF_HANDLER = "shared.report_delivery.web_push_handler.lambda_handler";

/**
 * 方式 A 的 Release 产物名（方式 B 直接用 CDK asset，不需要它）。
 * 与 `scripts/build_web_notif_zip.py` / `scripts/postprocess_template.py` 里的常量一致。
 */
export const WEB_NOTIF_ARTIFACT = "web-notif.zip";

/**
 * 客户在 Lambda 控制台上看到的说明。**必须纯 ASCII**：一键部署的模板经
 * CloudFormation 时非 ASCII 字符会被服务端换成 `?`
 * （见 `scripts/postprocess_template.py::assert_customer_text_is_ascii`）。
 * 两条路径共用同一句，免得同一个功能在两个环境里自我介绍得不一样。
 */
export const WEB_NOTIF_FUNCTION_DESCRIPTION =
  "NotiOps: AWS events (EventBridge) -> the Web Chat notification inbox. " +
  "On by default: Health / CloudWatch Alarm / Cost Anomaly / Trusted Advisor / GuardDuty. " +
  "Off by default: Backup / EC2 Spot / Auto Scaling / RDS / Config.";

/**
 * 10 个事件源。`source` / `detailType` 必须**逐字**等于 AWS 实际发出的值 ——
 * 写错了规则永不触发，且没有任何报错。判据：EventBridge schema registry（`aws.events`
 * 注册表）里存在 `<source>@<DetailTypeWithoutSpaces>` 这个 schema。
 *
 * 默认开这 5 个（运维价值最高、噪音可控）：
 *   AWS Health · CloudWatch 告警 · Cost Anomaly · Trusted Advisor · GuardDuty
 * 其余 5 个默认关：Backup / EC2 Spot / Auto Scaling / RDS / Config
 *   —— 要么量大易刷屏（Backup 每次作业、Spot、RDS），要么需客户先开通付费服务
 *   且合规类噪音大（Config）。
 *
 * GuardDuty 默认开但**需客户先启用 GuardDuty**（付费服务）。没启用时没有 detector、
 * 不会有任何 finding，规则处于"开着但收不到事件"的状态 —— 无害且零成本，一旦客户
 * 启用就立刻生效，不用回来改部署。Cost Anomaly（需先建异常监控器）、
 * Trusted Advisor（需 Business+ 支持计划）同理。
 */
export const WEB_NOTIF_SOURCES: readonly WebNotifSource[] = [
  { id: "Health", source: "aws.health", detailType: "AWS Health Event", on: true },
  { id: "CloudWatchAlarm", source: "aws.cloudwatch", detailType: "CloudWatch Alarm State Change", on: true },
  // Cost Anomaly：source 是 aws.ce（不是 aws.costexplorer —— 那个 source 不存在），
  // detail-type 是 "Anomaly Detected"。见 core/push_event.py 的 from_cost_anomaly。
  { id: "CostAnomaly", source: "aws.ce", detailType: "Anomaly Detected", on: true, globalOnly: true },
  // Trusted Advisor：唯一真实存在的 detail-type 是 "...Refresh Notification"
  // （控制台标签写作 "Check Item Refresh Status"）。
  {
    id: "TrustedAdvisor",
    source: "aws.trustedadvisor",
    detailType: "Trusted Advisor Check Item Refresh Notification",
    on: true,
    globalOnly: true,
  },
  { id: "GuardDuty", source: "aws.guardduty", detailType: "GuardDuty Finding", on: true },
  { id: "BackupJob", source: "aws.backup", detailType: "Backup Job State Change", on: false },
  { id: "Ec2Spot", source: "aws.ec2", detailType: "EC2 Spot Instance Interruption Warning", on: false },
  { id: "AutoScalingFail", source: "aws.autoscaling", detailType: "EC2 Instance Launch Unsuccessful", on: false },
  { id: "Rds", source: "aws.rds", detailType: "RDS DB Instance Event", on: false },
  { id: "Config", source: "aws.config", detailType: "Config Rules Compliance Change", on: false },
];

/** 规则物理名。两条路径同名 —— 客户按文档去控制台找的就是这个名字。 */
export function webNotifRuleName(id: string): string {
  return `notiops-web-notif-${id.toLowerCase()}`;
}

/**
 * 规则的 Description（控制台上那一行）。**必须纯 ASCII**，理由同上。
 *
 * 为什么值得写：方式 A 的模板是**预先合成**的，合成期还不知道客户会开在哪个区域
 * （区域是 `AWS::Region` 伪参数），所以给不出方式 B 那句 synth 警告。全局服务那两条
 * 规则在非 us-east-1 永不触发这件事，只能写在客户点开规则时看得见的地方。
 */
export function webNotifRuleDescription(src: WebNotifSource): string {
  const base = `NotiOps web notifications: ${src.detailType} (${src.source}).`;
  return src.globalOnly
    ? `${base} This is a global service that only emits EventBridge events in ` +
      "us-east-1; outside us-east-1 this rule never fires."
    : base;
}

/**
 * handler 的环境变量。只有这三个是它真正读的（其余带默认值，见
 * `shared/report_delivery/web_push_handler.py` 的文件头）。
 *
 * `NOTIF_INBOX_KEY=account`：一期账号级共享一份收件箱。
 * `NOTIF_TTL_DAYS=90`：DynamoDB TTL，过期自动清。
 */
export function webNotifEnv(webChatTableName: string): Record<string, string> {
  return {
    WEB_CHAT_TABLE: webChatTableName,
    NOTIF_INBOX_KEY: "account",
    NOTIF_TTL_DAYS: "90",
  };
}
