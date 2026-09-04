#!/usr/bin/env python3
"""The IAM grants the model-catalogue feature needs, asserted against the CDK source.

Why this exists: nothing else in the repo notices a missing grant, and its failure
mode is a silent degradation rather than an error. (`infra/**` had no CI job at all
when this suite was written; since 2026-08-22 the `infra-tests` job does run `tsc`
plus template assertions — but those check the template's *shape*, not whether a
particular grant is still there. A grant that quietly disappears still needs this.)

  * no `bedrock:ListFoundationModels` → `apiGetCandidates` swallows AccessDenied
    and returns only the 3 hardcoded Mantle entries plus a warning, so an admin
    cannot add any Bedrock model to the catalogue;
  * `bedrock:InvokeModel` narrowed to `anthropic.claude-*` → the connectivity
    probe returns `forbidden` for Nova / DeepSeek → `probeDefaultModel` hard-fails
    the save (`forbidden` is in `HARD_FAIL_PROBE_RESULTS`) → **no non-Claude model
    can ever become the default**. (This used to be phrased as "the UI never sets
    `verified`, so `validateConfig` refuses an unverified default". Both the field
    and that gate are gone; the grant still matters, only the mechanism changed.);
  * no access to `notiops/bedrock-api-key` → `keyStatus()` reports "not
    configured" even when a key exists, and `apiPutBedrockKey` throws
    AccessDenied (not ResourceNotFoundException, so it is not caught) → HTTP 500
    on the API-key page;
  * no `CONFIG_TABLE` env / `dynamodb:GetItem` for the PHD Lambda → it silently
    keeps using the env `MODEL_ID`, ignoring whatever the admin bound.

These are **source-level** assertions, not a synthesised template: `cdk synth`
needs Node deps and credentials, which this suite deliberately avoids. That makes
them a floor, not a proof — a refactor that moves a grant elsewhere could pass
here. The comments say what each one is standing in for.

Run: PYTHONPATH=. python3 scripts/test_llm_iam_grants.py
"""
from __future__ import annotations

import os
import re
import sys

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Web Chat 侧的资源与授权定义在 2026-08-22 的重构里从 `web-chat-stack.ts` 搬进了
# `constructs/web-chat-core.ts`（一键部署的 standalone 单栈要复用同一份定义）。
# 这里读**这些文件的拼接**而不是钉住其中一个：
# 钉住单个文件的话，下一次搬家会让本套件里所有 BFF 断言一起变红（还算好），或者更糟 ——
# 如果断言写成 "不出现某个宽授权" 就会静默地空转通过。缺文件在 main() 里直接判失败。
WEBCHAT_SOURCES = [
    os.path.join(ROOT, "infra", "lib", "web-chat-stack.ts"),
    os.path.join(ROOT, "infra", "lib", "constructs", "web-chat-core.ts"),
]
BACKEND_STACK = os.path.join(ROOT, "infra", "lib", "notiops-backend-stack.ts")


