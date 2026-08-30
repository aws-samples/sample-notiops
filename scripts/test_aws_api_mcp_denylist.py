#!/usr/bin/env python3
"""`call_aws` 的命令级 denylist 与子进程凭证剥离（spec R6.5.1 / R6.5.3）。

背景：`core/aws_api_mcp.py` 的文件头长期声称「三重防线」，而第三重（denyList）此前
**只存在于那句注释里**，代码从未实现。这个文件是补齐之后的验收，同时把两条容易在重构中
悄悄失效的性质钉住：

  * denylist 必须在 `super().stream()` **之前**生效 —— 一旦进了子进程，密文明文已经
    拿到了，事后过滤没有意义；
  * 拒绝文案里**不得回显命令内容** —— 被拒的命令本身可能带 secret 名 / KMS key id，
    把它转述回模型上下文等于自己造一次泄漏；
  * `_server_env()` 必须剥掉 `AWS_BEARER_TOKEN_*`，否则长驻进程里设过的 Bedrock API Key
    会被每个 MCP 子进程继承，而子进程执行的是 LLM 生成的命令；
  * 同时**不能**剥掉 AWS_ACCESS_KEY_ID 等 —— 子进程要靠它们以任务角色身份调 AWS。

也顺带守住"别过度拦截"：只读类命令、以及把服务名当参数值的命令不得误伤，否则这层会从
安全措施变成可用性故障。

两份副本（IM 的 core/ 与 webchat 的 agent-build/.../core/）都要过同一套断言。

Run: PYTHONPATH=. python3 scripts/test_aws_api_mcp_denylist.py
"""
from __future__ import annotations

import importlib.util
import os
import sys

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

COPIES = (
    ("im", os.path.join(ROOT, "core", "aws_api_mcp.py")),
    ("webchat", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                             "NotiOpsWebChat", "core", "aws_api_mcp.py")),
)
ENV_COPIES = (
    ("im/aws_api", os.path.join(ROOT, "core", "aws_api_mcp.py")),
    ("im/finops", os.path.join(ROOT, "core", "finops_mcp.py")),
    ("im/investigation", os.path.join(ROOT, "core", "investigation_mcp.py")),
    ("wc/aws_api", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                                "NotiOpsWebChat", "core", "aws_api_mcp.py")),
    ("wc/finops", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                               "NotiOpsWebChat", "core", "finops_mcp.py")),
    ("wc/investigation", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                                      "NotiOpsWebChat", "core", "investigation_mcp.py")),
)

# 必须拦：都是"只读但返回密文明文/可用凭证"的动作，防线 1(READ_OPERATIONS_ONLY) 会放行它们。
MUST_DENY = [
    "aws secretsmanager get-secret-value --secret-id notiops/bedrock-api-key",
    "aws secretsmanager batch-get-secret-value --secret-id-list a b",
    "aws kms decrypt --ciphertext-blob fileb://x",
    "aws kms generate-data-key --key-id alias/x --key-spec AES_256",
    "aws kms generate-data-key-pair --key-id alias/x --key-pair-spec RSA_2048",
    "aws kms generate-random --number-of-bytes 32",
    "aws ecr get-login-password --region us-east-1",
    "aws ecr-public get-login-password",
    # 变形：全局参数在服务名之前、大小写、多余空白、引号
    "aws --region us-east-1 secretsmanager get-secret-value --secret-id x",
    "AWS SECRETSMANAGER GET-SECRET-VALUE --secret-id x",
    "aws    secretsmanager     get-secret-value   --secret-id x",
    'aws secretsmanager get-secret-value --secret-id "notiops/bedrock-api-key"',
    "aws --output json --no-cli-pager kms decrypt --ciphertext-blob x",
    # SSM 仅在要求解密时拦
    "aws ssm get-parameter --name /notiops/x --with-decryption",
    "aws ssm get-parameters --names a b --with-decryption",
    "aws ssm get-parameters-by-path --path /notiops --recursive --with-decryption",
]

# 不得误伤：正常只读运维动作。拦掉它们会把这层从安全措施变成可用性故障。
MUST_ALLOW = [
    "aws ec2 describe-instances --max-items 5",
    "aws sts get-caller-identity",
    "aws ce get-cost-and-usage --time-period Start=2026-01-01,End=2026-02-01",
    "aws cloudwatch get-metric-statistics --namespace AWS/RDS",
    # 不解密地读参数是正常动作
    "aws ssm get-parameter --name /notiops/agent/model_id",
    "aws ssm get-parameters-by-path --path /notiops --recursive",
    "aws ssm describe-parameters --max-items 10",
    "aws ssm get-parameter --name /notiops/x --no-with-decryption",
    # 只列 secret 元数据、不取值
    "aws secretsmanager list-secrets",
    "aws secretsmanager describe-secret --secret-id x",
    # 把服务名/动作名当**参数值**的命令不得命中
    "aws ssm describe-parameters --filters Key=Name,Values=secretsmanager",
    "aws logs filter-log-events --filter-pattern kms decrypt failed",
    "aws resourcegroupstaggingapi get-resources --tag-filters Key=app,Values=kms",
    # kms 的只读元数据动作
    "aws kms list-keys",
    "aws kms describe-key --key-id alias/x",
    "",
]


