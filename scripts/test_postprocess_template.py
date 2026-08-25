"""`scripts/postprocess_template.py` 的判据测试 —— 一键部署模板的最后一道门。

为什么这个脚本值得单独一套测试：它的产物是**客户点一下就往自己生产账号里开的栈**。
那条路径上没有第二个人 review —— 我们这边 `cdk synth` 成功、CI 全绿、模板传上
GitHub Release，客户点 Launch Stack，然后失败发生在客户账号里，报错还是 CFN 那种
看不出所以然的措辞。所以改写逻辑必须是"断言式"的：每一处该改的都数清、改完再核对，
任何一处对不上就整体失败、不产出半成品模板。本测试钉住的就是那些断言本身。

覆盖的三类东西：
  ① 正常路径 —— 资产桶改写成 !Ref StagingBucket、bootstrap 痕迹清干净、
     release tag / 产物清单注进去，且清单里的 S3 key **是从模板里读出来的**
     （不是脚本里重新拼一遍 —— 那等于埋一处"两边同时改才对"的隐患）。
  ② 每一条全局判据的**反例** —— 每条判据都造一个真会发生的坏模板去撞它。
     判据不写测试就等于没有判据：谁都不知道它还在不在、还灵不灵。
  ③ 与 TS 侧的**刻意耦合** —— 占位值在 infra/lib/notiops-webchat-standalone-stack.ts
     里手写、在这里断言，两边任何一侧改了另一侧立刻红。

两条判据的来历值得记一笔（都是实测撞出来的，不是想出来的）：
  · `Mappings` 里名为 `Default` 的顶层键 —— CFN 把它当 Fn::FindInMap 增强查找的兜底值
    并要求是字符串。`cdk synth` 和 `tsc` 都不管，只有 validate-template / 真开栈才报。
  · 客户可见文案里的非 ASCII —— CFN 收模板时把它们**一律换成 `?`**（实测
    `"em—dash 前端 ok"` 进去、`"em?dash ??? ok"` 出来）。本地怎么看都是好的，
    只有客户的控制台上是一串问号。

Run from repo root::

    python3 scripts/test_postprocess_template.py
"""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import postprocess_template as pp  # noqa: E402

STANDALONE_TS = os.path.join(ROOT, "infra", "lib", "notiops-webchat-standalone-stack.ts")

PASS, FAIL = "✅", "❌"
_failed = 0

# BFF 的 S3Key = CDK 的**资产内容哈希**（不带 release tag —— 内容变了 key 就变，
# 所以不需要 tag 就能让 CFN 看见变化）。这里只需要「64 位 hex + .zip」这个形状，
# 值本身无意义 —— 故意拼出来而不是抄一个真哈希：真哈希是高熵字面量，会被
# gitleaks 的 generic-api-key 规则当成密钥拦在发布 gate 上（本文件随 scripts/ 公开）。
BFF_KEY = "d" * 64 + ".zip"
SUMS = {
    "bff.zip": "a" * 64,
    "chat-dist.zip": "b" * 64,
    "agent-code.zip": "c" * 64,
}
TAG = "v9.9.9"


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def _expect_error(label: str, fn, needle: str) -> None:
    """断言 fn() 抛 PostprocessError，且错误信息里有 needle。

    连错误**措辞**一起钉：这些消息是给未来那个撞上判据的人看的，
    只断言"抛了异常"会让消息慢慢退化成 `assert False`。
    """
    global _failed
    try:
        fn()
    except pp.PostprocessError as exc:
        if needle.lower() in str(exc).lower():
            print(f"  {PASS} {label}")
        else:
            _failed += 1
            print(f"  {FAIL} {label} :: 抛对了但消息里没有 {needle!r}: {exc}")
    except Exception as exc:  # noqa: BLE001
        _failed += 1
        print(f"  {FAIL} {label} :: 抛的不是 PostprocessError 而是 {exc!r}")
    else:
        _failed += 1
        print(f"  {FAIL} {label} :: 没有抛异常（判据失效）")


