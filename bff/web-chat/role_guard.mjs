/**
 * role ARN 账号段校验（confused-deputy 防御）—— JS 侧单一真源。
 *
 * 与 Python 侧 `shared/account_scope.py::assert_role_belongs_to` 同一威胁模型
 * （那边的注释有完整攻击链论证，2026-08-30 补）：config 表是本系统最弱的写入口
 * —— 有管理权限的用户就能写 `account#<id>` 的 `role_arn` 或 `da#<id>` 的
 * `trigger_role_arn`。不校验账号段的后果：
 *
 *   写一条 role_arn 指向**攻击者自己账号**的行 → BFF 拿部署账号的执行角色
 *   去 assume 攻击者的角色 → security/health/alarms/eos 等跨账号看板把
 *   攻击者账号的数据渲染成受害账号的；skill 上传路径则会把判读 skill
 *   传进攻击者的 space。
 *
 * IAM 侧不兜底：BFF 执行角色的 sts:AssumeRole 授权是 `arn:aws:iam::*`
 * 账号段通配（web-chat-core.ts，为了免部署接入新成员账号）—— 所以
 * **这里是唯一一格防线**。Python 侧已全量装上，JS 侧四个 assume 点
 * （xacct / devops_agent_accounts / devops_agent_skills / member_accounts）
 * 此前零覆盖，2026-09-06 交叉 review 抓出后统一收口到本模块。
 *
 * ⚠️ 新增任何 AssumeRole 调用点都必须先过 `assertRoleBelongsTo` ——
 *    `bff/web-chat/tests/role_guard.test.mjs` 的元断言盯着调用点数量。
 */

const ROLE_ARN = /^arn:aws(?:-[a-z-]+)?:iam::(\d{12}):role\/.+$/;

/** 解析 role ARN 的账号段；不是合法 role ARN → 空串。 */
export function roleArnAccount(roleArn) {
  const m = ROLE_ARN.exec(String(roleArn || "").trim());
  return m ? m[1] : "";
}

/**
 * role ARN 必须属于 accountId，否则抛错（默认 code=bad_request，路由层转 400）。
 * 返回解析出的账号段，调用方可直接继续用。
 */
export function assertRoleBelongsTo(roleArn, accountId, code = "bad_request") {
  const acct = String(accountId || "").trim();
  const got = roleArnAccount(roleArn);
  if (!acct || !got || got !== acct) {
    const e = new Error(
      `role ARN 不属于账号 ${acct || "?"}（ARN 账号段=${got || "无法解析"}）—— `
      + `拒绝 AssumeRole。这是 confused-deputy 防御：config 表里的角色 ARN 指向了`
      + `别的账号，通常意味着登记数据被写错或被篡改。ARN=${String(roleArn || "")}`);
    e.code = code;
    throw e;
  }
  return got;
}
