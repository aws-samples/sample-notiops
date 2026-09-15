/**
 * 把一个异常压成「只剩类型名 + 错误码」的一小段字符串。
 *
 * 为什么必须有这么一个东西：AWS SDK 的 `e.message` 是**成句的英文散文**，里面常规带
 * 12 位账号 id、完整 role/资源 ARN、表名 / database 名、甚至 SQL 片段 ——
 *   `User: arn:aws:sts::123456789012:assumed-role/… is not authorized to perform:
 *    dynamodb:Query on resource: arn:aws:dynamodb:us-east-1:123456789012:table/notiops-web-chat`
 * 这些串一旦进了 HTTP 响应体，就会被前端**原样画到页面上**（不是只躺在 DevTools 里）。
 * 运维真正需要的诊断信息只有那个**异常名**（`AccessDenied` 与 `NoSuchEntity` 指向完全
 * 不同的动作），而异常名恰好不含任何拓扑信息 —— 所以这里保留名字、丢掉散文。
 *
 * 口径与 docs/LOGGING_STANDARD.md 一致，也与 `finops.mjs::_clientErr`、
 * `devops_investigate.mjs::safeErr` 是同一套。放成独立叶子模块的原因：router
 * （index.mjs）要用，而它不该为了一个两行的工具去 import 整个 devops_investigate.mjs
 * （那是冷启动路径上最重的模块之一）。
 */

/** `TypeError/AccessDeniedException` 这种形状。绝不含 message。 */
export function safeErr(e) {
  const code = e?.name || e?.$metadata?.httpStatusCode || "unknown";
  return `${e?.constructor?.name || "Error"}/${code}`;
}

/**
 * 造一个**明确标记为可以给用户看**的错误。
 *
 * 判据不是"这段话看起来还挺友好"，而是**这段话是谁写的**：`userError()` 的文案一定是
 * 仓库里手写的校验提示（"zip 里没有 SKILL.md"、"prompt too short"），作者已经确认过它
 * 不含账号 id / ARN / 表名。凡是从 AWS SDK、Node 内置、第三方冒上来的异常都**不许**用
 * 这个函数包 —— 那些的 message 是散文，正是 `safeErr` 要挡掉的东西。
 *
 * 为什么要有这么一个显式标记：一刀切地把所有 `e.message` 都换成异常名，会把
 * "zip 里没有 SKILL.md（Agent Skills 开放标准要求一个 SKILL.md）" 这种**用户唯一能据以
 * 修好问题**的提示变成 `Error/Error`。那不是修好了泄漏，是把泄漏和可用性一起砍了。
 *
 * @param {string} message 手写的、确认可外显的文案
 * @param {string} code 机器可读码（前端 branch 用）
 */
export function userError(message, code = "bad_request") {
  return Object.assign(new Error(message), { code, userMessage: message });
}

/**
 * 响应体里那个 `error` 字段该填什么。三档，顺序不能反：
 *   1. `e.userMessage` —— 显式标记过可外显的手写文案，原样回（前端直接渲染这段话）；
 *   2. `e.code` —— **我们自己造的**机器可读码（`bad_request` / `org_mode_disabled` /
 *      `cross_account_unavailable`），前端按码映射本地化文案；
 *   3. `safeErr(e)` —— 其余一切（AWS SDK / 运行时异常）只回"类型名/错误码"。
 * 反过来（先 code 后 userMessage）会把第 1 档的文案吞掉；跳过第 2 档会打掉前端的
 * `if (e?.error === "bad_request")` 分支。
 */
export const errBody = (e) => (
  e?.userMessage
    ? { error: String(e.userMessage), code: e?.code || "bad_request" }
    : { error: e?.code || safeErr(e) }
);