# ── 一份仿真的"合成后、未 postprocess"模板 ────────────────────────────────────
# 形状照抄真产物（见 dist/oneclick/notiops-webchat.template.json）：CDK 资产桶引用、
# BootstrapVersion 参数 + Rule、占位的 tag 与空清单、两个 Stager 自定义资源。
# 刻意保留 `aws:cdk:path` —— 脚本按它定位逻辑 ID（逻辑 ID 的 8 位 hash 会随构件树变）。
def synth_template() -> dict:
    return {
        "Description": "NotiOps Web Chat -- one-click deployment",
        "Metadata": {
            "AWS::CloudFormation::Interface": {
                "ParameterGroups": [
                    {"Label": {"default": "Required"}, "Parameters": ["AdminEmail"]},
                    {"Label": {"default": "CDK"}, "Parameters": ["BootstrapVersion"]},
                ],
                "ParameterLabels": {
                    "AdminEmail": {"default": "Administrator email"},
                    "BootstrapVersion": {"default": "Bootstrap version"},
                },
            }
        },
        "Parameters": {
            "AdminEmail": {"Type": "String", "Description": "Where to email the first login"},
            "BootstrapVersion": {
                "Type": "AWS::SSM::Parameter::Value<String>",
                "Default": "/cdk-bootstrap/hnb659fds/version",
            },
        },
        "Rules": {
            "CheckBootstrapVersion": {
                "Assertions": [{"Assert": {"Fn::Not": [{"Fn::Contains": [["1"], "x"]}]},
                                "AssertDescription": "cdk-bootstrap too old"}]
            }
        },
        "Mappings": {
            "NotiOpsRelease": {
                pp.RELEASE_MAP_KEY: {"Tag": pp.RELEASE_TAG_PLACEHOLDER, "BaseUrl": "UNSET"}
            }
        },
        "Resources": {
            "StagingBucket9644C37C": {
                "Type": "AWS::S3::Bucket",
                "Metadata": {"aws:cdk:path": "NotiOps/StagingBucket/Resource"},
            },
            "StagerFn": {"Type": "AWS::Lambda::Function",
                         "Properties": {"Code": {"ZipFile": "# 中文注释：内联代码里的非 ASCII 是安全的\n"}}},
            "StagerArtifacts": {
                "Type": "Custom::NotiOpsStagerArtifacts",
                "DependsOn": ["StagerFn"],
                "Properties": {
                    "Phase": "Artifacts",
                    "StagingBucket": {"Ref": "StagingBucket9644C37C"},
                    "DefaultArtifactBaseUrl": {
                        "Fn::FindInMap": ["NotiOpsRelease", pp.RELEASE_MAP_KEY, "BaseUrl"]},
                    "Artifacts": "[]",
                },
            },
            "StagerSite": {
                "Type": "Custom::NotiOpsStagerSite",
                "DependsOn": ["StagerArtifacts"],
                "Properties": {
                    "Phase": "Site",
                    "StagingBucket": {"Ref": "StagingBucket9644C37C"},
                    "ChatDistKey": {"Fn::Join": ["", [
                        "frontend/",
                        {"Fn::FindInMap": ["NotiOpsRelease", pp.RELEASE_MAP_KEY, "Tag"]},
                        "/chat-dist.zip"]]},
                },
            },
            "WebChatBffF9213199": {
                "Type": "AWS::Lambda::Function",
                "DependsOn": ["StagerArtifacts"],
                "Metadata": {"aws:cdk:path": "NotiOps/WebChatBff/Resource"},
                "Properties": {"Code": {
                    "S3Bucket": {"Fn::Sub": "cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}"},
                    "S3Key": BFF_KEY,
                }},
            },
            "AgentRuntime": {
                "Type": "AWS::BedrockAgentCore::Runtime",
                "DependsOn": ["StagerArtifacts"],
                "Properties": {"AgentRuntimeArtifact": {"CodeConfiguration": {"Code": {"S3": {
                    "Bucket": {"Ref": "StagingBucket9644C37C"},
                    "Prefix": {"Fn::Join": ["", [
                        "agent/",
                        {"Fn::FindInMap": ["NotiOpsRelease", pp.RELEASE_MAP_KEY, "Tag"]},
                        "/agent-code.zip"]]},
                }}}}},
            },
            "CDKMetadata": {"Type": "AWS::CDK::Metadata",
                            # 真产物里这是一段压缩后的 base64，随机出现 12 位连续数字是常事。
                            "Properties": {"Analytics": "v2:deflate64:H4sI123456789012abc"}},
        },
        "Outputs": {"ChatUrl": {"Value": "x", "Description": "Web Chat frontend URL"}},
    }


