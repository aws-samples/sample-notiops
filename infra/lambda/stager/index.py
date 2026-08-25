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
import urllib.request
import zipfile
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


def _ignore_missing(exc: Exception) -> bool:
    """只吞「本来就不存在」这一类错误（幂等重试用），其余一律上抛。"""
    if not isinstance(exc, ClientError):
        return False
    return exc.response.get("Error", {}).get("Code") in {
        "NoSuchBucket", "NoSuchKey", "404", "NotFound",
        "ResourceNotFoundException", "UserNotFoundException",
    }


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
    staged = {}
    for a in artifacts:
        staged[a["name"]] = _fetch_to_s3(f"{base}/{a['name']}", bucket, a["key"], a["sha256"])
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
        try:
            s3.delete_bucket(Bucket=data_bucket)
            print(f"deleted bucket {data_bucket}")
        except Exception as exc:  # noqa: BLE001
            if not _ignore_missing(exc):
                raise
    ddb = boto3.client("dynamodb")
    for table in json.loads(props.get("TableNames") or "[]"):
        try:
            ddb.delete_table(TableName=table)
            print(f"deleted table {table}")
        except Exception as exc:  # noqa: BLE001
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
    try:
        if rt == "Delete":
            if phase == "Site":
                data = _teardown_site(props)
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
        elif phase == "OrgSetup":
            data = _org_setup(props)
        elif phase == "Site":
            n = _publish_frontend(props)
            _write_config(props)
            _invalidate(props)
            admin = _create_admin(props) if rt == "Create" else "skipped (update)"
            data = {"ObjectsPublished": str(n), "Admin": admin}
        else:
            raise ValueError(f"unknown Phase: {phase!r}")
        _send(event, context, "SUCCESS", data, physical_id=pid)
    except Exception as exc:  # noqa: BLE001
        # 吞掉异常会让「栈创建成功但东西没搬」——那种失败要等到用户打开页面才暴露。
        print(f"FAILED phase={phase} type={rt}: {exc!r}")
        _send(event, context, "FAILED", reason=repr(exc), physical_id=pid)
