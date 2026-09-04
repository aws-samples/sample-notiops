#!/usr/bin/env python3
"""把 `cdk synth` 出来的 standalone 模板改造成**可发布的一键部署模板**。

`infra/bin/standalone.ts` 合成出来的东西还不能给客户 —— 它带着两处 CDK 自己的痕迹：

  1. BFF 那个 Lambda 的代码指向 `cdk-hnb659fds-assets-<账号>-<区域>`，也就是
     `cdk bootstrap` 建的资产桶。客户账号里没有这个桶（一键部署的全部意义就是
     不用装 CDK、不用 bootstrap）。本脚本把它改写成 `!Ref StagingBucket` ——
     栈自己建的那个桶，代码由 StagerFn 从 GitHub Release 搬进去。
  2. `Parameters.BootstrapVersion` + `Rules.CheckBootstrapVersion`（若有）会去读
     bootstrap 栈的 SSM 参数，在没 bootstrap 的账号里直接让开栈失败。

以及一处**必须由发布流程填**的信息：

  3. 产物清单（`StagerArtifacts.Properties.Artifacts`）与 Release tag
     （`Mappings.NotiOpsRelease.Default`）。模板合成时不知道自己将被挂到哪个 Release
     上，也不知道产物的 SHA256。这里注入，于是模板与产物是**一对一绑死**的：
     tag 进 S3 key（CFN 不检测 S3 对象内容变化，key 不变 = 不更新 = 客户升级后
     跑的还是旧代码），sha256 让 StagerFn 能拒掉被替换过的产物。

用法：
    python3 scripts/postprocess_template.py \\
        --in  /tmp/notiops-cdk-out/NotiOps.template.json \\
        --out dist/notiops-webchat.template.json \\
        --release-tag v1.2.3 \\
        --sha256 dist/SHA256SUMS

这个脚本**只做断言式改写**：每一处改写都先数清该有几处、改完再核对，任何一处对不上
就整体失败。理由很直接 —— 它的产物是客户点一下就往生产账号里开的栈，一处静默漏改
（比如某个资源还指着 bootstrap 桶）会变成客户侧一个看不懂的 ROLLBACK。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 与 infra/lib/notiops-webchat-standalone-stack.ts 里的占位值一一对应。
# 两边任何一个改了，另一边的断言会立刻失败 —— 这是有意的耦合。
RELEASE_TAG_PLACEHOLDER = "0.0.0-UNPROCESSED"
DEFAULT_BASE_URL_TEMPLATE = "https://github.com/aws-samples/sample-notiops/releases/download/{tag}"

# `Mappings.NotiOpsRelease` 的顶层键。**不是** `Default` —— CloudFormation 把 Mappings 里
# 名为 `Default` 的项当成 Fn::FindInMap 增强查找的兜底值（必须是字符串），于是
# `Default: {Tag, BaseUrl}` 会被判模板格式错误。cdk synth 不报，validate-template 才报。
RELEASE_MAP_KEY = "Current"

# 六个 Release 产物。名字就是 Release 里的资产文件名，StagerFn 用
# `<BaseUrl>/<name>` 拼下载地址。
# 顺序 = StagerFn 的搬运顺序：小的先搬。144 MiB 的 agent zip 放最后，
# 前面任何一个失败都能在几秒内暴露，而不是等它传完才发现。
BFF_ARTIFACT = "bff.zip"
CHAT_DIST_ARTIFACT = "chat-dist.zip"
# 「通知」生产端。名字与 infra/lib/constructs/web-notif-sources.ts 的
# `WEB_NOTIF_ARTIFACT`、scripts/build_web_notif_zip.py 的产出一致。
NOTIF_ARTIFACT = "web-notif.zip"
# IM（飞书 / Slack）加装项：业务代码 + 依赖层。**必须以 `im-` 开头** ——
# StagerFn 在 `InstallOption=web`（只装 web）时按这个前缀跳过它们
# （infra/lambda/stager/index.py `_artifacts_upsert`）。
IM_CODE_ARTIFACT = "im-code.zip"
IM_LAYER_ARTIFACT = "im-layer.zip"
AGENT_ARTIFACT = "agent-code.zip"

# CDK 默认 bootstrap 限定词（qualifier）。出现在资产桶名里。
BOOTSTRAP_MARKERS = ("cdk-hnb659fds", "cdk-bootstrap")

# CFN 限制：`--template-body` / 控制台直接粘贴上限 51,200 字节；
# 传 S3（`--template-url` / 控制台 "Upload a template file"）上限 1 MB。
INLINE_TEMPLATE_LIMIT = 51_200
S3_TEMPLATE_LIMIT = 1_000_000


class PostprocessError(RuntimeError):
    """改写没能按预期完成 —— 一律当致命错误，绝不产出半成品模板。"""


# ── 小工具 ────────────────────────────────────────────────────────────────────
def _walk(node, path=()):
    """深度遍历 (路径, 容器, 键, 值)，供改写与扫描共用。"""
    if isinstance(node, dict):
        for k, v in list(node.items()):
            yield path + (k,), node, k, v
            yield from _walk(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield path + (str(i),), node, i, v
            yield from _walk(v, path + (str(i),))


def _resolve(node, mappings: dict) -> str:
    """把模板里一小撮 intrinsic 求值成字符串。

    只支持 `Fn::Join` 与 `Fn::FindInMap` —— 恰好够算出 S3 key（`agent/<tag>/…`）。
    刻意**不**做通用求值器：碰到别的 intrinsic 就报错，比默默算出一个错的 key
    好得多（错的 key = 客户开栈时一个 S3 404）。
    """
    if isinstance(node, str):
        return node
    if isinstance(node, dict) and len(node) == 1:
        fn, arg = next(iter(node.items()))
        if fn == "Fn::Join":
            sep, parts = arg
            return sep.join(_resolve(p, mappings) for p in parts)
        if fn == "Fn::FindInMap":
            m, top, second = (_resolve(x, mappings) for x in arg)
            try:
                return mappings[m][top][second]
            except KeyError as exc:
                raise PostprocessError(f"Fn::FindInMap {m}/{top}/{second} not found in Mappings") from exc
    raise PostprocessError(f"cannot resolve to a literal string: {json.dumps(node)[:200]}")


def _logical_id_by_cdk_path(resources: dict, suffix: str) -> str:
    """按构件路径找逻辑 ID。

    为什么不直接写死逻辑 ID：CDK 给逻辑 ID 加的 8 位 hash 后缀会随构件树变化，
    写死等于每次动一下栈结构就要改这个脚本。`aws:cdk:path` 是稳定的人写路径。
    """
    hits = [k for k, v in resources.items()
            if (v.get("Metadata") or {}).get("aws:cdk:path", "").endswith(suffix)]
    if len(hits) != 1:
        raise PostprocessError(
            f"expected exactly 1 resource with cdk path ending in {suffix!r}, found {len(hits)}: {hits}")
    return hits[0]


def _read_sha256sums(path: Path) -> dict[str, str]:
    """读 `sha256sum` 格式的清单（`<hex>  <文件名>`）。"""
    sums: dict[str, str] = {}
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            raise PostprocessError(f"{path}:{lineno}: not a sha256sum line: {raw!r}")
        # 只取 basename：sha256sum 常带 `*` 前缀或目录前缀，而清单里存的是
        # Release 里的资产文件名。
        sums[Path(parts[1].lstrip("*")).name] = parts[0]
    return sums


# ── 改写步骤 ──────────────────────────────────────────────────────────────────
def rewrite_asset_bucket(template: dict) -> int:
    """把资产桶引用改写成 `!Ref StagingBucket`。返回改写处数。

    合成产物里**应当只有一个** CDK 资产（BFF 的 `Code.fromAsset`）—— 那正是
    `staticTemplate: true` 干掉另外 4 个隐式 Lambda 之后的结果。所以这里不只是改写，
    还兼作一道判据：数目对不上说明有人在 standalone 栈里加回了资产（BucketDeployment、
    NodejsFunction、autoDeleteObjects、cr.Provider …），必须当场发现。
    """
    resources = template["Resources"]
    staging_id = _logical_id_by_cdk_path(resources, "/StagingBucket/Resource")

    count = 0
    for _path, container, key, value in _walk(template):
        if key == "S3Bucket" and isinstance(value, dict):
            literal = json.dumps(value)
            if any(m in literal for m in BOOTSTRAP_MARKERS):
                container[key] = {"Ref": staging_id}
                count += 1
    if count != 1:
        raise PostprocessError(
            f"expected exactly 1 CDK asset bucket reference to rewrite, rewrote {count}. "
            "A count > 1 means a new CDK asset crept into the standalone stack "
            "(BucketDeployment / cr.Provider / autoDeleteObjects / logRetention all create one); "
            "a count of 0 means the synth output changed shape.")
    return count


def strip_bootstrap(template: dict) -> None:
    """删掉 bootstrap 版本参数与校验 Rule（在没 bootstrap 的账号里它们必然让开栈失败）。"""
    template.get("Parameters", {}).pop("BootstrapVersion", None)
    rules = template.get("Rules", {})
    for name in list(rules):
        if "bootstrap" in name.lower() or any(m in json.dumps(rules[name]) for m in BOOTSTRAP_MARKERS):
            rules.pop(name)
    if not rules:
        template.pop("Rules", None)
    # Metadata 里那份 `aws:cdk:analytics` / BootstrapVersion 的说明也一起清掉，
    # 免得客户在参数页看到一个自己没法满足的前置条件。
    meta = template.get("Metadata", {})
    iface = meta.get("AWS::CloudFormation::Interface", {})
    for group in iface.get("ParameterGroups", []):
        group["Parameters"] = [p for p in group.get("Parameters", []) if p != "BootstrapVersion"]
    iface.get("ParameterLabels", {}).pop("BootstrapVersion", None)


def set_release(template: dict, tag: str, base_url: str) -> None:
    """把 Release tag / 下载根地址写进 Mappings。"""
    try:
        entry = template["Mappings"]["NotiOpsRelease"][RELEASE_MAP_KEY]
    except KeyError as exc:
        raise PostprocessError(
            f"Mappings.NotiOpsRelease.{RELEASE_MAP_KEY} is missing — synth output changed shape") from exc
    if entry.get("Tag") != RELEASE_TAG_PLACEHOLDER:
        raise PostprocessError(
            f"Mappings.NotiOpsRelease.{RELEASE_MAP_KEY}.Tag is {entry.get('Tag')!r}, expected the placeholder "
            f"{RELEASE_TAG_PLACEHOLDER!r}. Refusing to postprocess an already-processed template "
            "(running this twice would silently re-tag an existing release).")
    entry["Tag"] = tag
    entry["BaseUrl"] = base_url


def build_manifest(template: dict, sums: dict[str, str]) -> list[dict]:
    """从模板里读出四个产物的 S3 key，配上 sha256，组成 StagerFn 要的清单。

    key **一律从模板里读**、不在这里重新拼一遍。理由：模板是唯一真源 —— BFF 的
    key 是 CDK 算的资产 hash，agent / 前端的 key 是栈里用 tag 拼的。在脚本里复述
    一遍拼接规则，就等于埋了一处「两边同时改才对」的隐患。
    """
    resources = template["Resources"]
    mappings = template["Mappings"]

    bff_id = _logical_id_by_cdk_path(resources, "/WebChatBff/Resource")
    bff_key = resources[bff_id]["Properties"]["Code"]["S3Key"]
    if not isinstance(bff_key, str):
        raise PostprocessError(f"BFF Code.S3Key is not a literal string: {json.dumps(bff_key)[:200]}")

    agent_key = _resolve(
        resources["AgentRuntime"]["Properties"]["AgentRuntimeArtifact"]["CodeConfiguration"]["Code"]["S3"]["Prefix"],
        mappings)
    dist_key = _resolve(resources["StagerSite"]["Properties"]["ChatDistKey"], mappings)

    notif_id = _logical_id_by_cdk_path(resources, "/WebNotifFn")
    notif_key = _resolve(resources[notif_id]["Properties"]["Code"]["S3Key"], mappings)

    # IM 加装项。三个 IM 函数共用同一份代码，随便读哪一个都一样 —— 取 FeishuWorker
    # 是因为它是 im-core.ts 里第一个建的（`platforms.feishu` 分支）。
    # 层读的是 `Content`（不是 `Code`）：`AWS::Lambda::LayerVersion` 的代码属性叫
    # Content，`assert_clean` 的 DependsOn 判据也因此要同时认这两个名字。
    im_code_id = _logical_id_by_cdk_path(resources, "/FeishuWorker/Resource")
    im_code_key = _resolve(resources[im_code_id]["Properties"]["Code"]["S3Key"], mappings)
    im_layer_id = _logical_id_by_cdk_path(resources, "/ImDepsLayer/Resource")
    im_layer_key = _resolve(resources[im_layer_id]["Properties"]["Content"]["S3Key"], mappings)

    manifest = []
    for name, key in ((BFF_ARTIFACT, bff_key), (CHAT_DIST_ARTIFACT, dist_key),
                      (NOTIF_ARTIFACT, notif_key),
                      (IM_CODE_ARTIFACT, im_code_key), (IM_LAYER_ARTIFACT, im_layer_key),
                      (AGENT_ARTIFACT, agent_key)):
        if name not in sums:
            raise PostprocessError(f"{name} has no sha256 in the checksum manifest (have: {sorted(sums)})")
        manifest.append({"name": name, "key": key, "sha256": sums[name]})
    return manifest


def inject_manifest(template: dict, manifest: list[dict]) -> None:
    props = template["Resources"]["StagerArtifacts"]["Properties"]
    if props.get("Artifacts") != "[]":
        raise PostprocessError(
            f"StagerArtifacts.Properties.Artifacts is {props.get('Artifacts')!r}, expected the empty "
            "placeholder '[]'. Refusing to overwrite an already-injected manifest.")
    # 存成 JSON **字符串**而不是嵌套对象：自定义资源属性到了 Lambda 那边全是字符串，
    # 嵌套结构会被 CFN 逐个字段转成字符串、数组顺序也没有保证。
    props["Artifacts"] = json.dumps(manifest, separators=(",", ":"))


# ── 全局判据 ──────────────────────────────────────────────────────────────────
def assert_customer_text_is_ascii(template: dict) -> None:
    """客户在控制台上看得见的文案必须是纯 ASCII。

    实测（2026-08，us-east-1）：CloudFormation 收模板时把非 ASCII 字符**一律换成 `?`**。
    `"em—dash 前端 ok"` 进去、`"em?dash ??? ok"` 出来 —— 于是参数页/Outputs 页上客户看到
    的是一串问号。这不是渲染问题，是模板被服务端改了，本地怎么看都是好的。
    所以破折号写 `--` 不写 `—`，中文一律不进这些字段（`cdk synth`、`tsc`、
    `validate-template` 全都不管这件事，只有客户的眼睛管）。

    只查客户可见的字段。**不查整份模板**：受影响的是模板里那些"说明性"文本字段，
    资源属性里的字符串不受影响 —— 实测把栈开起来后把 StagerFn 的代码下载回来，
    `Code.ZipFile` 内联的那 2463 个非 ASCII 字符（中文注释）一个不少地到了云上。
    所以这里只钉客户会读到的那几处，中文注释照旧写。
    """
    bad: list[str] = []

    def check(where: str, value) -> None:
        if isinstance(value, str) and any(ord(c) > 127 for c in value):
            offenders = "".join(sorted({c for c in value if ord(c) > 127}))
            bad.append(f"{where}: contains {offenders!r} in {value[:80]!r}")

    check("Description", template.get("Description"))
    for name, param in (template.get("Parameters") or {}).items():
        for field in ("Description", "ConstraintDescription", "Default"):
            check(f"Parameters.{name}.{field}", param.get(field))
    iface = (template.get("Metadata") or {}).get("AWS::CloudFormation::Interface", {})
    for group in iface.get("ParameterGroups", []):
        check("ParameterGroups[].Label", (group.get("Label") or {}).get("default"))
    for name, label in (iface.get("ParameterLabels") or {}).items():
        check(f"ParameterLabels.{name}", (label or {}).get("default"))
    for name, out in (template.get("Outputs") or {}).items():
        check(f"Outputs.{name}.Description", out.get("Description"))
    # 资源上的 Description（Cognito 组、AgentCore Runtime …）也会出现在各服务的控制台里。
    for name, res in template["Resources"].items():
        check(f"Resources.{name}.Description", (res.get("Properties") or {}).get("Description"))

    if bad:
        raise PostprocessError(
            "customer-visible template text contains non-ASCII characters; CloudFormation "
            "replaces them with '?' server-side, so the console would show mojibake:\n  "
            + "\n  ".join(bad))


def assert_clean(template: dict, tag: str) -> None:
    """改完之后全模板扫一遍。任何一条不满足就不产出模板。"""
    blob = json.dumps(template)

    for marker in BOOTSTRAP_MARKERS:
        if marker in blob:
            raise PostprocessError(f"template still references CDK bootstrap ({marker!r})")
    if RELEASE_TAG_PLACEHOLDER in blob:
        raise PostprocessError(f"template still contains the release placeholder {RELEASE_TAG_PLACEHOLDER!r}")
    if "BootstrapVersion" in blob:
        raise PostprocessError("template still references BootstrapVersion")

    # 硬编码的 12 位账号 ID = 模板绑死在某个账号上（也可能是把我们自己的账号号码
    # 发到公网）。env-agnostic 合成本该全用 AWS::AccountId 伪参数，出现字面量
    # 说明有人在栈里写死了什么。
    #
    # 按**完整 token** 匹配，不用裸 `\d{12}` 正则：模板里有一堆 64 位 hex
    # （资产 hash、sha256），其中随机出现连续 12 个数字是常事，裸正则会误报。
    # CDKMetadata 的 Analytics 是压缩后的 base64 blob，同理跳过。
    scannable = {k: v for k, v in template.items() if k != "Resources"}
    scannable["Resources"] = {k: v for k, v in template["Resources"].items() if k != "CDKMetadata"}
    for token in re.findall(r"[0-9A-Za-z]+", json.dumps(scannable)):
        if len(token) == 12 and token.isdigit():
            raise PostprocessError(
                f"template contains a literal 12-digit account id {token!r} — "
                "the one-click template must be account-agnostic (use AWS::AccountId). "
                "If this came from --base-url (a mirror bucket name usually carries the account "
                "id), don't bake it in: leave the template pointing at the GitHub release and "
                "pass the mirror as the ArtifactBaseUrl stack parameter at deploy time.")

    # Mappings 里不许有名为 `Default` 的顶层键 —— CFN 把它当成 Fn::FindInMap 增强查找的
    # 兜底值并要求是字符串，写成对象会让整份模板在**开栈的第一秒**就格式错误。
    # 这条放在这里而不是靠人记住：cdk synth 与 tsc 对它一无所知，实测只有
    # validate-template / 真开栈会报，而那时客户已经点了按钮。
    for map_name, mapping in (template.get("Mappings") or {}).items():
        bad = [k for k, v in mapping.items() if k == "Default" and not isinstance(v, str)]
        if bad:
            raise PostprocessError(
                f"Mappings.{map_name} has a non-string 'Default' key. CloudFormation reserves that "
                "name for Fn::FindInMap's default value; the template would fail with "
                "\"Every Mappings Default must be a String\". Rename the top-level key "
                f"(we use {RELEASE_MAP_KEY!r}).")

    assert_customer_text_is_ascii(template)

    resources = template["Resources"]
    if "StagerArtifacts" not in resources or "StagerSite" not in resources:
        raise PostprocessError("StagerArtifacts / StagerSite custom resources are missing")

    # 所有把 staging 桶**当代码来源**的资源都必须等 StagerArtifacts 跑完 ——
    # 少一条 DependsOn 就是「代码还没搬到就去创建函数」，客户侧一个 S3 404。
    # 判定按「Ref 出现在 `Code…` / `Content…` 路径下」，不是「资源里提到过这个桶」：
    # 桶自己的 BucketPolicy、两个 Stager 自定义资源都会提到它，那些不算代码来源。
    # `Content` 是 `AWS::Lambda::LayerVersion` 的代码字段（IM 依赖层 ImDepsLayer）——
    # 只认 `Code` 会漏掉它，而漏掉的症状是**偶发**的：CFN 并行创建时层可能比产物先到，
    # 于是 `NoSuchKey` 有时才出现（选了 web+飞书/Slack 才有这个资源）。
    staging_id = _logical_id_by_cdk_path(resources, "/StagingBucket/Resource")
    code_fields = ("Code", "Content")
    code_consumers = set()
    for name, res in resources.items():
        for path, _c, key, value in _walk(res.get("Properties", {})):
            if key == "Ref" and value == staging_id and any(p.startswith(code_fields) for p in path):
                code_consumers.add(name)
    if not code_consumers:
        raise PostprocessError(
            "no resource takes its code from the staging bucket — the asset rewrite did not land "
            "where it was supposed to")
    for name in sorted(code_consumers):
        deps = resources[name].get("DependsOn") or []
        deps = [deps] if isinstance(deps, str) else deps
        if "StagerArtifacts" not in deps:
            raise PostprocessError(
                f"{name} takes its code from the staging bucket but does not DependsOn StagerArtifacts")

    # 每个产物在模板里都得真的被引用到 —— 搬一个没人用的 zip 只是白花时间和流量。
    manifest = json.loads(resources["StagerArtifacts"]["Properties"]["Artifacts"])
    if len(manifest) != 6:
        raise PostprocessError(f"expected 6 artifacts in the manifest, got {len(manifest)}")
    for entry in manifest:
        for field in ("name", "key", "sha256"):
            if not entry.get(field):
                raise PostprocessError(f"manifest entry missing {field}: {entry}")
        if not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise PostprocessError(f"manifest entry has a malformed sha256: {entry}")
    if tag not in json.dumps(manifest):
        raise PostprocessError(
            f"no artifact key contains the release tag {tag!r} — without a version in the key, "
            "CloudFormation cannot tell that the code changed and customers keep running the old build")

    # 日志组不许写死名字。理由不是洁癖:`/aws/lambda/<函数名>` 这种组 **Lambda 服务
    # 自己也会建**(方式 B 就留下这样一个不属于任何栈的组),而 CFN 从 2026 起有
    # NAME_CONFLICT_VALIDATION 预检 —— 同名组已存在就**整栈 9 秒内失败**,报错只提
    # 日志组,客户完全看不出这跟「通知」有什么关系(v1.0.16 实测)。
    # 正确写法:不给 LogGroupName(CFN 自己命名)+ 函数上写 LoggingConfig 指过来。
    # 允许含 StackName 的动态名(Fn::Join/Sub) —— 那种名字随栈唯一,不会撞。
    for name, res in resources.items():
        if res.get("Type") != "AWS::Logs::LogGroup":
            continue
        log_name = res.get("Properties", {}).get("LogGroupName")
        if isinstance(log_name, str):
            raise PostprocessError(
                f"{name} hardcodes LogGroupName={log_name!r}. A literal log group name collides with "
                "the group the Lambda service creates on its own (and with any leftover from another "
                "deployment path): CloudFormation's NAME_CONFLICT_VALIDATION then fails the whole "
                "stack in seconds with 'already exists'. Drop LogGroupName and point the function at "
                "the group via LoggingConfig instead.")


# ── main ─────────────────────────────────────────────────────────────────────
def postprocess(template: dict, tag: str, sums: dict[str, str], base_url: str) -> dict:
    rewrite_asset_bucket(template)
    strip_bootstrap(template)
    set_release(template, tag, base_url)
    inject_manifest(template, build_manifest(template, sums))
    assert_clean(template, tag)
    return template


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True, type=Path, help="cdk synth output template (JSON)")
    ap.add_argument("--out", dest="dst", required=True, type=Path, help="publishable template to write")
    ap.add_argument("--release-tag", required=True, help="e.g. v1.2.3 — goes into the artifact S3 keys")
    ap.add_argument("--sha256", required=True, type=Path, help="sha256sum-format manifest of the artifacts")
    ap.add_argument("--base-url", default=None,
                    help="artifact download base URL (default: the GitHub release for --release-tag)")
    args = ap.parse_args(argv)

    base_url = args.base_url or DEFAULT_BASE_URL_TEMPLATE.format(tag=args.release_tag)
    template = json.loads(args.src.read_text(encoding="utf-8"))

    try:
        out = postprocess(template, args.release_tag, _read_sha256sums(args.sha256), base_url)
    except PostprocessError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    body = json.dumps(out, indent=1, ensure_ascii=False) + "\n"
    size = len(body.encode("utf-8"))
    if size > S3_TEMPLATE_LIMIT:
        print(f"ERROR: template is {size} bytes, over CloudFormation's {S3_TEMPLATE_LIMIT}-byte S3 limit",
              file=sys.stderr)
        return 1

    args.dst.parent.mkdir(parents=True, exist_ok=True)
    args.dst.write_text(body, encoding="utf-8")

    print(f"wrote {args.dst} ({size} bytes) for release {args.release_tag}")
    print(f"  artifact base url: {base_url}")
    for entry in json.loads(out["Resources"]["StagerArtifacts"]["Properties"]["Artifacts"]):
        print(f"  {entry['name']:<16} -> s3://<StagingBucket>/{entry['key']}  sha256={entry['sha256'][:12]}…")
    if size > INLINE_TEMPLATE_LIMIT:
        # 不是错误，是使用约束，必须说清楚：`aws cloudformation create-stack --template-body`
        # 会因为超 51,200 字节直接被拒。控制台 "Upload a template file" 和
        # `--template-url` 走 S3，没这个问题。
        print(f"  note: {size} bytes > {INLINE_TEMPLATE_LIMIT} — deploy via the console's "
              "\"Upload a template file\" or `--template-url s3://…`, NOT `--template-body`")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