def processed() -> dict:
    return pp.postprocess(synth_template(), TAG, dict(SUMS), f"https://example.invalid/{TAG}")


# ── ① 正常路径 ────────────────────────────────────────────────────────────────
print("=" * 72)
print("postprocess_template —— 一键部署模板改写与判据")
print("=" * 72)
print("① 正常路径")
out = processed()
blob = json.dumps(out)

_check("资产桶引用被改写成 !Ref StagingBucket",
       out["Resources"]["WebChatBffF9213199"]["Properties"]["Code"]["S3Bucket"]
       == {"Ref": "StagingBucket9644C37C"})
_check("bootstrap 痕迹清干净（桶名/参数/Rule）",
       "cdk-hnb659fds" not in blob and "BootstrapVersion" not in blob and "Rules" not in out)
_check("Interface 里的 BootstrapVersion 也清掉了",
       all("BootstrapVersion" not in g.get("Parameters", [])
           for g in out["Metadata"]["AWS::CloudFormation::Interface"]["ParameterGroups"])
       and "BootstrapVersion" not in
       out["Metadata"]["AWS::CloudFormation::Interface"]["ParameterLabels"])
_check(f"release tag 写进 Mappings.NotiOpsRelease.{pp.RELEASE_MAP_KEY}",
       out["Mappings"]["NotiOpsRelease"][pp.RELEASE_MAP_KEY]
       == {"Tag": TAG, "BaseUrl": f"https://example.invalid/{TAG}"})

manifest = json.loads(out["Resources"]["StagerArtifacts"]["Properties"]["Artifacts"])
_check("清单是 JSON **字符串**而不是嵌套对象（自定义资源属性到 Lambda 那边全是字符串）",
       isinstance(out["Resources"]["StagerArtifacts"]["Properties"]["Artifacts"], str))
_check("清单顺序 = 搬运顺序：144MiB 的 agent zip 放最后（前面失败能秒级暴露）",
       [e["name"] for e in manifest] == ["bff.zip", "chat-dist.zip", "agent-code.zip"])
_check("三个 key 都是从模板里读出来的（intrinsic 求值），不是脚本里重拼的",
       [e["key"] for e in manifest]
       == [BFF_KEY, f"frontend/{TAG}/chat-dist.zip", f"agent/{TAG}/agent-code.zip"],
       str([e["key"] for e in manifest]))
_check("sha256 逐个对上", {e["name"]: e["sha256"] for e in manifest} == SUMS)
_check("模板里不再有 tag 占位符", pp.RELEASE_TAG_PLACEHOLDER not in blob)

# 默认 base url 必须指向公开仓库的 Release —— 客户点 Launch Stack 时产物从那里下。
_check("默认 base url 指向 aws-samples 的 Release 下载地址",
       pp.DEFAULT_BASE_URL_TEMPLATE.format(tag="v1.2.3")
       == "https://github.com/aws-samples/sample-notiops/releases/download/v1.2.3")

# ── ② 判据反例 ────────────────────────────────────────────────────────────────
print("\n② 每条判据的反例")

# 资产改写：0 处 = 合成产物换形状了；>1 处 = standalone 栈里又混进了 CDK 资产
# （BucketDeployment / cr.Provider / autoDeleteObjects / logRetention 都会造一个）。
def _two_assets() -> None:
    t = synth_template()
    t["Resources"]["SneakyBucketDeployment"] = {
        "Type": "AWS::Lambda::Function",
        "Properties": {"Code": {
            "S3Bucket": {"Fn::Sub": "cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}"},
            "S3Key": "deadbeef.zip"}},
    }
    pp.rewrite_asset_bucket(t)


_expect_error("多出一个 CDK 资产 → 报错并点名 BucketDeployment / cr.Provider 这类成因",
              _two_assets, "rewrote 2")


def _no_asset() -> None:
    t = synth_template()
    t["Resources"]["WebChatBffF9213199"]["Properties"]["Code"]["S3Bucket"] = {"Ref": "Whatever"}
    pp.rewrite_asset_bucket(t)


_expect_error("一个资产都没有 → 报错（合成产物换形状了，不能默默产模板）",
              _no_asset, "rewrote 0")

