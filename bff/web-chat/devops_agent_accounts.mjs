/**
 * DevOps Agent 关联账号动态发现 —— 替代硬编码账号 ID（用户需求：不要写死账号，
 * 用 DevOps Agent 自己的账号关联信息动态判断）。
 *
 * 数据源：devops-agent:ListAssociations（列出 Agent Space 下所有关联账号），
 * 每条关联的 configuration.aws / configuration.sourceAws 里带 accountId +
 * assumableRoleArn。本模块在此基础上：
 *   1. 列出全部关联账号（不区分 monitor/source，两种都能拿到 accountId + role）
 *   2. 对每个账号尝试 AssumeRole → organizations:DescribeOrganization，
 *      MasterAccountId 与该 accountId 相同 → 判定为 payer 账号
 *   3. 缓存发现结果（进程生命周期内，Agent Space 关联关系不会频繁变化）
 *
 * 权限前提：BFF Lambda Role 需要 devops-agent:ListAssociations（本账号内） +
 * sts:AssumeRole 到各关联账号的 assumableRoleArn（Trust Policy 需在对方账号侧
 * 显式信任本 BFF Role，见 infra/lib/web-chat-stack.ts §1c 注释）。
 */
import { DevOpsAgentClient, ListAssociationsCommand } from "@aws-sdk/client-devops-agent";
import { OrganizationsClient, DescribeOrganizationCommand } from "@aws-sdk/client-organizations";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const REGION = process.env.AWS_REGION || "us-east-1";
const AGENT_SPACE_ID = process.env.DEVOPS_AGENT_SPACE_ID || "";
// BFF 部署账号 ID（约定角色名的后缀）。web-chat-stack.ts 注入 LOCKED_ACCOUNT_ID=部署账号。
const SELF_ACCOUNT_ID = process.env.LOCKED_ACCOUNT_ID || "";
// payer 侧可被 BFF 假设的成本只读角色名前缀。DevOps Agent onboarding 在 payer 里按
// 部署账号命名（DevOpsAgentRole-AgentSpace-notiOps-<部署账号>），该角色挂
// AIDevOpsAgentAccessPolicy（含 ce:*/budgets:*/cur:* 只读）。可用 env 覆盖以适配改名。
const PAYER_COST_ROLE_PREFIX = process.env.NOTIOPS_PAYER_COST_ROLE_PREFIX || "DevOpsAgentRole-AgentSpace-notiOps-";

const _devopsAgent = new DevOpsAgentClient({ region: REGION });
const _sts = new STSClient({ region: REGION });

// 进程级缓存：Agent Space 的关联账号列表很少变化，缓存 10 分钟足够，避免每次
// FinOps 仪表盘请求都重新拉一遍 + 逐个 AssumeRole 判断 payer（有延迟成本）。
const _CACHE_TTL_MS = 10 * 60 * 1000;
let _cachedAccounts = null;
let _cachedAt = 0;

/**
 * 从一条 association 的 configuration 里提取 { accountId, roleArn, accountType }。
 * configuration 是 tagged union（aws / sourceAws 二选一），两种都取。
 */
function _extractAccount(assoc) {
  const cfg = assoc.configuration || {};
  if (cfg.aws) {
    return { accountId: cfg.aws.accountId, roleArn: cfg.aws.assumableRoleArn, accountType: cfg.aws.accountType || "monitor" };
  }
  if (cfg.sourceAws) {
    return { accountId: cfg.sourceAws.accountId, roleArn: cfg.sourceAws.assumableRoleArn, accountType: cfg.sourceAws.accountType || "source" };
  }
  return null;
}

/** 尝试 AssumeRole 到某账号 + 判断是否为 Organization payer（DescribeOrganization
 * 成功且 MasterAccountId 等于该账号自身 → payer；调用失败/不匹配 → 非 payer 或无权限）。
 * 返回 { credentials, isPayer } 或 null（AssumeRole 本身失败，如 Trust Policy 未配置）。
 */
async function _assumeAndCheckPayer(accountId, roleArn) {
  let creds;
  try {
    const resp = await _sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "notiops-web-chat-bff-account-discovery",
      DurationSeconds: 3600,
    }));
    creds = {
      accessKeyId: resp.Credentials.AccessKeyId,
      secretAccessKey: resp.Credentials.SecretAccessKey,
      sessionToken: resp.Credentials.SessionToken,
    };
  } catch (e) {
    // Trust Policy 未信任本 BFF Role，或角色已失效——记录但不中断整体发现流程
    // （其它账号可能能 assume 成功）。
    return { accountId, roleArn, assumable: false, isPayer: false, error: String(e?.message || e) };
  }

  let isPayer = false;
  try {
    const org = new OrganizationsClient({ region: "us-east-1", credentials: creds });
    const orgResp = await org.send(new DescribeOrganizationCommand({}));
    isPayer = orgResp.Organization?.MasterAccountId === accountId;
  } catch {
    // DescribeOrganization 失败：可能该角色缺 organizations:Describe* 权限，
    // 或该账号确实不在任何 Organization 里——都按"非 payer"处理，不算错误。
  }

  return { accountId, roleArn, assumable: true, isPayer, credentials: creds };
}

/**
 * 列出 Agent Space 关联的全部账号，标注每个账号的 payer 状态。
 * 返回 [{ accountId, roleArn, accountType, assumable, isPayer }]（不含 credentials，
 * 避免把临时凭证意外传出这个模块之外——需要凭证时用 getAssumedCredentialsForAccount）。
 */