def _check(name: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {name}")
    else:
        _failed += 1
        print(f"  {FAIL} {name}" + (f" :: {detail}" if detail else ""))


def _read(path: str) -> str:
    return open(path, encoding="utf-8").read()


def _read_webchat() -> str:
    """WebChatStack + 它的 core 构件源码拼接（顺序无关，断言都是「文本里有没有」）。"""
    return "\n".join(_read(p) for p in WEBCHAT_SOURCES if os.path.exists(p))


def _statement(src: str, sid: str) -> str:
    """The text of the PolicyStatement carrying this sid (up to the closing brace)."""
    i = src.find(f'sid: "{sid}"')
    if i < 0:
        return ""
    # 往回找到 new iam.PolicyStatement({，往后找到匹配的 }) —— 粗略但够用
    start = src.rfind("new iam.PolicyStatement({", 0, i)
    end = src.find("}),", i)
    return src[start:end] if start >= 0 and end > i else src[max(0, i - 400):i + 600]


def test_bff_can_enumerate_models() -> None:
    print("test_bff_can_enumerate_models")
    src = _read_webchat()
    st = _statement(src, "BedrockListFoundationModels")
    _check("the BFF has a ListFoundationModels statement", bool(st))
    _check("it grants bedrock:ListFoundationModels",
           "bedrock:ListFoundationModels" in st)
    # ListFoundationModels 不支持资源级限定，只能是 "*"。写死这一点，免得有人
    # 好心去收窄成一个 ARN，然后 apiGetCandidates 静默退化成只有 Mantle。
    _check("its resource is \"*\" (the API has no resource-level scoping)",
           re.search(r'resources:\s*\["\*"\]', st) is not None, st[-200:])


def test_connectivity_probe_is_not_limited_to_claude() -> None:
    print("test_connectivity_probe_is_not_limited_to_claude")
    src = _read_webchat()
    st = _statement(src, "BedrockInferenceAndConnectivityProbe")
    _check("the BFF has a Bedrock inference statement", bool(st))
    _check("it allows any foundation model",
           "arn:aws:bedrock:*::foundation-model/*" in st, st[-260:])
    # 这是本条断言的重点：收窄回 anthropic.claude-* 会让非 Claude 模型永远
    # 无法通过连通性测试，也就永远无法成为默认模型。
    _check("it is NOT narrowed back to anthropic.claude-*",
           "foundation-model/anthropic.claude-*" not in st,
           "narrowing this breaks verification for every non-Claude model")
    _check("inference profiles are covered too",
           "inference-profile/*" in st)


def test_bff_can_read_and_write_the_bedrock_api_key() -> None:
    print("test_bff_can_read_and_write_the_bedrock_api_key")
    src = _read_webchat()
    st = _statement(src, "BedrockApiKeySecretAccess")
    _check("the BFF has a bedrock-api-key secret statement", bool(st))
    for action in ("secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
                   "secretsmanager:UpdateSecret", "secretsmanager:CreateSecret"):
        _check(f"it grants {action}", action in st)
    _check("it is scoped to notiops/bedrock-api-key* by name",
           "secret:notiops/bedrock-api-key*" in st, st[-260:])
    # 不该顺手放开整个 Secrets Manager
    _check("it does not grant secret:* ",
           not re.search(r'secret:\*"', st), st[-260:])


def test_bff_can_read_the_config_table() -> None:
    print("test_bff_can_read_the_config_table")
    src = _read_webchat()
    _check("the config table is granted to the BFF",
           "table.grantReadWriteData(bff)" in src or "grantReadWriteData(bff)" in src)


def test_phd_lambda_can_read_its_binding() -> None:
    print("test_phd_lambda_can_read_its_binding")
    src = _read(BACKEND_STACK)
    _check("phdLambda gets CONFIG_TABLE in its environment",
           re.search(r"CONFIG_TABLE:\s*configTable\.tableName", src) is not None)
    # `shared/phd_config.py` 在缺 CONFIG_TABLE 时会直接跳过 DDB（安全降级到 env），
    # 所以少这条不会报错 —— 只是管理员绑定的模型永远不生效。
    _check("phdLambda is granted read access to the config table",
           "configTable.grantReadData(phdLambda)" in src)


def test_global_cris_regionless_arn_is_granted() -> None:
    """Global CRIS 需要一个 region 段为空的 foundation-model ARN。

    目录里的 Claude 条目全部使用 `global.*` inference profile（2026-07 决策）。Global CRIS
    在授权时呈现的**不是**带 region 的 ARN，而是 `arn:aws:bedrock:::foundation-model/<model>`
    配合 `aws:RequestedRegion == "unspecified"`。
    现有的 `arn:aws:bedrock:*::foundation-model/*` 里那个 `*` 理论上能匹配空段（IAM 通配符
    匹配零个或多个字符），但这条判断错的后果是**生产环境全部 Bedrock 调用 AccessDenied**，
    所以每处都显式写出。这条断言防止有人"清理重复项"时把它删掉。
    见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
    """
    print("test_global_cris_regionless_arn_is_granted")
    REGIONLESS = "arn:aws:bedrock:::foundation-model/"
    targets = [
        ("BFF (web-chat-core)", None),  # None = WEBCHAT_SOURCES 的拼接
        ("shared lambda role + PHD (notiops-backend-stack)", BACKEND_STACK),
        ("AgentCore runtime (agentcore cdk)", os.path.join(
            ROOT, "agent-build", "NotiOpsWebChat", "agentcore", "cdk", "lib", "cdk-stack.ts")),
    ]
    for label, path in targets:
        if path is None:
            src = _read_webchat()
        elif not os.path.exists(path):
            _check(f"{label}: file present", False, path)
            continue
        else:
            src = _read(path)
        _check(f"{label}: grants the Region-less foundation-model ARN",
               REGIONLESS in src,
               "global.* inference profiles will fail with AccessDenied without it")

    # notiops-backend-stack 有两条独立的 Bedrock 语句（共享 lambdaRole 与 phdLambda），
    # 两条都得有 —— 只补一条的话另一个执行角色照样挂。
    _check("notiops-backend-stack covers BOTH Bedrock statements",
           _read(BACKEND_STACK).count(REGIONLESS) >= 2,
           f"found {_read(BACKEND_STACK).count(REGIONLESS)} occurrence(s), need 2")

    # IM(ECS) 的三个角色用的是 resources:["*"]，天然覆盖 —— 断言它没被"收紧"成
    # 带 region 的 ARN 而漏掉 Region-less 形式。
    bot = os.path.join(ROOT, "infra", "lib", "bot-stack.ts")
    if os.path.exists(bot):
        src = _read(bot)
        narrowed = ("arn:aws:bedrock:*::foundation-model" in src
                    and REGIONLESS not in src)
        _check("bot-stack (IM) is either wildcard-scoped or has the Region-less ARN",
               not narrowed,
               "bot-stack narrowed its Bedrock resources but omitted the Region-less ARN")


def test_key_consumers_can_read_the_secret() -> None:
    """每个消费 Bedrock API Key 的执行角色都必须能读那个 Secret。

    失败模式是**静默的**，这正是需要源码级断言的原因：`get_bedrock_api_key()` 读 Secret 被拒
    时会记一条 warning 然后返回 None → 回退 IAM 角色 → 对话照常。于是「Admin 配了 Key 但
    Key 从不生效」，UI 上没有任何异常，日志也只有一行 warning。少给一个角色授权，就少一个
    端生效，而三端的表现完全一样。

    只断言**读**：Key 的唯一写入方是 BFF（web-chat-stack），见 的收敛。
    """
    print("test_key_consumers_can_read_the_secret")
    SECRET = "secret:notiops/bedrock-api-key"
    GET = "secretsmanager:GetSecretValue"
    targets = [
        # webchat runtime：model/load.py::_build_bedrock_model 注入前要读它
        ("AgentCore runtime (agentcore cdk)", os.path.join(
            ROOT, "agent-build", "NotiOpsWebChat", "agentcore", "cdk", "lib", "cdk-stack.ts"), 1),
        # IM：三个 ECS 任务角色（feishu / slack / dingtalk）各需一条
        ("IM ECS task roles (bot-stack)", os.path.join(
            ROOT, "infra", "lib", "bot-stack.ts"), 3),
        # 后端 Lambda：shared/llm_provider.py 等已在消费
        ("backend lambda role (notiops-backend-stack)", BACKEND_STACK, 1),
    ]
    # 两种写法都算：字面 ARN（跨栈时按名引用，避免 CFN export 耦合）与 CDK 对象引用
    # `bedrockApiKeySecret.secretArn`（同栈内创建时的首选，类型安全）。
    OBJ_REF = "bedrockApiKeySecret.secretArn"
    for label, path, want in targets:
        if not os.path.exists(path):
            _check(f"{label}: file present", False, path)
            continue
        src = _read(path)
        n = src.count(SECRET) + src.count(OBJ_REF)
        _check(f"{label}: can read the Bedrock API Key secret (x{want})",
               n >= want,
               f"found {n} reference(s) to the key secret, need {want} — that end will "
               f"silently fall back to IAM and the key will never take effect")
        _check(f"{label}: uses GetSecretValue", GET in src)

    # 反向：runtime 与 ECS 角色**不得**持写权限（写入方只有 BFF）。
    for label, path in (("AgentCore runtime", os.path.join(
                            ROOT, "agent-build", "NotiOpsWebChat", "agentcore",
                            "cdk", "lib", "cdk-stack.ts")),
                        ("IM ECS task roles", os.path.join(
                            ROOT, "infra", "lib", "bot-stack.ts"))):
        if not os.path.exists(path):
            continue
        src = _read(path)
        _check(f"{label}: does NOT get PutSecretValue (single writer = BFF)",
               "secretsmanager:PutSecretValue" not in src,
               "a second writer would race the webchat admin page")


def test_config_table_has_pitr() -> None:
    """notiops-config 必须开 PITR。

    这张表现在是五个独立部署单元的配置真源。`RemovalPolicy.RETAIN` 只防栈删除时丢表，
    防不住一次写坏 —— 而模型目录的写入路径包含整份 PUT 与回滚。llmcfg#audit 里的变更前
    快照只覆盖模型目录这一个 PK，且快照自己也存在同一张表里，所以 PITR 是唯一的表级
    恢复手段。
    """
    print("test_config_table_has_pitr")
    src = _read(BACKEND_STACK)
    i = src.find('tableName: "notiops-config"')
    _check("the config table is defined", i >= 0)
    if i < 0:
        return
    # 取该 Table 构造块（到下一个 `});`）
    end = src.find("});", i)
    block = src[max(0, i - 300):end if end > i else i + 900]
    _check("point-in-time recovery is enabled on notiops-config",
           "pointInTimeRecoveryEnabled: true" in block, block[-300:])
    # 旧的 `pointInTimeRecovery: true` 在 aws-cdk-lib 2.243 已废弃
    _check("it uses the non-deprecated Specification form",
           "pointInTimeRecoverySpecification" in block)
    _check("the table is still RETAIN on stack deletion",
           "RemovalPolicy.RETAIN" in block, "PITR does not replace RETAIN")


def test_grants_are_documented_where_they_are_easy_to_narrow() -> None:
    """每条宽授权都要留下「为什么不能再收窄」的理由。

    这三条里两条看起来都像可以收紧的（`*` 资源、任意 foundation-model），下一个读到
    的人很容易好心改掉，而后果是静默降级、不报错。把理由留在代码里是唯一的拦阻手段。

    断言语言无关：只要求 sid 之前紧邻一段有实质长度的 `//` 注释块，不匹配具体措辞
    （也避免在本脚本里内联中文检索词 —— scripts/lint_i18n.py 会拦）。
    """
    print("test_grants_are_documented_where_they_are_easy_to_narrow")
    src = _read_webchat()
    for sid in ("BedrockListFoundationModels",
                "BedrockInferenceAndConnectivityProbe",
                "BedrockApiKeySecretAccess"):
        i = src.find(f'sid: "{sid}"')
        if i < 0:
            _check(f"{sid} carries a rationale comment", False, "statement not found")
            continue
        # 从 sid 往回，跨过 `new iam.PolicyStatement({` / `bff.addToRolePolicy(`，
        # 收集紧邻其上的连续注释行。
        lines = src[:i].splitlines()
        comment_lines = 0
        for ln in reversed(lines):
            t = ln.strip()
            if t.startswith("//"):
                comment_lines += 1
                continue
            if t in ("", "bff.addToRolePolicy(", "new iam.PolicyStatement({"):
                continue
            break
        _check(f"{sid} carries a rationale comment of >= 3 lines",
               comment_lines >= 3, f"found {comment_lines} comment line(s)")


def main() -> int:
    missing = [p for p in WEBCHAT_SOURCES if not os.path.exists(p)]
    if missing:
        # 不降级为「跳过」：文件搬走后本套件必须红，而不是静默少断言。
        for p in missing:
            print(f"{FAIL} {p} not found")
        return 1
    test_bff_can_enumerate_models()
    test_connectivity_probe_is_not_limited_to_claude()
    test_bff_can_read_and_write_the_bedrock_api_key()
    test_bff_can_read_the_config_table()
    test_phd_lambda_can_read_its_binding()
    test_global_cris_regionless_arn_is_granted()
    test_key_consumers_can_read_the_secret()
    test_config_table_has_pitr()
    test_grants_are_documented_where_they_are_easy_to_narrow()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