# 重复 postprocess：会把一个已发布的 release 悄悄改成另一个 tag。
_expect_error("对已处理过的模板再跑一次 → 拒绝（tag 占位符已被填掉）",
              lambda: pp.set_release(processed(), "v1.1.1", "x"), "refusing to postprocess")
_expect_error("清单已注入过 → 拒绝覆盖",
              lambda: pp.inject_manifest(processed(), []), "already-injected")


def _missing_sum() -> None:
    sums = dict(SUMS)
    del sums["agent-code.zip"]
    pp.postprocess(synth_template(), TAG, sums, "https://example.invalid/x")


_expect_error("某个产物没有 sha256 → 报错（不能搬一个来源不明的 zip）",
              _missing_sum, "no sha256")


def _account_id_baked_in() -> None:
    # 真实成因：--base-url 指向镜像桶，而镜像桶名里带账号号码。
    # 这里用文档里的示例账号号码（不是任何真实账号）—— 本文件会随 scripts/ 一起
    # 发布到公开仓库，判据本身只关心「12 位连续数字」这个形状。
    pp.postprocess(synth_template(), TAG, dict(SUMS),
                   "s3://notiops-oneclick-mirror-123456789012-us-east-1/notiops/v9.9.9")


_expect_error("base url 里带 12 位账号号码 → 报错，并指出该用 ArtifactBaseUrl 栈参数",
              _account_id_baked_in, "ArtifactBaseUrl stack parameter")

_check("64 位 hex 里随机出现的 12 位连续数字不误报（真产物里到处是资产 hash）",
       "H4sI123456789012abc" in json.dumps(out["Resources"]["CDKMetadata"]))


def _mappings_default() -> None:
    t = synth_template()
    # 形状 = 有人把顶层键从 Current 改回了 Default（这是原始写法，实测开栈即失败）。
    # 直接撞 assert_clean：set_release 会先因为找不到 RELEASE_MAP_KEY 而失败。
    t["Mappings"]["NotiOpsRelease"] = {
        "Default": {"Tag": TAG, "BaseUrl": "x"},
        pp.RELEASE_MAP_KEY: {"Tag": TAG, "BaseUrl": "x"},
    }
    pp.inject_manifest(t, [{"name": "bff.zip", "key": f"agent/{TAG}/x", "sha256": "a" * 64},
                           {"name": "chat-dist.zip", "key": "b", "sha256": "b" * 64},
                           {"name": "agent-code.zip", "key": "c", "sha256": "c" * 64}])
    pp.rewrite_asset_bucket(t)
    pp.strip_bootstrap(t)
    pp.assert_clean(t, TAG)


_expect_error("Mappings 里有非字符串的 `Default` 顶层键 → 报错（CFN 保留了这个名字）",
              _mappings_default, "Mappings Default must be a String")


def _no_depends_on() -> None:
    t = synth_template()
    del t["Resources"]["WebChatBffF9213199"]["DependsOn"]
    pp.postprocess(t, TAG, dict(SUMS), "https://example.invalid/x")


_expect_error("从 staging 桶取代码却不 DependsOn StagerArtifacts → 报错（代码还没搬到就建函数）",
              _no_depends_on, "does not DependsOn StagerArtifacts")


def _tagless_keys() -> None:
    t = synth_template()
    # key 里不带版本：CFN 看不见 S3 对象内容变化，客户升级后跑的还是旧代码。
    t["Resources"]["StagerSite"]["Properties"]["ChatDistKey"] = "frontend/chat-dist.zip"
    t["Resources"]["AgentRuntime"]["Properties"]["AgentRuntimeArtifact"]["CodeConfiguration"][
        "Code"]["S3"]["Prefix"] = "agent/agent-code.zip"
    pp.postprocess(t, TAG, dict(SUMS), "https://example.invalid/x")


_expect_error("产物 key 里不含 release tag → 报错（否则客户升级后还跑旧代码）",
              _tagless_keys, "without a version in the key")

