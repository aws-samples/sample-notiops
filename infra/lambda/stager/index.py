"""一键部署（Launch Stack）的 StagerFn —— 单栈里唯一的"搬运工"。

它替代了 CDK 路径上那 4 个隐式 Lambda（LogRetention / S3AutoDeleteObjects /
BucketDeployment / ChatConfig provider），因为一键模板里不能有任何 CDK 资产：
客户账号没有 `cdk bootstrap` 出来的资产桶，取不到那些函数的代码。
本文件通过 `Code.ZipFile` **内联**进模板（官方上限 4MB，本文件 ~20KB），
所以它自己不需要任何桶。这条部署路径的对客说明见 docs/DEPLOYMENT_ONECLICK.md。

一个函数、多个自定义资源（用 `Phase` 属性区分），前两个这样切是为了**避开循环依赖**：
  · Phase=Artifacts —— 把 Release 产物搬进 staging 桶。BFF 的 Lambda 代码与 AgentCore
    Runtime 的 zip 都从这个桶取，所以它们 `DependsOn` 这一个。它自己只依赖 staging 桶。
  · Phase=Site —— 写前端 + config.json + 建管理员。config.json 里有 BFF 的 Function URL，
    所以它**依赖 BFF**；而 BFF 依赖 Artifacts。两件事塞进同一个自定义资源就会成环。
  · Phase=OrgSetup —— 只在客户选了多账号时才存在：打开 StackSets 的组织信任访问
    （没有对应的 CFN 资源）+ 建两个成员账号 StackSet。理由见下方该段注释。

铁律（改这个文件前先读）：
  1. **绝不打印凭证/密码**。管理员初始密码由 Cognito 生成并直接发邮件，本函数从不接触它。
  2. **绝不按前缀扫描后批量删**。要删的日志组名由模板按属性精确传进来。
     桶是例外：删栈时必须**清空整个桶**（列举全部对象）否则 DESTROY 的桶删不掉、卡住删栈。
  3. **`config.json` 只覆盖、不删除**。前端 prune 阶段显式豁免它（团队规定）。
  4. **一律回响应**。任何异常都要 send FAILED —— 不回 CFN 就干等 1 小时再失败。
  5. 大产物**流式**过（agent zip 现网 144 MiB）：不 `resp.read()` 进内存、不落 /tmp
     （Lambda /tmp 只有 512MB，且 agent zip 未来只会更大）。
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from decimal import Decimal
from io import BytesIO

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.exceptions import ClientError

s3 = boto3.client("s3")

# 8MB 分片、4 路并发 —— upload_fileobj 支持不可 seek 的流（内部按片读进内存后再传，
# 单片失败可重试）。内存占用上限 ≈ 32MB，故函数给 1024MB 绰绰有余。
_XFER = TransferConfig(multipart_chunksize=8 * 1024 * 1024, max_concurrency=4)

# 前端资源的缓存策略：带内容 hash 的构建产物可以长缓存，入口和运行时配置绝不能缓存
# （否则客户升级后浏览器还拿旧 index.html → 引用已被 prune 掉的 assets → 白屏）。
_NO_CACHE = "no-cache, no-store, must-revalidate"
_IMMUTABLE = "public, max-age=31536000, immutable"


# ── CFN 自定义资源响应 ────────────────────────────────────────────────────────
def _send(event, context, status, data=None, reason=None, physical_id=None):
    body = json.dumps({
        "Status": status,
        "Reason": (reason or "ok")[:1000] + f" (log: {context.log_stream_name})",
        "PhysicalResourceId": physical_id or event.get("PhysicalResourceId")
                              or f"{event['LogicalResourceId']}-{event['RequestId']}",
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "NoEcho": False,
        "Data": data or {},
    }).encode()
    req = urllib.request.Request(
        event["ResponseURL"], data=body, method="PUT",
        headers={"content-type": "", "content-length": str(len(body))},
    )
    with urllib.request.urlopen(req) as resp:
        print(f"cfn-response {status} http={resp.status}")


class _AgentCoreError(Exception):
    """bedrock-agentcore-control 的一个 REST 错误（见 Phase=WebSearch 那节的 `_ac_call`）。
    带上 `code`（`x-amzn-errortype` / body 里的 __type），这样 `_ignore_missing` 能像对
    boto3 的 ClientError 一样判断「本来就不存在」。"""

    def __init__(self, code: str, status: int, message: str):
        super().__init__(f"{code} (HTTP {status}): {message}")
        self.code = code
        self.status = status


_MISSING_CODES = {
    "NoSuchBucket", "NoSuchKey", "404", "NotFound",
    "ResourceNotFoundException", "UserNotFoundException",
    # `_ac_call` 在响应既没有 `x-amzn-errortype` 头、body 里也没有 `__type` 时会退化成
    # `HTTP<状态码>`。404 无论怎么写都是「本来就不存在」。
    "HTTP404",
}


def _ignore_missing(exc: Exception) -> bool:
    """只吞「本来就不存在」这一类错误（幂等重试用），其余一律上抛。"""
    if isinstance(exc, _AgentCoreError):
        return exc.code in _MISSING_CODES
    if not isinstance(exc, ClientError):
        return False
    return exc.response.get("Error", {}).get("Code") in _MISSING_CODES


# ── 流式下载 + SHA256 校验 ───────────────────────────────────────────────────
class _Hashing:
    """透传 read() 并顺便算 sha256 的 file-like 包装。

    校验只能在**传完之后**做（流是一次性的，没法先读一遍算 hash 再重头传）。
    因此校验不通过时要把已上传的对象删掉再报错 —— 不能留一个内容不明的 zip 在桶里。
    消费方（BFF / AgentCore Runtime）都 DependsOn 本资源，失败即整栈失败，
    在此之前没人读得到它。
    """

    def __init__(self, fp):
        self._fp, self._h, self.total = fp, hashlib.sha256(), 0

    def read(self, size=-1):
        chunk = self._fp.read(size) if size and size > 0 else self._fp.read()
        if chunk:
            self._h.update(chunk)
            self.total += len(chunk)
        return chunk

    @property
    def hexdigest(self):
        return self._h.hexdigest()


def _open_source(src: str):
    """打开产物来源，返回一个可 read() 的流（调用方负责 close）。

    支持两种来源，因为出网条件差别很大：
      · `https://…` —— 默认路径（GitHub Release）。**不带任何凭证**的普通 GET，
        所以内网镜像若走这一种，对象必须是匿名可读的。
      · `s3://桶/前缀` —— 用本函数自己的角色签名去读，于是镜像桶可以完全私有
        （Block Public Access 全开）。出网被掐死、或不愿把产物公开的账号用这条。
        权限来自模板的 ArtifactMirrorBucket 参数，只授到那一个桶的 GetObject。
    """
    if src.startswith("s3://"):
        bucket, _, key = src[len("s3://"):].partition("/")
        if not bucket or not key:
            raise ValueError(f"malformed s3 uri: {src}")
        return s3.get_object(Bucket=bucket, Key=key)["Body"]
    # 30 秒**建连**超时；GitHub Release 会 302 到 objects.githubusercontent.com，
    # urlopen 默认跟随重定向。
    req = urllib.request.Request(src, headers={"user-agent": "notiops-stager"})
    return urllib.request.urlopen(req, timeout=30)


def _fetch_to_s3(src: str, bucket: str, key: str, sha256: str) -> int:
    """把 src 流式搬到 s3://bucket/key，并校验 sha256。返回字节数。"""
    last: Exception | None = None
    for attempt in range(1, 4):
        stream = None
        try:
            stream = _open_source(src)
            wrapped = _Hashing(stream)
            s3.upload_fileobj(wrapped, bucket, key, Config=_XFER)
            got = wrapped.hexdigest
            if got != sha256:
                s3.delete_object(Bucket=bucket, Key=key)
                raise ValueError(
                    f"sha256 mismatch for {src}: expected {sha256}, got {got} "
                    "(artifact does not match the one this template was built for)")
            print(f"staged {src} -> s3://{bucket}/{key} bytes={wrapped.total} sha256={got}")
            return wrapped.total
        except ValueError:
            raise                       # 校验失败不重试：重试一百次也还是同一个文件
        except Exception as exc:        # noqa: BLE001 —— 网络/S3 抖动才重试
            last = exc
            print(f"attempt {attempt}/3 failed for {src}: {exc!r}")
            time.sleep(3 * attempt)
        finally:
            # 重试要拿一条新的流：读到一半断掉的那条已经不能从头再读，
            # 复用它会把「网络抖动」变成「sha256 不匹配」这种误导性的失败。
            if stream is not None:
                try:
                    stream.close()
                except Exception:       # noqa: BLE001 —— 关闭失败不该盖掉真实错误
                    pass
    raise RuntimeError(f"failed to stage {src} after 3 attempts: {last!r}")