def _check(name: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {name}")
    else:
        _failed += 1
        print(f"  {FAIL} {name}" + (f" :: {detail}" if detail else ""))


def _load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
def test_denylist_decisions() -> None:
    print("test_denylist_decisions")
    for label, path in COPIES:
        if not os.path.exists(path):
            _check(f"{label}: file present", False, path)
            continue
        mod = _load(path, f"_mcp_{label}")
        bad_allow = [c for c in MUST_DENY if not mod.is_denied_command(c)]
        _check(f"{label}: every secret-reading command is denied",
               not bad_allow, f"allowed: {bad_allow}")
        bad_deny = [c for c in MUST_ALLOW if mod.is_denied_command(c)]
        _check(f"{label}: no false positives on normal read-only commands",
               not bad_deny, f"denied: {bad_deny}")


def test_command_position_parsing() -> None:
    """service/operation 必须按**位置**定位，不能在整个 token 流里找相邻对。

    第一版就是找相邻对，被 `aws logs filter-log-events --filter-pattern kms decrypt
    failed` 抓到误拦 —— 搜日志里的 "kms decrypt failed" 是完全正常的排障动作。
    反方向也要防：贪婪地把布尔全局选项后面那个 token 当值吃掉，会让
    `aws --no-cli-pager kms decrypt` 漏过去。
    """
    print("test_command_position_parsing")
    mod = _load(COPIES[0][1], "_mcp_pos")
    cases = [
        # (命令, 期望的 service, 期望的 operation)
        ("aws secretsmanager get-secret-value --secret-id x", "secretsmanager", "get-secret-value"),
        ("aws --region us-east-1 kms decrypt --x y", "kms", "decrypt"),
        ("aws --output=json kms decrypt", "kms", "decrypt"),
        ("aws --no-cli-pager kms decrypt", "kms", "decrypt"),
        ("aws --debug --no-paginate kms decrypt", "kms", "decrypt"),
        ("aws --profile p --region r --output json ec2 describe-instances",
         "ec2", "describe-instances"),
        ("aws logs filter-log-events --filter-pattern kms decrypt failed",
         "logs", "filter-log-events"),
        ("secretsmanager get-secret-value", "secretsmanager", "get-secret-value"),  # 无 aws 前缀
    ]
    for cmd, want_svc, want_op in cases:
        svc, op = mod._service_and_operation(mod._normalise_cli(cmd))   # noqa: SLF001
        _check(f"parses {cmd[:52]!r} → {want_svc}/{want_op}",
               (svc, op) == (want_svc, want_op), f"got {svc}/{op}")

    # 布尔全局选项之后紧跟被拦服务的组合，必须仍然被拦（贪婪吃 token 会漏）
    for cmd in ("aws --no-cli-pager secretsmanager get-secret-value --secret-id x",
                "aws --debug kms decrypt --ciphertext-blob x",
                "aws --no-verify-ssl --no-paginate ecr get-login-password"):
        _check(f"still denied through boolean global opts: {cmd[:48]!r}",
               mod.is_denied_command(cmd))


def test_operator_can_extend_but_not_shrink() -> None:
    """AWS_API_MCP_EXTRA_DENY 只能加，不能减 —— 内置项不可被运营方关掉。"""
    print("test_operator_can_extend_but_not_shrink")
    saved = os.environ.get("AWS_API_MCP_EXTRA_DENY")
    try:
        os.environ["AWS_API_MCP_EXTRA_DENY"] = "lambda get-function-configuration, sts assume-role"
        mod = _load(COPIES[0][1], "_mcp_extra")
        _check("an operator-added pattern is honoured",
               mod.is_denied_command("aws lambda get-function-configuration --function-name f"))
        _check("a second operator-added pattern is honoured",
               mod.is_denied_command("aws sts assume-role --role-arn a --role-session-name s"))
        _check("built-in patterns remain in force",
               mod.is_denied_command("aws kms decrypt --ciphertext-blob x"))
        _check("unrelated commands are still allowed",
               not mod.is_denied_command("aws ec2 describe-instances"))
    finally:
        if saved is None:
            os.environ.pop("AWS_API_MCP_EXTRA_DENY", None)
        else:
            os.environ["AWS_API_MCP_EXTRA_DENY"] = saved


def test_ssm_only_denied_with_decryption() -> None:
    """SSM 是唯一条件性拦截的服务 —— 拦错方向会打断日常运维。"""
    print("test_ssm_only_denied_with_decryption")
    mod = _load(COPIES[0][1], "_mcp_ssm")
    _check("plain get-parameter allowed",
           not mod.is_denied_command("aws ssm get-parameter --name /a"))
    _check("--with-decryption denied",
           mod.is_denied_command("aws ssm get-parameter --name /a --with-decryption"))
    _check("--no-with-decryption allowed (explicitly not decrypting)",
           not mod.is_denied_command("aws ssm get-parameter --name /a --no-with-decryption"))


def _inner_tool_result(res) -> dict:
    """从 `_denied_result()` 的返回值里取出**内层** ToolResult。

    两种合法形状（见 `core/mcp_snapshot.py` 的 `tool_error_event()`）：
      · 装了 strands → `ToolResultEvent`，内层挂在 `.tool_result`；
      · 没装 strands（CI 的 llm-catalog-tests 就是这种）→ 裸的内层 dict。
    第三种形状 —— 外层信封 `{"type": "tool_result", "tool_result": {...}}` —— 是
    **不合法**的，下面 `test_refusal_is_not_the_outer_envelope` 专门钉它。
    """
    tr = getattr(res, "tool_result", None)
    if isinstance(tr, dict):
        return tr
    return res if isinstance(res, dict) else {}


def test_refusal_leaks_nothing() -> None:
    """拒绝结果不得含命令内容 —— 命令本身可能带 secret 名 / KMS key id。"""
    print("test_refusal_leaks_nothing")
    for label, path in COPIES:
        if not os.path.exists(path):
            continue
        mod = _load(path, f"_mcp_leak_{label}")
        res = mod._denied_result("tu-123")                    # noqa: SLF001
        blob = repr(res)
        inner = _inner_tool_result(res)
        _check(f"{label}: result is an error status",
               inner.get("status") == "error", blob[:160])
        _check(f"{label}: carries the toolUseId back",
               inner.get("toolUseId") == "tu-123", blob[:160])
        for leaky in ("notiops/bedrock-api-key", "get-secret-value", "secretsmanager",
                      "--secret-id", "kms", "alias/"):
            _check(f"{label}: refusal text does not mention {leaky!r}",
                   leaky.lower() not in blob.lower(), blob[:200])
        _check(f"{label}: the message is fixed text, not a template of the input",
               "{" not in mod._DENY_MESSAGE and "%" not in mod._DENY_MESSAGE)  # noqa: SLF001


def test_refusal_is_not_the_outer_envelope() -> None:
    """拒绝结果必须是**内层** ToolResult，不能是外层信封 —— 否则这条拒绝会打死整轮对话。

    这是现网真实踩过的形状 bug，所以单独立一条：`_denied_result()` 曾经 yield
    `{"type": "tool_result", "tool_result": {...}}`。strands 的工具终端只对
    `ToolResultEvent` 短路（`strands/tools/executors/_executor.py`，末行
    `yield ToolResultEvent(cast(ToolResult, last_raw_event))`），裸 dict 会被**整个**
    当成 ToolResult —— 顶层没有 toolUseId / status / content，于是回到对话历史里是一个
    非法的 Bedrock `toolResult` 块，下一次 Converse 直接 ValidationException，前端表现
    为「(no response)」。也就是说：模型没收到"被拒绝"，用户看到的是整轮对话消失。

    判据取"顶层必须自己带 toolUseId / status / content"，而不是"顶层不许有 type 键" ——
    前者对 ToolResultEvent（dict 子类，本身带 `type`）与裸 inner dict 都成立，
    只对外层信封不成立。
    """
    print("test_refusal_is_not_the_outer_envelope")
    for label, path in COPIES:
        if not os.path.exists(path):
            continue
        mod = _load(path, f"_mcp_env_{label}")
        res = mod._denied_result("tu-123")                    # noqa: SLF001
        inner = _inner_tool_result(res)
        _check(f"{label}: the inner ToolResult is reachable",
               inner is not res or isinstance(res, dict), repr(res)[:160])
        for field in ("toolUseId", "status", "content"):
            _check(f"{label}: the ToolResult carries {field} at its top level",
                   field in inner, repr(inner)[:200])
        _check(f"{label}: content is a list of blocks",
               isinstance(inner.get("content"), list) and bool(inner["content"]),
               repr(inner)[:200])
        _check(f"{label}: the refusal text is in the first content block",
               inner["content"][0].get("text") == mod._DENY_MESSAGE,  # noqa: SLF001
               repr(inner)[:200])


def test_check_runs_before_execution() -> None:
    """结构性断言：拦截必须在 super().stream() **之前**。

    事后过滤毫无意义 —— 一旦子进程跑完，密文明文已经拿到了。这条比行为测试更适合守：
    真正调用 stream() 需要 strands + 一个活的 MCP 子进程，而顺序是纯文本可判定的。
    """
    print("test_check_runs_before_execution")
    for label, path in COPIES:
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8").read()
        i = src.find("class _CappedTool")
        body = src[i:] if i >= 0 else ""
        # 必须先剥掉注释行再做位置判断：那段代码的注释里就写着 "在 super().stream() 之前"，
        # 朴素的 find() 会命中注释而不是调用，于是断言测的是注释顺序 —— 第一版就是这么
        # 误报的（代码本身是对的）。
        body = "\n".join(l for l in body.splitlines() if not l.strip().startswith("#"))
        i_deny = body.find("is_denied_command(")
        i_super = body.find("super().stream(")
        _check(f"{label}: both the check and the call exist",
               i_deny >= 0 and i_super >= 0, f"deny={i_deny} super={i_super}")
        if i_deny >= 0 and i_super >= 0:
            _check(f"{label}: the denylist check precedes super().stream()",
                   i_deny < i_super,
                   "post-hoc filtering is pointless: the plaintext is already out")
        _check(f"{label}: a denied command returns without executing",
               "return" in body[i_deny:i_super] if 0 <= i_deny < i_super else False)


def test_subprocess_env_strips_injected_credentials() -> None:
    print("test_subprocess_env_strips_injected_credentials")
    sentinel = "bedrock-key-MUST-NOT-REACH-SUBPROCESS"
    saved = {k: v for k, v in os.environ.items()}
    try:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = sentinel
        os.environ["AWS_BEARER_TOKEN_SOMEFUTURESERVICE"] = sentinel
        os.environ.setdefault("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
        os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/EXAMPLEKEY")
        os.environ.setdefault("AWS_SESSION_TOKEN", "FwoGZXIvYXdzEXAMPLE")

        for label, path in ENV_COPIES:
            if not os.path.exists(path):
                _check(f"{label}: file present", False, path)
                continue
            mod = _load(path, f"_mcpenv_{label.replace('/', '_')}")
            env = mod._server_env()                            # noqa: SLF001
            _check(f"{label}: AWS_BEARER_TOKEN_BEDROCK is stripped",
                   "AWS_BEARER_TOKEN_BEDROCK" not in env)
            _check(f"{label}: any AWS_BEARER_TOKEN_* is stripped (prefix rule)",
                   not [k for k in env if k.upper().startswith("AWS_BEARER_TOKEN_")],
                   str([k for k in env if k.upper().startswith("AWS_BEARER_TOKEN_")]))
            _check(f"{label}: the sentinel appears nowhere in the child env",
                   sentinel not in "".join(str(v) for v in env.values()))
            # 反面：任务角色凭证**必须**保留，子进程要靠它们调 AWS
            for keep in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
                _check(f"{label}: {keep} is preserved", keep in env,
                       "stripping this would break the subprocess entirely")
            _check(f"{label}: read-only guard still set",
                   env.get("READ_OPERATIONS_ONLY", "true") == "true"
                   or "READ_OPERATIONS_ONLY" not in env)
    finally:
        os.environ.clear()
        os.environ.update(saved)


def test_header_no_longer_overclaims() -> None:
    """文件头曾声称有第三重防线而代码里没有。补齐后，说明也必须与实现一致。"""
    print("test_header_no_longer_overclaims")
    for label, path in COPIES:
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8").read()
        header = src[:src.find("from __future__")] if "from __future__" in src else src[:4000]
        _check(f"{label}: the header names the actual implementation",
               "is_denied_command" in header,
               "the header should point at the code that implements the claim")
        _check(f"{label}: the header states this is defence-in-depth, not a boundary",
               "IAM" in header)
        _check(f"{label}: the header documents the credential stripping",
               "AWS_BEARER_TOKEN" in header)


def main() -> int:
    test_denylist_decisions()
    test_command_position_parsing()
    test_operator_can_extend_but_not_shrink()
    test_ssm_only_denied_with_decryption()
    test_refusal_leaks_nothing()
    test_refusal_is_not_the_outer_envelope()
    test_check_runs_before_execution()
    test_subprocess_env_strips_injected_credentials()
    test_header_no_longer_overclaims()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