export async function listAssociatedAccounts() {
  const now = Date.now();
  if (_cachedAccounts && now - _cachedAt < _CACHE_TTL_MS) return _cachedAccounts;

  if (!AGENT_SPACE_ID) {
    _cachedAccounts = [];
    _cachedAt = now;
    return _cachedAccounts;
  }

  const associations = [];
  let nextToken;
  do {
    const resp = await _devopsAgent.send(new ListAssociationsCommand({
      agentSpaceId: AGENT_SPACE_ID, nextToken, maxResults: 50,
    }));
    associations.push(...(resp.associations || []));
    nextToken = resp.nextToken;
  } while (nextToken);

  const accounts = associations.map(_extractAccount).filter((a) => a && a.accountId && a.roleArn);
  const checked = await Promise.all(accounts.map((a) => _assumeAndCheckPayer(a.accountId, a.roleArn)));

  _cachedAccounts = checked.map((c) => ({
    accountId: c.accountId, roleArn: c.roleArn, assumable: c.assumable, isPayer: c.isPayer,
    accountType: accounts.find((a) => a.accountId === c.accountId)?.accountType || "unknown",
  }));
  _cachedAt = now;
  return _cachedAccounts;
}

/** 找到 payer 账号（如果有）。
 * 主路径：用 organizations:DescribeOrganization 动态发现 payer（BFF 在成员账号里
 * 就能调，返回 MasterAccountId）——不依赖 DevOps Agent 关联，因为本项目每个业务账户
 * 的 AgentSpace 只监控自己、关联里通常不含 payer。发现 payer 后，用「约定角色名」拼出
 * payer 侧可假设的成本只读角色 ARN（DevOpsAgentRole-AgentSpace-notiOps-<部署账号>）。
 * 兜底：DescribeOrganization 无权限/非 org 成员/payer==自己 → 回落到原来的
 * DevOps Agent 关联发现逻辑（保持向后兼容）。无 payer → null。 */
export async function findPayerAccount() {
  try {
    const org = new OrganizationsClient({ region: "us-east-1" });
    const resp = await org.send(new DescribeOrganizationCommand({}));
    const payerId = resp.Organization?.MasterAccountId;
    // 部署账号本身就是 payer（管理账号）→ 不需要跨账号，直接 return null 走「本账号 CE 视角」。
    // 关键：这里必须 return，不能往下 fall through 到 listAssociatedAccounts()——否则单账号
    // 场景也会去调 devops-agent:ListAssociations，一旦该调用抛错就把 CE/Budgets 查询整体拖垮
    // （findPayerAccount 抛出 → _getCeClient/_getBudgetsClient 抛出 → 仪表盘卡片全空）。
    if (payerId && SELF_ACCOUNT_ID && payerId === SELF_ACCOUNT_ID) return null;
    if (payerId && SELF_ACCOUNT_ID) {
      const roleArn = `arn:aws:iam::${payerId}:role/${PAYER_COST_ROLE_PREFIX}${SELF_ACCOUNT_ID}`;
      return { accountId: payerId, roleArn, isPayer: true, assumable: true, source: "organizations" };
    }
  } catch {
    // 无 organizations:DescribeOrganization 权限或非 org 成员 → 走下面兜底
  }
  // 兜底：DevOps Agent 关联发现。异常必须吞掉——绝不能让它抛出（见上注释：会拖垮 CE/Budgets）。
  try {
    const accounts = await listAssociatedAccounts();
    return accounts.find((a) => a.isPayer && a.assumable) || null;
  } catch {
    return null;
  }
}

/** 按 accountId 拿一份新鲜的临时凭证（不复用缓存的 credentials 对象，因为那些可能
 * 已经过期——调用方各自按需 AssumeRole，成本是多一次 STS 调用，换来凭证一定有效）。
 * 传入 roleArn 时直接假设该角色（用于 DescribeOrganization 发现的 payer——它不在
 * DevOps Agent 关联缓存里）；不传则回退到从关联缓存按 accountId 查角色。
 * 找不到角色 / assume 失败 → 返回 null。 */
export async function getAssumedCredentialsForAccount(accountId, roleArn) {
  let arn = roleArn;
  if (!arn) {
    // 关联发现是 best-effort：任何失败（如 aidevops:ListAssociations 无权限、无
    // AgentSpace、限流）都必须吞掉并返回 null——绝不能抛出，否则会拖垮 _getCeClient
    // → FinOps 仪表盘整体 500。返回 null 时调用方（_getCeClient）会回退到本账号 CE 视角。
    try {
      const accounts = await listAssociatedAccounts();
      const acct = accounts.find((a) => a.accountId === accountId);
      if (!acct || !acct.assumable) return null;
      arn = acct.roleArn;
    } catch {
      return null;
    }
  }
  try {
    const resp = await _sts.send(new AssumeRoleCommand({
      RoleArn: arn,
      RoleSessionName: "notiops-web-chat-bff-cost-query",
      DurationSeconds: 3600,
    }));
    return {
      accessKeyId: resp.Credentials.AccessKeyId,
      secretAccessKey: resp.Credentials.SecretAccessKey,
      sessionToken: resp.Credentials.SessionToken,
    };
  } catch {
    return null;
  }
}