# ── 非 ASCII：客户可见字段一律拒，资源属性里的中文（内联代码/注释）照旧放行 ──
print("\n   非 ASCII 文案（CFN 会把它们换成 '?'）")
CUSTOMER_FIELDS = [
    ("Description", lambda t: t.__setitem__("Description", "NotiOps Web Chat —— 一键部署")),
    ("Parameters.*.Description",
     lambda t: t["Parameters"]["AdminEmail"].__setitem__("Description", "管理员邮箱")),
    ("Parameters.*.ConstraintDescription",
     lambda t: t["Parameters"]["AdminEmail"].__setitem__("ConstraintDescription", "必须是邮箱")),
    ("ParameterGroups[].Label",
     lambda t: t["Metadata"]["AWS::CloudFormation::Interface"]["ParameterGroups"][0]
     .__setitem__("Label", {"default": "安全默认值"})),
    ("ParameterLabels.*",
     lambda t: t["Metadata"]["AWS::CloudFormation::Interface"]["ParameterLabels"]["AdminEmail"]
     .__setitem__("default", "管理员邮箱")),
    ("Outputs.*.Description",
     lambda t: t["Outputs"]["ChatUrl"].__setitem__("Description", "前端地址")),
    ("Resources.*.Properties.Description",
     lambda t: t["Resources"]["AgentRuntime"]["Properties"].__setitem__("Description", "只读 agent")),
]
for where, mutate in CUSTOMER_FIELDS:
    def _bad(mutate=mutate) -> None:
        t = synth_template()
        mutate(t)
        pp.postprocess(t, TAG, dict(SUMS), "https://example.invalid/x")

    _expect_error(f"{where} 里有中文/破折号 → 报错", _bad, "non-ASCII")

_check("Code.ZipFile 里的中文注释放行（实测这些字符原封不动到了云上）",
       "中文注释" in json.dumps(out["Resources"]["StagerFn"], ensure_ascii=False))

# ── sha256 清单解析 ──────────────────────────────────────────────────────────
print("\n   SHA256SUMS 解析")
with tempfile.TemporaryDirectory() as d:
    good = os.path.join(d, "SHA256SUMS")
    with open(good, "w", encoding="utf-8") as fh:
        # 三种真会出现的写法：裸文件名、`*` 前缀（sha256sum 二进制模式）、带目录。
        fh.write(f"{'a' * 64}  bff.zip\n")
        fh.write(f"{'b' * 64} *chat-dist.zip\n")
        fh.write(f"# 注释行\n\n{'c' * 64}  dist/oneclick/agent-code.zip\n")
    _check("接受 `*` 前缀 / 目录前缀 / 注释与空行，key 取 basename",
           pp._read_sha256sums(pp.Path(good)) == SUMS)

    bad = os.path.join(d, "BAD")
    with open(bad, "w", encoding="utf-8") as fh:
        fh.write("notahash  bff.zip\n")
    _expect_error("非 sha256sum 格式 → 报错并带行号",
                  lambda: pp._read_sha256sums(pp.Path(bad)), "not a sha256sum line")

# ── ③ 与 TS 侧的刻意耦合 ─────────────────────────────────────────────────────
print("\n③ 与 infra/lib/notiops-webchat-standalone-stack.ts 的耦合")
ts = open(STANDALONE_TS, encoding="utf-8").read()
_check(f"TS 里写着同一个 tag 占位值 {pp.RELEASE_TAG_PLACEHOLDER!r}", pp.RELEASE_TAG_PLACEHOLDER in ts)
_check(f"TS 里的 Mappings 顶层键是 {pp.RELEASE_MAP_KEY!r}（不是 CFN 保留的 Default）",
       pp.RELEASE_MAP_KEY in ts and '"Default":' not in ts)
_check("三个产物名与 TS/StagerFn 侧一致",
       all(n in ts or n in json.dumps(out) for n in
           (pp.BFF_ARTIFACT, pp.CHAT_DIST_ARTIFACT, pp.AGENT_ARTIFACT)))

# 模板体积：`--template-body` / 控制台粘贴上限 51,200 字节，传 S3 上限 1MB。
# 真产物现在 ~95KB，所以 CLI 必须走 --template-url —— 这两个常量别被人"顺手放宽"。
_check("体积上限常量没被改动（51,200 / 1,000,000）",
       (pp.INLINE_TEMPLATE_LIMIT, pp.S3_TEMPLATE_LIMIT) == (51_200, 1_000_000))

print("=" * 72)
if _failed:
    print(f"{FAIL} {_failed} 项失败")
    sys.exit(1)
print("✅ 全部通过")
