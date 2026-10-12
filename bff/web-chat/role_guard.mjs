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

import { userError } from "./safe_err.mjs";

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
    // userError：这段文案是手写的、不含任何上游散文，且 ARN 就是调用方自己传进来的
    // 那一个 —— 显式标记成可外显，errBody 才不会把它压成一句干巴巴的 code。
    throw userError(
      `role ARN 不属于账号 ${acct || "?"}（ARN 账号段=${got || "无法解析"}）—— `
      + `拒绝 AssumeRole。这是 confused-deputy 防御：config 表里的角色 ARN 指向了`
      + `别的账号，通常意味着登记数据被写错或被篡改。ARN=${String(roleArn || "")}`, code);
  }
  return got;
}

/* ── 成员账号跨账号角色的新旧两代名字（2026-10 改名）──────────────────────────
 *
 * 成员账号里的采集 / 只读角色原名 `notiops-idle-detection-role-<系统账号>`（老
 * idle-detector 遗留名），新接入改成 `notiops-cross-account-role-<系统账号>`。
 *
 * 🔴 改名 = CloudFormation 替换角色，而触发更新的路径（setup.sh / stager 的
 *    update-stack-set 异步滚动、非 Org 客户自己更新栈）时机不由我们控制 ——
 *    注册表 `account#<id>.role_arn` 存的那一代随时可能已被删、或新的那一代还没建。
 *    所以 AssumeRole 时把两代当别名：先用注册表里的，AccessDenied 再换另一代试一次。
 *
 * ⚠️ 与 Python 侧 `shared/account_scope.py::sibling_role_arn` 同一条规则，改一边
 *    必须改另一边。只认**带 12 位后缀**的两种形态；账号段不变，所以
 *    `assertRoleBelongsTo` 对原 ARN 的结论对别名同样成立。
 */
export const CROSS_ACCOUNT_ROLE_PREFIX = "notiops-cross-account-role";
export const LEGACY_CROSS_ACCOUNT_ROLE_PREFIX = "notiops-idle-detection-role";
const ALIAS_RE =
  /^(arn:aws(?:-[a-z-]+)?:iam::\d{12}:role\/)(notiops-cross-account-role|notiops-idle-detection-role)-(\d{12})$/;

/** 给一代名字，返回同账号、同后缀的另一代；不是这两种形态 → 空串。 */
export function siblingRoleArn(roleArn) {
  const m = ALIAS_RE.exec(String(roleArn || "").trim());
  if (!m) return "";
  const other = m[2] === CROSS_ACCOUNT_ROLE_PREFIX
    ? LEGACY_CROSS_ACCOUNT_ROLE_PREFIX : CROSS_ACCOUNT_ROLE_PREFIX;
  return `${m[1]}${other}-${m[3]}`;
}

/** STS AssumeRole 的「角色不存在 / 不信任我」—— 只有这类错误才值得换别名再试。 */
export function isAccessDenied(e) {
  const code = e?.name || e?.Code || e?.code || "";
  return code === "AccessDenied" || code === "AccessDeniedException";
}

/** 进程内记忆：注册表 ARN → 上次实际成功的别名（与 Python 侧 `_ALIAS_MEMO` 同语义）。
 *  🔴 没有它，栈已换名而注册表没换的账号每次都要先吃一次 AccessDenied —— 一个看板页
 *     对每个成员账号就是好几条 CloudTrail AccessDenied，容易触发客户的安全告警。 */
const _aliasMemo = new Map();

/** AssumeRole 要试的 ARN 顺序：注册表里那个优先，别名（若有）其次；
 *  本进程上次已证明别名才对，就反过来。 */
export function roleArnCandidates(roleArn) {
  const alt = siblingRoleArn(roleArn);
  if (!alt) return [roleArn];
  return _aliasMemo.get(roleArn) === alt ? [alt, roleArn] : [roleArn, alt];
}

/** 仅供测试：清空进程内别名记忆，让用例之间互不影响。 */
export function _resetRoleArnMemoForTest() { _aliasMemo.clear(); }

/** 记下这次实际成功的是哪一个（`used === registered` 时清掉记忆）。 */
export function rememberRoleArnHit(registered, used) {
  if (!registered) return;
  if (used && used !== registered && siblingRoleArn(registered) === used) {
    _aliasMemo.set(registered, used);
  } else {
    _aliasMemo.delete(registered);
  }
}
