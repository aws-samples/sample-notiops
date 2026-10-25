/**
 * 跨账号凭证统一入口（per-dashboard ?account= 契约的地基）。
 *
 * credsFor(accountId):
 *   · 空 / 部署账号自身 → null（调用方用默认凭证）
 *   · 成员账号 → 读 config 表 account#<id> 的 role_arn（接入时由 StackSet 写入，
 *     带管理账号后缀的 notiops-cross-account-role-<mgmt>；2026-10 前接入的是
 *     notiops-idle-detection-role-<mgmt>，两代互为别名）→ STS AssumeRole
 *   · 账号未接入 / 角色不可用 / 在 Admin「账户」页被停用 → 抛 cross_account_unavailable（调用方降级展示）
 *
 * 所有仪表盘模块（security/cases/health/...）统一走这里拿凭证，
 * 新仪表盘只需接受 accountId 参数并调用本函数 —— 不要各自造 AssumeRole。
 * 凭证缓存复用 devops_agent_accounts.getAssumedCredentialsForAccount（50 分钟）。
 */
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getAssumedCredentialsForAccount } from "./devops_agent_accounts.mjs";

const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const _sts = new STSClient({});

let _selfAccountId = "";
export async function selfAccountId() {
  if (_selfAccountId) return _selfAccountId;
  const r = await _sts.send(new GetCallerIdentityCommand({}));
  _selfAccountId = r.Account || "";
  return _selfAccountId;
}

/** 成员账号 → 临时凭证；部署账号自身/空 → null。
 *
 *  `enabled !== true`（在 Admin「账户」页停用了）一律拒绝（待办 #38 ⑤）：以前这里只看 role_arn，
 *  停用的成员账号从账号下拉里消失了（accounts.mjs 只列 enabled），但看板接口带上它的 id 照样能
 *  AssumeRole 进去查 —— 停用没停干净。support.mjs 的 `_registryRoleArn` 早就是这个口径。
 *  `allowDisabled`：只给 Admin 的接入流程用（接入完成前那一行还是 enabled=false）。 */
export async function credsFor(accountId, { allowDisabled = false } = {}) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  if (id === (await selfAccountId())) return null;

  const rec = await ddb.send(new GetCommand({
    TableName: CONFIG_TABLE, Key: { PK: `account#${id}`, SK: "meta" },
  }));
  if (rec.Item && rec.Item.enabled !== true && !allowDisabled) {
    const e = new Error(`account ${id} is disabled`);
    e.code = "cross_account_unavailable";
    throw e;
  }
  const roleArn = rec.Item && rec.Item.role_arn;
  if (!roleArn) {
    const e = new Error(`account ${id} not onboarded (no role_arn in config)`);
    e.code = "cross_account_unavailable";
    throw e;
  }
  const creds = await getAssumedCredentialsForAccount(id, roleArn);
  if (!creds) {
    const e = new Error(`assume ${roleArn} failed`);
    e.code = "cross_account_unavailable";
    throw e;
  }
  return creds;
}
