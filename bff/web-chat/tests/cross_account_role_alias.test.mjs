/**
 * 成员账号跨账号角色的新旧两代名字互为别名（2026-10 改名）—— 行为测试。
 *
 * 角色从 `notiops-idle-detection-role-<系统账号>` 改名为
 * `notiops-cross-account-role-<系统账号>`。改名 = CFN 替换角色，而触发更新的
 * 路径（StackSet 异步滚动、客户自己更新栈）时机不由我们控制，所以：
 *
 *   ① 「验证并登记」新名优先、旧名兜底，**登记真正通了的那一个**
 *   ② 取凭证时注册表里那一代 AccessDenied → 换另一代再试；非 AccessDenied 不换
 *
 * 这里真的调函数（猴补 STSClient / DynamoDBDocumentClient 的 send），
 * 不做源码文本断言。
 */
process.env.DEPLOY_ACCOUNT_ID = "111122223333";
process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const SYS = "111122223333";
const MEM = "444455556666";
const NEW = `arn:aws:iam::${MEM}:role/notiops-cross-account-role-${SYS}`;
const OLD = `arn:aws:iam::${MEM}:role/notiops-idle-detection-role-${SYS}`;

const stsLib = await import("@aws-sdk/client-sts");
const ddbLib = await import("@aws-sdk/lib-dynamodb");
const origSts = stsLib.STSClient.prototype.send;
const origDdb = ddbLib.DynamoDBDocumentClient.prototype.send;

/** 只有 `exists` 里的 ARN 能 assume；其余抛 `deny`（默认 AccessDenied）。 */
function mockSts(exists, deny = "AccessDenied") {
  const calls = [];
  stsLib.STSClient.prototype.send = async function (cmd) {
    const n = cmd.constructor?.name || "";
    if (n === "GetCallerIdentityCommand") return { Account: SYS };
    const arn = cmd.input.RoleArn;
    calls.push(arn);
    if (exists.includes(arn)) {
      return { Credentials: { AccessKeyId: "AK", SecretAccessKey: "SK", SessionToken: "ST" } };
    }
    throw Object.assign(new Error("denied"), { name: deny });
  };
  return calls;
}

function mockDdb() {
  const writes = [];
  ddbLib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd.constructor?.name || "";
    if (n === "UpdateCommand") {
      const vals = cmd.input.ExpressionAttributeValues || {};
      const names = cmd.input.ExpressionAttributeNames || {};
      const row = {};
      for (const [k, v] of Object.entries(names)) {
        const vk = ":v" + k.slice(2);
        if (vk in vals) row[v] = vals[vk];
      }
      writes.push(row);
    }
    return {};
  };
  return writes;
}

/** 记录所有写命令的原始 input；GetCommand 按 PK 回 `rows[PK]`。 */
function mockDdbRaw(rows = {}) {
  const writes = [];
  ddbLib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd.constructor?.name || "";
    if (n === "GetCommand") {
      const item = rows[String(cmd.input.Key?.PK || "")];
      return item ? { Item: item } : {};
    }
    if (n === "UpdateCommand" || n === "PutCommand") writes.push(cmd.input);
    return {};
  };
  return writes;
}

const supportLib = await import("@aws-sdk/client-support");
const origSupport = supportLib.SupportClient.prototype.send;
supportLib.SupportClient.prototype.send = async function () { return { cases: [] }; };

const guard = await import("../role_guard.mjs");
const mod = await import("../member_accounts.mjs");
const accts = await import("../devops_agent_accounts.mjs");
const support = await import("../support.mjs");

