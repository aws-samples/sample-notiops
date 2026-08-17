"""
Secret 读权限必须**按资源收窄**，禁止 `Resource: "*"`。

为什么单独立一条测试守着它：`call_aws`（agent 的 AWS CLI 工具）跑在子进程里，继承的是
所在角色的完整权限。防止它读出 Bedrock API Key 明文，现在靠三道防线：

  ① READ_OPERATIONS_ONLY —— 只放行只读操作
  ② 进程内命令级 denylist —— 拦 `secretsmanager get-secret-value` / `kms decrypt` /
     `ssm get-parameter --with-decryption` 这类"本身属于只读、因而会被 ① 放行"的动作
     （见 core/aws_api_mcp.py，有 scripts/test_aws_api_mcp_denylist.py 守着）
  ③ 子进程 env 剥离 `AWS_BEARER_TOKEN_*` —— Key 不以环境变量形式进子进程

①②③ 都是**进程内**的软防线，靠字符串匹配。真正的兜底是 IAM：即使 denylist 被某种命令
写法绕过，角色本身也只能读到那几个指定的 Secret，读不到任意密钥。

spec 里原本计划的 task 2.9.2 是给子进程换一套降权凭证（新建角色 + 临时凭证注入 + 过期
刷新）。评估后没做：那套 plumbing 一旦出错会直接打断 call_aws 这个核心功能，而它防的是
"denylist 被绕过"这一种情况 —— 而该情况的影响已经被资源收窄限制成"泄露一个 Bedrock 专用
Key"，不是任意密钥、不是账号权限。

代价是：**资源收窄成了这条防护链里真正承重的那一环，却没有任何测试守着它。** 哪天有人
图省事把某个 Secret 语句改成 `Resource: "*"`，三道软防线的价值当场归零，而且没人会发现。
这个文件就是那个守卫。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_secret_grants_scoped.py
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

PASS = "✅"
FAIL = "❌"
_failed = 0

# 扫这些 CDK 源文件。用源码而非 synth 出来的模板：synth 需要 npx + 90 秒，而这条不变量
# 在源码层面就能判定，放进快速测试集里才会真的每次被跑到。
_STACK_FILES = (
    "infra/lib/notiops-backend-stack.ts",
    "infra/lib/bot-stack.ts",
    "infra/lib/web-chat-stack.ts",
    "infra/lib/api-stack.ts",
)

# Secrets Manager 的取值类动作。`DescribeSecret` / `ListSecrets` 不含密文，不在此列 ——
# 它们用 `*` 是合理的（列举本身不泄密），一并禁掉会逼人写无意义的枚举。
_SECRET_VALUE_ACTIONS = (
    "secretsmanager:GetSecretValue",
    "secretsmanager:BatchGetSecretValue",
    "secretsmanager:PutSecretValue",
    "secretsmanager:UpdateSecret",
    "secretsmanager:CreateSecret",
)


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def _policy_statements(src: str) -> list[str]:
    """粗切出每个 `new iam.PolicyStatement({...})` 的文本块。

    按括号配平扫描而不是用正则匹配整块：策略里常有嵌套的对象与数组（conditions、
    resources 数组、模板字符串），正则要么贪婪吃过头、要么在第一个 `}` 就停。
    """
    out: list[str] = []
    marker = "new iam.PolicyStatement("
    idx = 0
    while True:
        i = src.find(marker, idx)
        if i == -1:
            return out
        j = i + len(marker)
        depth = 0
        while j < len(src):
            if src[j] in "({[":
                depth += 1
            elif src[j] in ")}]":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out.append(src[i:j + 1])
        idx = j + 1


def _has_wildcard_resource(block: str) -> bool:
    """块里是否出现 `resources: ["*"]`（或含 `"*"` 单元素的等价写法）。"""
    m = re.search(r"resources\s*:\s*\[([^\]]*)\]", block, re.S)
    if not m:
        return False
    items = [x.strip() for x in m.group(1).split(",") if x.strip()]
    return any(x in ('"*"', "'*'", "`*`") for x in items)


def test_secret_value_grants_are_resource_scoped() -> None:
    print("test_secret_value_grants_are_resource_scoped")
    scanned = 0
    offenders: list[str] = []
    for rel in _STACK_FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8").read()
        for block in _policy_statements(src):
            if not any(a in block for a in _SECRET_VALUE_ACTIONS):
                continue
            scanned += 1
            if _has_wildcard_resource(block):
                sid = re.search(r'sid\s*:\s*"([^"]+)"', block)
                offenders.append(f"{rel}:{sid.group(1) if sid else '(no sid)'}")

    _check("found Secret-value statements to check", scanned > 0, f"scanned={scanned}")
    _check("no Secret-value grant uses Resource '*'",
           not offenders,
           "offenders: " + ", ".join(offenders)
           + " — a wildcard here voids the IAM backstop behind call_aws's denylist; "
             "scope it to the specific secret ARN(s)")


def test_the_detector_actually_detects() -> None:
    """自测：探测器对一个已知违规样本必须报警。

    没有这条，`_policy_statements` 的括号配平或 `_has_wildcard_resource` 的正则一旦写错，
    上面那条会因为"什么都没扫到"而假绿 —— 这正是这类静态扫描最典型的失效方式。
    """
    print("test_the_detector_actually_detects")
    bad = '''
    role.addToPolicy(new iam.PolicyStatement({
      sid: "Offender",
      effect: iam.Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: ["*"],
    }));
    '''
    blocks = _policy_statements(bad)
    _check("detector splits out the statement", len(blocks) == 1, str(len(blocks)))
    _check("detector flags Resource '*'", blocks and _has_wildcard_resource(blocks[0]))

    good = '''
    role.addToPolicy(new iam.PolicyStatement({
      sid: "Fine",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${r}:${a}:secret:notiops/bedrock-api-key-*`],
      conditions: { StringEquals: { "aws:ResourceTag/x": ["y"] } },
    }));
    '''
    gblocks = _policy_statements(good)
    _check("detector keeps a scoped statement", len(gblocks) == 1, str(len(gblocks)))
    _check("detector does not flag a scoped ARN",
           gblocks and not _has_wildcard_resource(gblocks[0]))

    # 只列举/描述类动作用 `*` 是允许的 —— 不得误报
    listing = '''
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:ListSecrets"],
      resources: ["*"],
    }));
    '''
    lblocks = _policy_statements(listing)
    _check("listing-only statements are out of scope",
           lblocks and not any(a in lblocks[0] for a in _SECRET_VALUE_ACTIONS))


def main() -> int:
    print("=" * 72)
    print("Secret 读权限按资源收窄（call_aws denylist 背后的 IAM 兜底）")
    print("=" * 72)
    test_secret_value_grants_are_resource_scoped()
    test_the_detector_actually_detects()
    print("\n" + "=" * 72)
    if _failed:
        print(f"{FAIL} {_failed} 项失败")
        return 1
    print(f"{PASS} 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