# ── 桶操作 ───────────────────────────────────────────────────────────────────
def _empty_bucket(bucket: str, keep: set[str] | None = None) -> int:
    """清空桶（含所有版本），可保留 keep 里的 key。返回删除数。

    这里**必须**列举全部对象：桶是 `DeletionPolicy: Delete`，非空则删不掉，
    整个删栈会卡在那个桶上。同时用 list_object_versions —— 桶现在没开版本控制，
    但将来若开了，只删 current version 会留下一堆 delete marker，桶照样非空。
    """
    keep = keep or set()
    deleted = 0
    try:
        pages = s3.get_paginator("list_object_versions").paginate(Bucket=bucket)
        for page in pages:
            batch = [
                {"Key": o["Key"], "VersionId": o["VersionId"]}
                for o in (page.get("Versions", []) + page.get("DeleteMarkers", []))
                if o["Key"] not in keep
            ]
            for i in range(0, len(batch), 1000):
                s3.delete_objects(Bucket=bucket, Delete={"Objects": batch[i:i + 1000], "Quiet": True})
                deleted += len(batch[i:i + 1000])
    except Exception as exc:  # noqa: BLE001
        if not _ignore_missing(exc):
            raise
    print(f"emptied s3://{bucket} deleted={deleted} kept={sorted(keep)}")
    return deleted


def _delete_bucket(bucket: str) -> None:
    """删桶，`OperationAborted` 要原地重试。

    刚清空一个桶之后，S3 常把紧接着的 DeleteBucket 以「A conflicting conditional
    operation is currently in progress against this resource」拒掉 —— 前一批删除还在
    收敛。这条路径上的异常是**要上抛**的（客户选了 DeleteEverything，悄悄留下数据比
    卡住更糟），所以不重试就等于把删栈直接送进 DELETE_FAILED：实测踩到过一次，客户看到
    的就是"删栈失败了"，而唯一的处置是自己再点一次 Delete。
    """
    for attempt in range(6):  # 6 × 5s
        try:
            s3.delete_bucket(Bucket=bucket)
            print(f"deleted bucket {bucket}")
            return
        except Exception as exc:  # noqa: BLE001
            if _ignore_missing(exc):
                return
            code = exc.response.get("Error", {}).get("Code") if isinstance(exc, ClientError) else None
            if code != "OperationAborted" or attempt == 5:
                raise
            print(f"bucket {bucket}: {code} — retrying")
            time.sleep(5)


def _content_type(key: str) -> str:
    guess = mimetypes.guess_type(key)[0]
    if guess:
        # 显式补 charset：CloudFront 不会替你加，缺了中文界面在部分浏览器上乱码。
        if guess.startswith("text/") or guess in ("application/javascript", "application/json"):
            return f"{guess}; charset=utf-8"
        return guess
    return "application/octet-stream"


# ── Phase=Artifacts ─────────────────────────────────────────────────────────
def _artifacts_upsert(props) -> dict:
    bucket = props["StagingBucket"]
    artifacts = json.loads(props.get("Artifacts") or "[]")
    if not artifacts:
        # 空清单 = 这份模板没跑过 scripts/postprocess_template.py（它负责把
        # 产物名/key/sha256 注进来）。继续下去的话 BFF 与 Runtime 会去取不存在的
        # 对象，报一个看不懂的 S3 错误。这里直接给出人能读懂的失败原因。
        raise ValueError(
            "Artifacts manifest is empty — this template was not post-processed. "
            "Run scripts/postprocess_template.py on the synthesized template.")
    base = (props.get("ArtifactBaseUrlOverride") or "").strip().rstrip("/") \
        or props["DefaultArtifactBaseUrl"].rstrip("/")
    # IM（飞书 / Slack）是加装项。只装 web 时那两个 `im-*` 产物没有任何引用者，白搬
    # 一遍要多花十几秒、还会在 staging 桶里留下客户没装的东西。
    # 判据是**产物名前缀**而不是安装选项的具体取值："web+dingtalk" 之类以后新增的
    # 选项自动落到"要装 IM"这一侧，不需要再回来改这里。
    # 反过来也成立：`InstallOption` 属性变了（web → web+feishu）就是一次 Update，
    # 这个函数会重跑并把缺的产物补下来。
    skip_im = (props.get("InstallOption") or "web").strip() == "web"
    staged, skipped = {}, []
    for a in artifacts:
        if skip_im and a["name"].startswith("im-"):
            skipped.append(a["name"])
            continue
        staged[a["name"]] = _fetch_to_s3(f"{base}/{a['name']}", bucket, a["key"], a["sha256"])
    if skipped:
        print(f"skipped {len(skipped)} IM artifact(s) (InstallOption=web): {skipped}")
    return {"StagedCount": str(len(staged)), "TotalBytes": str(sum(staged.values()))}