try {
  /* ── ① verifyAndRegisterCollectionRole ── */
  ok("collectionRoleArn 推导的是新名", mod.collectionRoleArn(MEM, SYS) === NEW);

  {
    const calls = mockSts([NEW]); const writes = mockDdb();
    const r = await mod.verifyAndRegisterCollectionRole(MEM);
    ok("★ 新名能 assume → 登记新名", r.roleArn === NEW && writes[0]?.role_arn === NEW);
    ok("新名通了就不再试旧名", calls.length === 1);
  }
  {
    const calls = mockSts([OLD]); const writes = mockDdb();
    const r = await mod.verifyAndRegisterCollectionRole(MEM);
    ok("★★★ 只有旧名（栈还没更新）→ 登记旧名，而不是登记一个 assume 不进去的新名",
      r.roleArn === OLD && writes[0]?.role_arn === OLD);
    ok("试的顺序：新名 → 旧名", JSON.stringify(calls) === JSON.stringify([NEW, OLD]));
  }
  {
    mockSts([]); const writes = mockDdb();
    let err = null;
    try { await mod.verifyAndRegisterCollectionRole(MEM); } catch (e) { err = e; }
    ok("★ 两个都不通 → 抛 cross_account_unavailable", err?.code === "cross_account_unavailable");
    ok("报错里报的是新名（客户要补的是用新模板部署）", String(err?.message).includes(NEW));
    ok("两个都不通 → 不写库", writes.length === 0);
  }
  {
    const calls = mockSts([OLD], "Throttling"); mockDdb();
    let err = null;
    try { await mod.verifyAndRegisterCollectionRole(MEM); } catch (e) { err = e; }
    ok("限流不是「角色不存在」→ 不换名重试", calls.length === 1 && !!err);
  }

  /* ── ② getAssumedCredentialsForAccount（xacct / 巡检看板 / 案例都走它）── */
  {
    guard._resetRoleArnMemoForTest();
    const calls = mockSts([NEW]); const writes = mockDdbRaw();
    const c = await accts.getAssumedCredentialsForAccount(MEM, OLD);
    ok("★★★ 注册表存旧名、栈已换成新名 → 换别名拿到凭证",
      c?.accessKeyId === "AK" && JSON.stringify(calls) === JSON.stringify([OLD, NEW]));
    const w = writes.find((x) => x.UpdateExpression === "SET role_arn = :actual");
    ok("★★ 别名成功 → 条件回写注册表（role_arn = 旧值 才改成新值）",
      w && w.Key.PK === `account#${MEM}` && w.ConditionExpression === "role_arn = :registered"
      && w.ExpressionAttributeValues[":registered"] === OLD
      && w.ExpressionAttributeValues[":actual"] === NEW);
    const calls2 = mockSts([NEW]);
    await accts.getAssumedCredentialsForAccount(MEM, OLD);
    ok("★★ 进程内记忆：同一进程第二次直接用别名，不再先吃 AccessDenied",
      JSON.stringify(calls2) === JSON.stringify([NEW]));
  }
  {
    guard._resetRoleArnMemoForTest();
    const writes = mockDdbRaw();
    const done = await accts.persistAliasedRoleArn(MEM, OLD,
      `arn:aws:iam::${MEM}:role/something-else`);
    ok("回写只接受互为别名的两个值（不能变成任意改 role_arn 的口子）",
      done === false && writes.length === 0);
  }
  {
    guard._resetRoleArnMemoForTest();
    const calls = mockSts([OLD]);
    const c = await accts.getAssumedCredentialsForAccount(MEM, NEW);
    ok("★★ 注册表存新名、StackSet 还没滚到 → 反向换回旧名",
      c?.accessKeyId === "AK" && JSON.stringify(calls) === JSON.stringify([NEW, OLD]));
  }
  {
    guard._resetRoleArnMemoForTest();
    const calls = mockSts([OLD]); const writes = mockDdbRaw();
    const c = await accts.getAssumedCredentialsForAccount(MEM, OLD);
    ok("注册表那一代能用 → 只调一次、不回写",
      c?.accessKeyId === "AK" && calls.length === 1 && writes.length === 0);
  }

  /* ── ③ 案例（support.mjs::supportClientFor，经 casesSummary 走一遍）── */
  for (const [registered, exists, why] of [
    [OLD, NEW, "注册表旧名、栈已换新名"],
    [NEW, OLD, "注册表新名、栈还是旧名"],
  ]) {
    guard._resetRoleArnMemoForTest();
    const calls = mockSts([exists]);
    mockDdbRaw({ [`account#${MEM}`]: { enabled: true, role_arn: registered } });
    const r = await support.casesSummary(MEM);
    ok(`★★ 案例跨账号：${why} → 换别名成功`,
      r?.ok === true && JSON.stringify(calls) === JSON.stringify([registered, exists]));
  }
  {
    guard._resetRoleArnMemoForTest();
    const calls = mockSts([]);
    mockDdbRaw({ [`account#${MEM}`]: { enabled: true, role_arn: OLD } });
    const r = await support.casesSummary(MEM);
    ok("案例跨账号：两代都不通 → cross_account_unavailable（不回落部署账号）",
      r?.code === "cross_account_unavailable" && calls.length === 2);
  }

  /* ── ④ 管理页状态：旧名不是 mismatch（R2 review P1-1）── */
  for (const [registered, wantMismatch, wantLegacy, why] of [
    [OLD, false, true, "存量账号登记的旧名 → 不报「巡检会失败」"],
    [NEW, false, false, "新名 → 正常"],
    [`arn:aws:iam::${MEM}:role/notiops-idle-detection-role-999999999999`, true, false,
      "别的系统账号后缀 → 仍是 mismatch"],
    [`arn:aws:iam::${MEM}:role/custom`, true, false, "手工贴的别的名字 → 仍是 mismatch"],
  ]) {
    mockSts([]);
    mockDdbRaw({ [`account#${MEM}`]: { role_arn: registered } });
    const s = await mod.inspectionCrossAccountStatus(MEM);
    ok(`★★★ inspectionCrossAccountStatus：${why}`,
      s.collection.mismatch === wantMismatch && s.collection.legacyName === wantLegacy);
  }
  {
    const custom = `arn:aws:iam::${MEM}:role/customer-made-role`;
    const calls = mockSts([]);
    const c = await accts.getAssumedCredentialsForAccount(MEM, custom);
    ok("非这两种形态的角色 → 不换名，失败即 null", c === null && calls.length === 1);
  }
  {
    const calls = mockSts([NEW]);
    const c = await accts.getAssumedCredentialsForAccount(
      "999999999999", OLD);
    ok("账号段不匹配 → 在 AssumeRole 之前就拒（别名不能绕过 confused-deputy 防御）",
      c === null && calls.length === 0);
  }
} finally {
  stsLib.STSClient.prototype.send = origSts;
  ddbLib.DynamoDBDocumentClient.prototype.send = origDdb;
  supportLib.SupportClient.prototype.send = origSupport;
}

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