# ── Phase=Site ──────────────────────────────────────────────────────────────
def _publish_frontend(props) -> int:
    """把 staging 桶里的 chat-dist.zip 解开写进网站桶，并清掉上一版的残留文件。

    前端 zip 只有几 MB（agent zip 才是大的那个），所以这里可以整包进内存 —— zipfile
    需要可 seek 的对象，流式解压要额外的中间层，不值得为几 MB 引入。
    """
    staging, site = props["StagingBucket"], props["SiteBucket"]
    key = props["ChatDistKey"]
    blob = s3.get_object(Bucket=staging, Key=key)["Body"].read()
    written = set()
    with zipfile.ZipFile(BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename.lstrip("/")
            if ".." in name.split("/"):
                # zip-slip：解压路径逃逸。写 S3 不像写文件系统那样能跳出目录，但一个
                # 带 ../ 的 key 会让桶里出现谁都对不上的路径，宁可直接拒。
                raise ValueError(f"refusing suspicious path in chat-dist.zip: {info.filename}")
            body = zf.read(info)
            cache = _NO_CACHE if name in ("index.html", "config.json") else (
                _IMMUTABLE if name.startswith("assets/") else _NO_CACHE)
            s3.put_object(Bucket=site, Key=name, Body=body,
                          ContentType=_content_type(name), CacheControl=cache)
            written.add(name)
    print(f"published {len(written)} object(s) to s3://{site}")

    # prune：删掉这一版里没有的旧文件（否则上一版的 assets/*.js 会永远留着）。
    # config.json 永远豁免 —— 它不在 zip 里，是下面单独写的运行时配置（团队规定：
    # 任何清理动作都必须显式排除它）。
    stale = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=site):
        for o in page.get("Contents", []):
            if o["Key"] not in written and o["Key"] != "config.json":
                stale.append({"Key": o["Key"]})
    for i in range(0, len(stale), 1000):
        s3.delete_objects(Bucket=site, Delete={"Objects": stale[i:i + 1000], "Quiet": True})
    if stale:
        print(f"pruned {len(stale)} stale object(s): {[o['Key'] for o in stale[:20]]}")
    return len(written)


def _write_config(props) -> None:
    # ConfigJson 由模板算好传进来（里面是 BFF Function URL、Cognito 三个 id、RUM 等
    # 资源的真值）。这里只负责落盘，不参与拼装 —— 拼装逻辑在 web-chat-core.ts，
    # 两条部署路径共用同一份，避免两边漂移。
    s3.put_object(Bucket=props["SiteBucket"], Key="config.json",
                  Body=props["ConfigJson"].encode(),
                  ContentType="application/json; charset=utf-8", CacheControl=_NO_CACHE)
    print("wrote config.json")


def _merge_missing_models(existing, catalog):
    """把目录里有、库里没有的模型条目补进去，返回 `(合并后的列表, 新增的 alias)`。

    **只增不改**：库里已有的条目逐字段照抄（绝不重新启用、改标签、换 model_id），
    库里有而目录里没有的留在末尾；唯一的改动是把缺的按目录顺序插进去。
    与 `scripts/seed_llm_catalog.py::merge_missing_models` 是同一份逻辑的两份实现
    （一键路径 import 不到仓库脚本），由 `scripts/test_oneclick_parity.py` 钉住。
    """
    by_alias = {m.get("alias"): m for m in existing if isinstance(m, dict)}
    merged, added = [], []
    for entry in catalog:
        alias = entry.get("alias")
        if alias in by_alias:
            merged.append(by_alias[alias])
        else:
            merged.append(entry)
            added.append(alias)
    known = {e.get("alias") for e in catalog}
    merged.extend(m for m in existing
                  if isinstance(m, dict) and m.get("alias") not in known)
    return merged, added


def _default_model_drift(item, cfg):
    """种子里的 `default_model` 与库里不一致时返回它，否则返回 None。

    只返回**写得进去**的值：alias 必须在目录里、且 enabled（`enabled: False` 的
    默认模型等于把这个 surface 变成没有可用模型）。

    与 `scripts/seed_llm_catalog.py::default_model_drift` 一一对应（一键路径不能
    import 这个仓库），由 `scripts/test_oneclick_parity.py` 保证两边不漂。
    """
    seed_default = cfg.get("default_model")
    if not seed_default or seed_default == item.get("default_model"):
        return None
    hit = next((m for m in cfg.get("models") or []
                if isinstance(m, dict) and m.get("alias") == seed_default), None)
    if hit is None or not hit.get("enabled"):
        return None
    return seed_default


def _top_up_llm_catalog(table, cfg) -> str:
    """目录已存在时，把升级允许同步的东西同步过去。

    为什么必须有这一步：条件写让"已存在"成为每次升级的常态路径，于是首次部署之后
    再改 `config/llm-model-catalog.json` 的东西**永远到不了已经装好的环境**。
    两类漂移，都是"不报错、只是不对"：

    1. **目录里新增的模型** —— 症状是管理台「模型」页和聊天的模型选择器缺了它，
       客户合理地以为"这功能没做"。2026-08-27 现网实际发生：`zai-glm-5` 前一天
       进了目录，列表里没有。
    2. **`default_model`** —— 2026-09-02 现网实际发生：目录默认从 `claude-sonnet-5`
       换成 `xai-grok-4-6`，`xai-grok-4-6` 确实被补进了模型列表，而默认**还停在
       Sonnet 5**。旧代码只写 `models`，理由是"新模型绝不能顺手变成默认模型" ——
       那个理由今天依然成立，而这里做的**不是**那件事：写进去的是目录**声明**的
       默认值，不是"刚补进来的那个"。这个坑之所以难查：其它每个槽位
       （`/notiops/agent/model_id` SSM 参数、health-checker 的 `BEDROCK_MODEL_ID`）
       都跟着改了 —— 从 CLI 看整个环境是一致的，只有 web 聊天还开在 Sonnet 5。

    两类都以 `generation == 0` 为闸门（已 seed、从未被管理员编辑过）。管理员一保存
    这页就归他管：他可能是**故意**没留某个模型、或**故意**选了别的默认模型，一次升级
    把它改掉跟覆盖整份配置是同一类缺陷。那种情况只打印"本来会改什么"，把决定权留给他
    —— 这里静默无动作正是上面两个缺陷都难发现的原因。
    """
    item = table.get_item(Key={"PK": "llmcfg", "SK": "meta"}).get("Item") or {}
    merged, added = _merge_missing_models(item.get("models") or [],
                                         cfg.get("models") or [])
    new_default = _default_model_drift(item, cfg)
    if not added and not new_default:
        print("llm catalogue already present and complete; left untouched")
        return "already present"

    pending = list(added) + ([f"default_model -> {new_default}"] if new_default else [])
    gen = item.get("generation")
    if gen is not None and int(gen) != 0:
        print(f"llm catalogue edited in console (generation={int(gen)}); "
              f"not applying {pending}")
        return f"already present (admin-managed; {len(pending)} not applied)"

    # 只写漂了的那几个属性：credential_mode / backend_tasks 和库里每一条模型
    # 条目都保持原样。
    sets, names, values = [], {}, {":zero": 0}
    if added:
        sets.append("#m = :m")
        names["#m"] = "models"
        values[":m"] = merged
    if new_default:
        sets.append("#d = :d")
        names["#d"] = "default_model"
        values[":d"] = new_default
    try:
        table.update_item(
            Key={"PK": "llmcfg", "SK": "meta"},
            UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_not_exists(generation) OR generation = :zero",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            print(f"llm catalogue edited concurrently; not applying {pending}")
            return "already present (raced; nothing applied)"
        raise
    print(f"llm catalogue topped up: applied {pending}")
    return f"topped up ({len(pending)} changes)"


def _seed_llm_catalog(props) -> str:
    """把内置模型目录写进 `notiops-config`（`PK=llmcfg / SK=meta`），只在它还不存在时写。

    这是 `setup.sh` 里 `scripts/seed_llm_catalog.py` 那一步在一键路径上的对应物。
    缺了它的后果不是"报错"而是**静默降级**：`GET /api/admin/llm` 返回
    `models: []` / `seeded: false`，管理员打开「管理 → 模型」看到的是一张**空表**
    （连打包进程序的那些默认模型都不在），只有聊天还能用 —— 因为前端有一份内置兜底
    目录。实测撞到过（2026-08-26，一个方式 A 部署出来的环境）。
    两条部署路径的 web 功能必须一致，这一条属于"部署时的数据种子"这个维度，
    判据在 `scripts/test_oneclick_parity.py::test_deploy_time_seeds_match`。

    目录 JSON 由模板在 synth 期内联进属性（已剥掉 `_` 开头的中文注释键，纯 ASCII，
    ~3.5KB），所以这里不需要联网、也不需要读 S3。

    **条件写**（`attribute_not_exists(PK)`）与 seeder 脚本口径一致：管理员在控制台里
    改过的配置绝不能被一次栈升级覆盖回出厂值。已存在 = 成功，不是失败 ——
    但"已存在"要走 `_top_up_llm_catalog()` 把后来新增的模型补上（只增不改），
    否则新模型永远到不了已经装好的环境。
    """
    raw = props.get("LlmCatalog") or ""
    table = props.get("ConfigTable") or ""
    if not raw or not table:
        return "skipped (no LlmCatalog/ConfigTable)"
    # DynamoDB 不收 float。目录里当前全是整数，但用 Decimal 解析可以让将来有人加一个
    # 小数字段时不至于在部署时炸掉。
    cfg = json.loads(raw, parse_float=Decimal)
    item = {**cfg, "PK": "llmcfg", "SK": "meta"}
    # generation 0 = "已 seed，从未被管理员编辑过"。读侧接受它，BFF 的 nextGeneration()
    # 把 0 当作"没有可用的上一版"，所以管理员第一次保存不会撞版本冲突。
    item.setdefault("generation", 0)
    ddb_table = boto3.resource("dynamodb").Table(table)
    try:
        ddb_table.put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return _top_up_llm_catalog(ddb_table, cfg)
        raise
    n = len(cfg.get("models") or [])
    print(f"seeded llm catalogue: {n} model(s), default={cfg.get('default_model')!r}")
    return f"seeded ({n} models)"


def _invalidate(props) -> None:
    dist = props.get("DistributionId") or ""
    if not dist:
        return
    cf = boto3.client("cloudfront")
    cf.create_invalidation(DistributionId=dist, InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": ["/*"]},
        # CallerReference 必须每次不同；用 CFN 的 RequestId（同一次请求内幂等）。
        "CallerReference": props["_CallerReference"],
    })
    print(f"invalidated {dist} /*")


# 第一个管理员的**用户名**。刻意不是邮箱：User Pool 把 email 配成了别名
# （`signInAliases: { username: true, email: true }` → AliasAttributes=[email]），
# 而 Cognito 规定别名池里的 username **不能是邮箱形状** ——
# 传邮箱当 username 会得到 `InvalidParameterException: Username cannot be of email
# format, since user pool is configured for email alias`（实测，整栈 ROLLBACK）。
# 用 `admin` 还有一层好处：与 setup.sh:1316 那条路径建的用户同名，两条部署路径
# 长出来的账号是同一个，客户看到的登录名不会因为选了哪种部署方式而不同。
# 邮箱进 email 属性 —— 别名照样能用邮箱登录，邀请邮件也发到那里。
_ADMIN_USERNAME = "admin"


def _create_admin(props) -> str:
    """建第一个管理员并放进 admin 组。密码由 Cognito 生成并邮件下发。

    本函数**从不**接触密码：不传 TemporaryPassword、不读、不打印、不放 Outputs。
    只在 Create 阶段跑 —— Update 时重跑会给一个已存在的用户重发邮件（噪音），
    而删用户/改密码更不该由部署流程做。
    """
    email = (props.get("AdminEmail") or "").strip()
    pool = props["UserPoolId"]
    if not email:
        return "skipped (no AdminEmail)"
    idp = boto3.client("cognito-idp")
    try:
        idp.admin_create_user(
            UserPoolId=pool, Username=_ADMIN_USERNAME,
            UserAttributes=[{"Name": "email", "Value": email},
                            {"Name": "email_verified", "Value": "true"}],
            DesiredDeliveryMediums=["EMAIL"],
        )
        print(f"created admin user {_ADMIN_USERNAME!r}; Cognito emailed the temporary password")
    except idp.exceptions.UsernameExistsException:
        # 幂等：栈删了重建、或客户之前跑过 setup.sh。已存在就只补组，**不改邮箱、
        # 不重设密码** —— 那会把一个在用的账号打乱，且不是部署流程该做的事。
        print(f"admin user {_ADMIN_USERNAME!r} already exists; only ensuring group membership "
              "(its email address is left untouched)")
    idp.admin_add_user_to_group(UserPoolId=pool, Username=_ADMIN_USERNAME, GroupName="admin")
    print("added admin user to the 'admin' group")
    return "ok"


def _teardown_site(props) -> dict:
    """删栈清理。分两级：

      · 总是做 —— 清空网站桶与 staging 桶（DESTROY 的桶非空就删不掉，会卡住删栈）；
        删掉本次部署自己那几个日志组（它们是**计算资源的附属物**，不是客户数据）。
      · TeardownMode=DeleteEverything 才做 —— 删数据桶与两张表（它们是
        `DeletionPolicy: Retain`，CFN 不会碰，只有这里会）。默认 KeepData 就是靠
        「这里不动它们」+ Retain 共同兑现的。

    两级的失败处理**故意不一样**：
      · 数据类（桶/表）出错一律上抛 → 栈进 DELETE_FAILED。客户明确要求"全删"，
        悄悄留下数据比卡住更糟。
      · 日志组出错只记 WARN → 它们是空容器、不产生费用，为了一个日志组把删栈卡死
        不划算。留下的孤儿会写进删栈报告（Outputs 里的清理说明）。
    """
    mode = props.get("TeardownMode", "KeepData")
    report = {"Mode": mode}

    report["SiteObjectsDeleted"] = str(_empty_bucket(props["SiteBucket"]))
    report["StagingObjectsDeleted"] = str(_empty_bucket(props["StagingBucket"]))

    logs = boto3.client("logs")
    for name in json.loads(props.get("LogGroupNames") or "[]"):
        try:
            logs.delete_log_group(logGroupName=name)
            print(f"deleted log group {name}")
        except Exception as exc:  # noqa: BLE001
            print(f"WARN could not delete log group {name}: {exc!r}")

    if mode != "DeleteEverything":
        print("TeardownMode=KeepData — the config/session tables and the data bucket are kept")
        return report

    data_bucket = props.get("DataBucket") or ""
    if data_bucket:
        _empty_bucket(data_bucket)
        _delete_bucket(data_bucket)
    ddb = boto3.client("dynamodb")
    for table in json.loads(props.get("TableNames") or "[]"):
        try:
            ddb.delete_table(TableName=table)
            print(f"deleted table {table}")
        except Exception as exc:  # noqa: BLE001
            if not _ignore_missing(exc):
                raise
    # 这几个 secret 都不是栈内资源，CFN 完全不知道它们存在，而 DeleteEverything 承诺
    # "不留东西"，所以必须在这里收尾：
    #   · notiops/bedrock-api-key —— 管理员在 Admin「模型」页选「API Key」凭证方式时
    #     由 BFF 按需 CreateSecret（见 bff/web-chat/llm_config.mjs）；
    #   · notiops/im-bot-feishu —— 装了 IM（InstallOption=web+feishu）时，管理控制台
    #     「集成 IM」页保存凭证时由 BFF 建；
    #   · notiops/slack-* —— 装了 web+slack 时客户按文档手建（Slack 侧没有在控制台里
    #     填的入口，见 docs/IM_WEBHOOK_SETUP.md §2.2）。
    # 名字**无条件**全列（模板侧同理），因为客户可能装过 IM 又改回只装 web：那时
    # 凭证还在账号里，而属性里若没有它就永远删不掉了。
    # 用 ForceDeleteWithoutRecovery：默认的 30 天恢复期会让同账号同区重装时
    # CreateSecret 撞 InvalidRequestException（"scheduled for deletion"），
    # 而这是"客户明确要求全删"的路径。`setup.sh` 那条路径由 teardown.sh 做同一件事。
    sm = boto3.client("secretsmanager")
    for name in json.loads(props.get("SecretNames") or "[]"):
        try:
            sm.delete_secret(SecretId=name, ForceDeleteWithoutRecovery=True)
            print(f"deleted secret {name}")
        except Exception as exc:  # noqa: BLE001
            # 绝大多数情况下它根本不存在（客户从没用过 API Key 模式）—— 那是正常的，
            # 不该把删栈卡在 ResourceNotFoundException 上。
            if not _ignore_missing(exc):
                raise
    report["DeletedEverything"] = "true"
    return report


# ── Phase=OrgSetup：多账号（Organizations）落地 ───────────────────────────────
# 只在客户在参数页选了 MultiAccount 时才存在（模板侧带 Condition）。做两件事：
#   1. 打开 StackSets 的组织信任访问（Organizations 那个开关没有任何 CFN 资源可用）；
#   2. 建/更新两个 service-managed StackSet —— 成员账号只读角色、成员账号 DevOps Agent。
#
# 为什么 StackSet 不用原生 `AWS::CloudFormation::StackSet` 资源，而在这里调 API：
#   · 成员账号是客户之后在 Admin「账户」页逐个接入的（BFF 调 CreateStackInstances），
#     那些实例对 CFN 而言是**栈外**的。原生资源在删栈时会尝试删掉整个 StackSet，
#     而带实例的 StackSet 删不掉 → DELETE_FAILED，客户接入了 20 个账号之后就再也
#     删不掉这个栈了。这是不可接受的失败模式。
#   · 成员接入 StackSet 还开着 auto-deployment（新账号进组织自动下发），实例会自己长出来，
#     更加不可能让 CFN 去对账。
#   · setup.sh 那条路径也是用 API 建的（setup.sh §2/§2b），两条路径行为一致。
# 代价：删栈时这两个 StackSet 会**留下**。这是刻意的 —— 删它们要先删掉全部实例，
# 也就是抹掉客户各成员账号里的跨账号角色，那是一次跨账号的破坏性操作，不能由
# 「删掉一个栈」隐式触发。文档里明说要手工清理。
_STACKSETS_SERVICE_PRINCIPAL = "member.org.stacksets.cloudformation.amazonaws.com"


def _enable_stacksets_trusted_access() -> str:
    """打开 Organizations 对 StackSets 的信任访问（幂等）。

    **失败不抛**：委派管理员（delegated administrator）账号没有 organizations:*
    的写权限，但那种账号本来就是「管理账号已经打开过」才可能存在的。真的没打开时，
    下一步 CreateStackSet 会带着 CFN 自己的报错失败，比在这里猜错要清楚。
    """
    org = boto3.client("organizations")
    try:
        for page in org.get_paginator("list_aws_service_access_for_organization").paginate():
            for sp in page.get("EnabledServicePrincipals") or []:
                if sp.get("ServicePrincipal") == _STACKSETS_SERVICE_PRINCIPAL:
                    return "already enabled"
    except ClientError as exc:  # noqa: PERF203
        print(f"list_aws_service_access_for_organization failed: {_err_code(exc)}")
    try:
        org.enable_aws_service_access(ServicePrincipal=_STACKSETS_SERVICE_PRINCIPAL)
        return "enabled"
    except ClientError as exc:
        code = _err_code(exc)
        print(f"enable_aws_service_access failed: {code}")
        return f"not enabled by us ({code}); assuming the management account already did it"


def _err_code(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return exc.response.get("Error", {}).get("Code") or "ClientError"
    return type(exc).__name__


def _stackset_upsert(cfn, name: str, template: str, params: dict, description: str,
                     auto_deployment: bool) -> str:
    """建或更新一个 service-managed StackSet。已存在就更新（升级时把新版模板滚到
    全部既有实例，成员账号的新增只读权限就是这么下去的）。

    更新失败**不抛**：最常见的原因是「有 operation 正在跑」，而那不该让客户整个栈
    更新回滚 —— 与 setup.sh 同一取舍（那边也是打一条 ⚠ 就继续）。
    """
    parameters = [{"ParameterKey": k, "ParameterValue": v} for k, v in sorted(params.items())]
    try:
        cfn.describe_stack_set(StackSetName=name)
        exists = True
    except ClientError as exc:
        if _err_code(exc) not in ("StackSetNotFoundException", "ValidationError"):
            raise
        exists = False

    if not exists:
        auto = ({"Enabled": True, "RetainStacksOnAccountRemoval": False}
                if auto_deployment else {"Enabled": False})
        try:
            cfn.create_stack_set(
                StackSetName=name, Description=description, TemplateBody=template,
                Parameters=parameters, Capabilities=["CAPABILITY_NAMED_IAM"],
                PermissionModel="SERVICE_MANAGED", AutoDeployment=auto,
            )
        except ClientError as exc:
            code = _err_code(exc)
            # 这里失败**必须**让栈失败（选了多账号却没建成，静默降级=客户以为跨账号能用）。
            # 但错误得说人话：绝大多数是"这个账号不是管理账号 / 委派管理员"，原始
            # AccessDenied 完全看不出该去改什么。
            if code in ("AccessDenied", "AccessDeniedException", "ValidationError"):
                raise RuntimeError(
                    f"cannot create StackSet {name} ({code}). DeployMode=MultiAccount requires this "
                    "account to be the AWS Organizations management account or a CloudFormation "
                    "StackSets delegated administrator. Redeploy with DeployMode=SingleAccount, or "
                    "run this template from an account that qualifies."
                ) from exc
            raise
        return "created"
    try:
        cfn.update_stack_set(
            StackSetName=name, Description=description, TemplateBody=template,
            Parameters=parameters, Capabilities=["CAPABILITY_NAMED_IAM"],
            # 单个坏账号不该卡住整次升级；每个账号的实际状态在 Admin「账户」页看得到。
            OperationPreferences={"RegionConcurrencyType": "PARALLEL",
                                  "FailureTolerancePercentage": 100,
                                  "MaxConcurrentPercentage": 100},
        )
        return "updated"
    except ClientError as exc:
        code = _err_code(exc)
        print(f"update_stack_set {name} failed: {code}")
        return f"update skipped ({code})"


def _org_setup(props: dict) -> dict:
    report = {"TrustedAccess": _enable_stacksets_trusted_access()}
    cfn = boto3.client("cloudformation")
    common = {"SystemAccountId": props["SystemAccountId"],
              "OrganizationId": props["OrganizationId"]}

    report["OnboardingStackSet"] = _stackset_upsert(
        cfn, props["OnboardingStackSetName"], props["OnboardingTemplateBody"],
        # 一键部署里系统账号没有 DevOps 事件总线、也没有 PHD topic，两个转发块整块跳过
        # （member-account-onboarding.yaml 里它们都是可选的），只要那个跨账号只读角色。
        {**common, "PrimaryRegion": props["PrimaryRegion"]},
        "NotiOps member account onboarding (cross-account read-only role)",
        auto_deployment=True,
    )
    report["DevOpsAgentStackSet"] = _stackset_upsert(
        cfn, props["DevOpsStackSetName"], props["DevOpsTemplateBody"], common,
        "NotiOps member DevOps Agent onboarding (agent space + trigger role)",
        # 不自动下发：成员账号的 Agent Space 有独立成本与配置，按账号在 Admin
        # 「账户」页第二步一键关联时才建实例。
        auto_deployment=False,
    )
    return report


# ── Phase=WebSearch：AgentCore Web Search Gateway ────────────────────────────
# 联网搜索是**唯一**走 AWS 原生通道的外网能力：查询文本不发给任何第三方搜索引擎
# （2026-08 起 Exa 兜底已从两条部署路径彻底移除）。AgentCore web search 没有独立 API，
# 必须经 **Gateway + web-search connector target** 调用，而这两样都**没有 CFN 资源**
# —— 所以只能由 stager 建，等价于 `setup.sh` 路径上的 scripts/provision_websearch_gateway.sh。
#
# 为什么用**手签 SigV4 + 裸 REST**，不用 boto3 客户端：
#   `mcp.connector` 这个 target 形态需要 **botocore>=1.43.36**，比它老的会直接报
#   "Unknown parameter ... connector"。Lambda 运行时自带的 botocore 版本由 AWS 决定、
#   我们控制不了，而一键模板里**不能有资产**（没法打 layer、也不能 pip 装）。
#   rest-json 协议下请求体就是入参结构本身，所以手写 JSON 与新版 boto3 发出的字节一致，
#   彻底摆脱版本依赖。签名用的 service name 是 `bedrock-agentcore`（服务模型的
#   signingName），**不是** host 前缀 `bedrock-agentcore-control`。
_AC_SIGNING_NAME = "bedrock-agentcore"
_WEBSEARCH_TOOL_ARN_SUFFIX = "tool/web-search.v1"
# target 名决定 agent 侧看到的工具名（"<target>___WebSearch"），必须与
# core/agentcore_search.py 的 `_TOOL_NAME` 默认值一致，改这里就要同时改那里。
_WEBSEARCH_TARGET_NAME = "web-search-tool"


def _ac_call(method: str, path: str, body: dict | None = None) -> dict:
    """对 bedrock-agentcore-control 发一个手签 SigV4 的 REST 请求，返回解析后的 JSON。

    失败抛 `_AgentCoreError`（带 AWS 错误码），这样调用方能用 `_ignore_missing` 判幂等。
    """
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = boto3.Session()
    region = session.region_name or "us-east-1"
    url = f"https://bedrock-agentcore-control.{region}.amazonaws.com{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json"} if data is not None else {}

    aws_req = AWSRequest(method=method, url=url, data=data, headers=headers)
    creds = session.get_credentials()
    if creds is None:
        raise _AgentCoreError("NoCredentials", 0, "no AWS credentials on the stager role")
    SigV4Auth(creds.get_frozen_credentials(), _AC_SIGNING_NAME, region).add_auth(aws_req)

    req = urllib.request.Request(url, data=data, method=method, headers=dict(aws_req.headers))
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        # 错误码在 x-amzn-errortype 头（形如 "ResourceNotFoundException:http://..."），
        # 少数情况只在 body 的 __type 里。message 可能含服务端细节，只留给日志。
        code = (exc.headers.get("x-amzn-errortype") or "").split(":")[0]
        msg = ""
        try:
            parsed = json.loads(raw)
            code = code or str(parsed.get("__type", "")).split("#")[-1]
            msg = str(parsed.get("message") or parsed.get("Message") or "")
        except ValueError:
            msg = raw[:200]
        raise _AgentCoreError(code or f"HTTP{exc.code}", exc.code, msg) from None
    return json.loads(raw) if raw.strip() else {}


def _ac_paginate(path: str, key: str = "items") -> list:
    """把一个 List* 接口翻完页。nextToken 走 querystring。"""
    out, token = [], None
    while True:
        page = _ac_call("GET", path + (f"?nextToken={urllib.parse.quote(token)}" if token else ""))
        out.extend(page.get(key) or [])
        token = page.get("nextToken")
        if not token:
            return out


def _mcp_url(gateway_url: str) -> str:
    """gatewayUrl 实测已带 /mcp 后缀，但不保证；缺了才补，避免拼出 /mcp/mcp。"""
    url = (gateway_url or "").rstrip("/")
    return url if url.endswith("/mcp") else f"{url}/mcp"


def _wait_gateway_ready(gw_id: str) -> dict:
    """轮询到 READY（或明确失败）。返回最后一次 GetGateway 的响应。

    不设"超时就抛"：Gateway 建好只要几秒，真卡住时让它把自定义资源的时间用完比让
    整栈因为一个可选能力回滚划算 —— 上层 `_websearch` 会把任何异常降级成"没有联网搜索"。
    """
    last: dict = {}
    for _ in range(40):  # 40 × 3s = 2 分钟
        last = _ac_call("GET", f"/gateways/{gw_id}/")
        status = last.get("status")
        if status == "READY":
            return last
        if status in ("FAILED", "UPDATE_UNSUCCESSFUL", "DELETING"):
            raise _AgentCoreError("GatewayNotReady", 0, f"status={status}")
        time.sleep(3)
    raise _AgentCoreError("GatewayNotReady", 0, f"still {last.get('status')} after 2 min")


def _pid_owns_gateway(pid: str) -> bool:
    """PhysicalResourceId 里编码的归属位（见 `_websearch_provision`）。"""
    return (pid or "").endswith("-own")


# 建失败的 Gateway 停在这些状态上，且**不会**自己恢复。
_GATEWAY_DEAD = ("FAILED", "UPDATE_UNSUCCESSFUL")


def _wait_targets_gone(gw_id: str) -> None:
    """等 target 真的消失，再去删 Gateway。

    删 target 和删 Gateway 一样是**异步**的：DELETE 返回成功只表示"开始删了"。紧接着
    删 Gateway 会被服务端以「还挂着 target」拒掉 —— 而删栈路径把这个异常**故意咽掉**
    （宁可留孤儿也不把栈卡在 DELETE_FAILED），于是失败是**静默**的：栈干干净净删完了，
    Gateway 还 READY 躺在账号里，跟文档承诺的"本栈建的会随栈删除"正好相反。
    实测就是这么漏的一个（target 已删掉、gateway 留着）。
    """
    for _ in range(40):  # 40 × 3s = 2 分钟
        if not _ac_paginate(f"/gateways/{gw_id}/targets/"):
            return
        time.sleep(3)
    raise _AgentCoreError("TargetsStillDeleting", 0, "gateway targets did not go away in 2 min")


def _delete_gateway(gw_id: str) -> None:
    """删掉一个 Gateway（有 target 时删不掉，所以先清 target 并等它真的没了）。缺了就算删过。"""
    for t in _ac_paginate(f"/gateways/{gw_id}/targets/"):
        try:
            _ac_call("DELETE", f"/gateways/{gw_id}/targets/{t['targetId']}/")
        except Exception as exc:  # noqa: BLE001
            if not _ignore_missing(exc):
                raise
    _wait_targets_gone(gw_id)
    # target 都没了还可能撞上服务端的收敛窗口，重试两次再认输。
    for attempt in range(3):
        try:
            _ac_call("DELETE", f"/gateways/{gw_id}/")
            return
        except Exception as exc:  # noqa: BLE001
            if _ignore_missing(exc):
                return
            if attempt == 2:
                raise
            time.sleep(5)


def _wait_gateway_gone(gw_id: str) -> None:
    """等到 GetGateway 报「没有这个东西」。

    删除是异步的，而同名 Gateway 并存会让紧接着的 CreateGateway 撞名字失败，
    所以必须等它真的消失再建。
    """
    for _ in range(40):  # 40 × 3s = 2 分钟
        try:
            _ac_call("GET", f"/gateways/{gw_id}/")
        except Exception as exc:  # noqa: BLE001
            if _ignore_missing(exc):
                return
            raise
        time.sleep(3)
    raise _AgentCoreError("GatewayStillDeleting", 0, "dead gateway did not go away in 2 min")


def _websearch_provision(props: dict, state: dict) -> dict:
    """幂等建好 Gateway + web-search target。返回 report；归属写进 `state["owned"]`。

    `owned` = 这个 Gateway 是**本栈建的**（而不是复用同账号里 `setup.sh` 留下的同名
    Gateway）。它编码进 PhysicalResourceId，删栈时据此决定删不删 —— 删掉客户另一条
    部署路径的 Gateway 属于跨部署的破坏性操作，不能由「删这个栈」隐式触发。
    归属用**入参 state 就地写**而不是返回值：建完 Gateway 之后的任何一步失败都会把这个
    函数抛出去，那时调用方仍必须知道"Gateway 已经是我们的了"，否则删栈会漏掉它。
    Update 时沿用上一次的归属（此时按名字找到的正是我们自己建的那个），
    否则 own→reuse 一漂移，删栈就漏清理。
    """
    name = props["GatewayName"]
    target_name = props.get("TargetName") or _WEBSEARCH_TARGET_NAME

    gw_id = next((g.get("gatewayId") for g in _ac_paginate("/gateways/")
                  if g.get("name") == name), None)
    # 同名 Gateway 停在 FAILED 上时**不能**复用：它不会自己恢复，而按名字复用会让
    # 「第一次建失败」永久化 —— 之后每次 update 都在同一个死 Gateway 上等 READY，客户
    # 除了手工去删没有别的出路。FAILED 的 Gateway 服务不了任何请求（另一条部署路径也
    # 一样用不了它），所以删掉重建不会毁掉任何还在工作的东西。
    if gw_id and (_ac_call("GET", f"/gateways/{gw_id}/").get("status") in _GATEWAY_DEAD):
        print(f"replacing dead web-search gateway {gw_id}")
        _delete_gateway(gw_id)
        _wait_gateway_gone(gw_id)
        gw_id = None
    if gw_id:
        report = {"Gateway": f"reused {gw_id}"}
    else:
        created = _ac_call("POST", "/gateways/", {
            "name": name,
            "roleArn": props["ServiceRoleArn"],
            "protocolType": "MCP",
            "authorizerType": "AWS_IAM",
            "description": "NotiOps web search (AWS-native, queries stay in AWS)",
            "tags": {"auto-delete": "no", "project": "notiops"},
        })
        gw_id = created["gatewayId"]
        state["owned"] = True
        report = {"Gateway": f"created {gw_id}"}

    gw = _wait_gateway_ready(gw_id)

    targets = _ac_paginate(f"/gateways/{gw_id}/targets/")
    if any(t.get("name") == target_name for t in targets):
        report["Target"] = f"reused {target_name}"
    else:
        # `connector` 形态见本节顶部注释（为什么不能用 boto3 客户端建）。
        # parameterValues 留空 = 用连接器默认参数；凭证走 Gateway 自己的服务角色。
        tgt = _ac_call("POST", f"/gateways/{gw_id}/targets/", {
            "name": target_name,
            "description": "AWS-native web search",
            "targetConfiguration": {"mcp": {"connector": {
                "source": {"connectorId": "web-search"},
                "configurations": [{"name": "WebSearch", "parameterValues": {}}],
            }}},
            "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
        })
        report["Target"] = f"created {tgt.get('targetId')}"

    report["GatewayUrl"] = _mcp_url(gw.get("gatewayUrl", ""))
    report["GatewayId"] = gw_id
    return report


# Gateway 建不出来时给 runtime 的占位值。**不能给空串** —— AgentCore Runtime 拒绝
# 空字符串的环境变量，而这里已经在部署中途，回不了头去把这个 key 整个删掉。
# agent 侧 `core/agentcore_search.py` 只认 https:// 开头的值，所以这个占位等价于"未配置"。
_WEBSEARCH_UNAVAILABLE = "unavailable"


def _websearch(props: dict, prior_pid: str) -> tuple[dict, str]:
    """Phase=WebSearch 的 Create/Update。返回 (Data, PhysicalResourceId)。

    **绝不抛**：联网搜索是可选能力，它挂了不该把整栈拖回滚（客户会失去全部其它功能，
    却只因为界面上一个开关不能用）。失败就降级成"这个部署没有联网搜索"，理由回在
    `Status` 里 —— 栈的 `WebSearchStatus` 输出直接给客户看。
    """
    state = {"owned": _pid_owns_gateway(prior_pid)}
    try:
        report = _websearch_provision(props, state)
        report["Status"] = "enabled"
    except Exception as exc:  # noqa: BLE001
        # 只记错误类型/AWS 错误码，不记服务端原文（团队日志规范）。
        code = exc.code if isinstance(exc, _AgentCoreError) else type(exc).__name__
        print(f"websearch provisioning failed: {code}")
        report = {"Status": f"unavailable ({code})", "GatewayUrl": _WEBSEARCH_UNAVAILABLE}
    pid = f"notiops-stager-WebSearch-{'own' if state['owned'] else 'reuse'}"
    return report, pid


def _teardown_websearch(props: dict, prior_pid: str) -> dict:
    """删栈：只删**本栈建的** Gateway（见 `_websearch_provision` 的 owned）。

    Gateway 有 target 时删不掉，所以先删干净 target 再删 Gateway。任何一步失败都只
    记一笔就返回 —— 删栈阶段抛异常会把栈卡在 DELETE_FAILED，比留一个孤儿 Gateway 糟得多
    （孤儿带着 `project=notiops` 标签，客户找得到）。
    """
    if not _pid_owns_gateway(prior_pid):
        return {"LeftInPlace": "web-search gateway was pre-existing (not created by this stack)"}
    name = props["GatewayName"]
    try:
        gw_id = next((g.get("gatewayId") for g in _ac_paginate("/gateways/")
                      if g.get("name") == name), None)
        if not gw_id:
            return {"DeletedGateway": "already gone"}
        _delete_gateway(gw_id)
        return {"DeletedGateway": gw_id}
    except Exception as exc:  # noqa: BLE001
        if _ignore_missing(exc):
            return {"DeletedGateway": "already gone"}
        code = exc.code if isinstance(exc, _AgentCoreError) else type(exc).__name__
        print(f"websearch teardown failed: {code}")
        return {"DeletedGateway": f"failed ({code}) — delete it by hand if you care"}


# ── 入口 ────────────────────────────────────────────────────────────────────
def handler(event, context):
    # 打日志时剔掉 ResponseURL（里面带签名），其余属性都不含敏感值。
    print(json.dumps({k: v for k, v in event.items() if k != "ResponseURL"}, default=str))
    props = dict(event.get("ResourceProperties") or {})
    props["_CallerReference"] = event["RequestId"]
    phase = props.get("Phase", "?")
    rt = event["RequestType"]
    # PhysicalResourceId 跨 Update 保持不变 —— 变了 CFN 会在 Update 之后再发一个
    # Delete（把刚建好的东西清掉）。用栈内固定串，不用 log stream 名。
    pid = f"notiops-stager-{phase}"
    prior_pid = event.get("PhysicalResourceId") or ""
    try:
        if rt == "Delete":
            if phase == "Site":
                data = _teardown_site(props)
            elif phase == "WebSearch":
                data = _teardown_websearch(props, prior_pid)
                pid = prior_pid or pid
            elif phase == "OrgSetup":
                # 什么都不做，两条都是刻意的：
                #   · 信任访问是**组织级**开关，组织里与 NotiOps 无关的 StackSet 也靠它，
                #     删我们的栈就把它关掉会打断别人的部署；
                #   · StackSet 要先删掉全部实例才删得掉，而那等于抹掉客户各成员账号里的
                #     跨账号角色 —— 跨账号的破坏性操作不能由「删一个栈」隐式触发。
                data = {"LeftInPlace": "trusted access + member StackSets (delete them by hand "
                                       "if you also want the member-account roles gone)"}
            else:
                data = {"StagingObjectsDeleted": str(_empty_bucket(props["StagingBucket"]))}
        elif phase == "Artifacts":
            data = _artifacts_upsert(props)
        elif phase == "WebSearch":
            data, pid = _websearch(props, prior_pid)
        elif phase == "OrgSetup":
            data = _org_setup(props)
        elif phase == "Site":
            n = _publish_frontend(props)
            _write_config(props)
            # Create 与 Update 都跑：条件写自己保证不覆盖管理员改过的配置，而在 Update
            # 上也跑，是为了让"升级到带这个修复的版本"能把种子补进那些**已经建好、
            # 目录还是空**的存量栈（Site 阶段带 ReleaseTag，每个 release 都会收到 Update）。
            seeded = _seed_llm_catalog(props)
            _invalidate(props)
            admin = _create_admin(props) if rt == "Create" else "skipped (update)"
            data = {"ObjectsPublished": str(n), "Admin": admin, "LlmCatalog": seeded}
        else:
            raise ValueError(f"unknown Phase: {phase!r}")
        _send(event, context, "SUCCESS", data, physical_id=pid)
    except Exception as exc:  # noqa: BLE001
        # 吞掉异常会让「栈创建成功但东西没搬」——那种失败要等到用户打开页面才暴露。
        print(f"FAILED phase={phase} type={rt}: {exc!r}")
        _send(event, context, "FAILED", reason=repr(exc), physical_id=pid)
