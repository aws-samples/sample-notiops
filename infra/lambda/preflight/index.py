"""一键部署的 **PreflightFn** —— 多账号资格前置检查，只在 DeployMode=MultiAccount 存在。

为什么要单独一个函数，而不是塞进 StagerFn 的又一个 Phase（2026-09-07 现网实测的账）：

    16:55:12  栈开始创建
    16:55:39  StagingBucket 建好
    16:58:46  StagerFn 才开始创建      ← 慢了 3 分半
    16:58:57  Phase=OrgSetup 抛「这个账号不是管理账号」→ 整栈回滚

  StagerFn 迟到不是偶然：它 `DependsOn` 自己角色的 `DefaultPolicy`，而那份策略里引用了
  桶 / 表 / 分发 …… 十几个资源的 ARN，于是 CFN 把它排到那些资源**之后**。也就是说
  「这个账号根本不能用多账号」这个**在第 0 秒就能判定**的事实，要等 100 多个资源建完
  才说出口。客户等了 4 分钟拿到一句话，然后看着 100 多个资源回滚。

  更糟的是那次回滚**没能自愈**：被取消的 Artifacts 上传在后台跑完了（144 MiB 的
  agent zip 在 16:59:02 落进 staging 桶），而它的 Delete 在 16:59:03 就已经清完桶了 ——
  于是 DESTROY 的桶非空，DELETE_FAILED，栈停在 ROLLBACK_FAILED 要人工收尾。
  （那个竞态由 stager 侧的 Phase=StagingCleanup + `_drain_bucket` 单独修。）

所以本函数**刻意什么都不依赖**：只有自己的日志组和一份只含 organizations /
cloudformation 组织级动作的策略。它因此能在 CFN 排序里排到最前面，30~40 秒内给出结论。

它做四件事，顺序有讲究（先验明身份，再写任何东西）：
  1. 本账号能不能驱动 service-managed StackSet —— 要么它是组织的**管理账号**
     （`DescribeOrganization.MasterAccountId`），要么它是已注册的 **StackSets 委派管理员**
     （见 `_resolve_stackset_role`）。结论以 `CallAs` 的形式返回给 CFN；
  2. 参数页填的 `OrganizationId` 是不是真的就是本账号所在组织 —— 今天全链路**没有
     任何地方**校验过它，填错的后果是成员账号信任策略里的 `aws:PrincipalOrgID` 收口到
     一个不存在的组织，接入永远失败，而现场只会说 AccessDenied；
  3. 确认 StackSets 的组织信任访问**两半**都开着（管理账号顺手打开；委派管理员只能校验，
     见 `_activate_org_access`）；
  4. 任何一条不过就 FAILED，且错误里写清「怎么办」。

📌 `CallAs` 是本函数最重要的产出，不只是一个检查结果：整条部署链路（stager 的
   `_stackset_upsert`、BFF 的 `member_accounts.mjs`、`setup.sh` / `teardown.sh`）**每一次**
   service-managed StackSet 调用都必须带上它，漏一处就会在那一处报
   `AccessDenied` 或「StackSet 不存在」。模板通过 `Fn::GetAtt` 把它接到 BFF 的
   `STACKSET_CALL_AS` 环境变量上。判定逻辑见本文件的 `_resolve_stackset_role()`。

⚠️ 委派管理员模式有一条 **AWS 侧的硬限制**，错误文案和文档都必须说清：CloudFormation
   **不会把 stack 部署到管理账号**，即使管理账号在被 target 的 OU 里。所以从 linked
   account 部署时，**管理账号自己永远无法通过 StackSet 上车** —— 那个账号只能手工部一次
   `infra/member-account-onboarding.yaml`。BFF 侧要在调用 `CreateStackInstances` **之前**
   拦住这种请求：那个调用会返回成功、操作也会变 SUCCEEDED，但目标账号里什么都不会出现。

铁律（与 stager 同源，改这个文件前先读）：
  1. **绝不打印凭证**。本函数根本不接触任何凭证。
  2. **一律回响应**。任何异常都要 send FAILED —— 不回 CFN 就干等 1 小时再失败。
  3. **Delete 什么都不做**。信任访问是**组织级**开关，组织里与 NotiOps 无关的 StackSet
     也靠它，删我们的栈就把它关掉会打断别人的部署。
"""
from __future__ import annotations

import json
import urllib.request

import boto3
from botocore.exceptions import ClientError

_STACKSETS_SERVICE_PRINCIPAL = "member.org.stacksets.cloudformation.amazonaws.com"


# ── CFN 自定义资源响应 ────────────────────────────────────────────────────────
# 与 stager 的 `_send` 逐字同源。刻意复制而不是共享：一键模板里两个函数都是**内联单文件**
# （`Code.ZipFile`），没有 layer、没有资产桶，物理上无法 import 彼此。
def _send(event, context, status, data=None, reason=None, physical_id=None):
    body = json.dumps({
        "Status": status,
        "Reason": (reason or "ok")[:1000] + f" (log: {context.log_stream_name})",
        "PhysicalResourceId": physical_id or event.get("PhysicalResourceId")
                              or "notiops-preflight",
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


def _err_code(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return exc.response.get("Error", {}).get("Code") or "ClientError"
    return type(exc).__name__


def _this_account(event) -> str:
    """从 StackId 的 ARN 里取账号号。

    不用 `sts.get_caller_identity()`：那要给角色一条额外权限，而 StackId
    （`arn:aws:cloudformation:<region>:<account>:stack/<name>/<uuid>`）本来就在事件里，
    且它就是**栈所在的账号**（也就是我们要判定的那个），比调用者身份更贴题。
    """
    return event["StackId"].split(":")[4]


# ── ① 谁能驱动 StackSet + ② 组织 id ───────────────────────────────────────────
def _is_delegated_admin(org, account: str) -> bool:
    """本账号是不是 **StackSets** 的已注册委派管理员。

    🔴 必须按 service principal 过滤。一个账号可能是**别的**服务（GuardDuty、Config …）
    的委派管理员 —— 那也会让它拿到 Organizations 只读权限，于是
    `list_delegated_administrators` 能调通、还能返回一串账号。不过滤就会把这类账号误判成
    「能用多账号」，然后在第一次 `create_stack_set` 上以 AccessDenied 收场。

    `AccessDenied` 说明它连任何服务的委派管理员都不是 → 一样返回 False，由调用方给出
    注册命令。这里**不抛**：区分「不是委派管理员」和「查不了」对客户没有意义，两者的下一步
    动作完全相同。
    """
    try:
        pages = org.get_paginator("list_delegated_administrators").paginate(
            ServicePrincipal=_STACKSETS_SERVICE_PRINCIPAL)
        for page in pages:
            for admin in page.get("DelegatedAdministrators") or []:
                if (admin.get("Id") or "") == account:
                    return True
    except ClientError as exc:
        print(f"list_delegated_administrators failed: {_err_code(exc)}")
    return False


def _resolve_stackset_role(account: str, declared_org_id: str) -> dict:
    """判定本账号用什么身份操作 service-managed StackSet，并校验组织 id。

    返回 `CallAs`：`SELF`（管理账号）或 `DELEGATED_ADMIN`（已注册的 StackSets 委派管理员）。
    两者都不是就抛 RuntimeError，错误里带上**管理账号**要跑的那条注册命令。
    """
    org = boto3.client("organizations")
    try:
        desc = org.describe_organization()["Organization"]
    except ClientError as exc:
        code = _err_code(exc)
        if code == "AWSOrganizationsNotInUseException":
            raise RuntimeError(
                "DeployMode=MultiAccount needs an AWS Organization, and this account "
                f"({account}) is not part of one. Create an organization first, or redeploy "
                "with DeployMode=SingleAccount."
            ) from exc
        raise RuntimeError(
            f"cannot verify this account's AWS Organization ({code}). DeployMode=MultiAccount "
            "needs organizations:DescribeOrganization; a service control policy or an "
            "Organizations opt-out is the usual cause. Redeploy with DeployMode=SingleAccount "
            "if you do not need cross-account access."
        ) from exc

    real_org_id = desc.get("Id") or ""
    management = desc.get("MasterAccountId") or ""
    if management == account:
        call_as = "SELF"
    elif _is_delegated_admin(org, account):
        call_as = "DELEGATED_ADMIN"
    else:
        raise RuntimeError(
            f"DeployMode=MultiAccount needs this account to be either the AWS Organizations "
            f"management account or a registered CloudFormation StackSets delegated "
            f"administrator. This account ({account}) is a plain member of organization "
            f"{real_org_id} (management account {management}). Pick one of:\n"
            f"  (a) have the management account ({management}) register this account -- one "
            f"command, then update this stack:\n"
            f"      aws organizations register-delegated-administrator "
            f"--service-principal {_STACKSETS_SERVICE_PRINCIPAL} --account-id {account}\n"
            f"  (b) deploy this template in the management account ({management}) instead;\n"
            f"  (c) redeploy here with DeployMode=SingleAccount -- NotiOps then answers "
            f"questions about this account only, and everything else works.\n"
            f"Note for (a): a delegated administrator has full deployment permissions to every "
            f"account in the organization and cannot be scoped to specific OUs."
        )
    if declared_org_id and declared_org_id != real_org_id:
        # 这条以前没人查。填错的组织 id 会被烧进成员账号的信任策略（aws:PrincipalOrgID），
        # 于是接入成员账号时 AssumeRole 永远 AccessDenied，而现场完全看不出是 id 填错了。
        raise RuntimeError(
            f"the OrganizationId parameter says {declared_org_id}, but this account's "
            f"organization is {real_org_id}. It is written into the cross-account trust "
            "policies (aws:PrincipalOrgID), so a wrong value makes every member account "
            f"fail to onboard later with AccessDenied. Update the stack with "
            f"OrganizationId={real_org_id}."
        )
    return {
        "OrganizationId": real_org_id,
        "ManagementAccountId": management,
        "CallAs": call_as,
    }


# ── ③ 信任访问的两半 ─────────────────────────────────────────────────────────
def _activate_org_access(region: str, call_as: str) -> str:
    """确认 StackSets ↔ Organizations 的信任访问开着。不是 ENABLED 就抛。

    🔴 这里有**两个独立开关**，只开一个不够（2026-08-31 由 setup.sh 侧实测钉死，
    见 setup.sh 的多账号段落）：

        Organizations 侧   organizations:EnableAWSServiceAccess
                           --service-principal member.org.stacksets.cloudformation.amazonaws.com
        CloudFormation 侧  cloudformation:ActivateOrganizationsAccess

    只开第一个时 `describe_organizations_access()` 仍然是 **DISABLED**，而
    `create_stack_set(PermissionModel="SERVICE_MANAGED")` 报
      ValidationError: You must enable organizations access to operate a service managed stack set
    实测现场最误导的一点：Organizations 侧的清单里那个 service principal **已经在了**，
    CFN 侧却是 DISABLED —— 只看第一条会以为没问题。

    一键部署此前只调了第一条（stager 的 `_enable_stacksets_trusted_access`），于是在
    「从没激活过 CFN 侧」的组织里，就算从**正确**的管理账号部署也会失败，而 stager 会把
    那个 ValidationError 误报成「这个账号不是管理账号」，把客户引到完全错的方向。

    🔴 `call_as == "DELEGATED_ADMIN"` 时**两个激活 API 都不能调**：它们是**管理账号专属**
    的。委派管理员只能校验状态（`describe_organizations_access` 收 `CallAs`），开不了这两个
    开关 —— 所以那条路径下的错误必须让客户去**管理账号**跑命令，而不是在当前账号重试。
    """
    org = boto3.client("organizations")
    cfn = boto3.client("cloudformation", region_name=region)
    notes = []
    if call_as == "SELF":
        for label, call in (
            ("organizations", lambda: org.enable_aws_service_access(
                ServicePrincipal=_STACKSETS_SERVICE_PRINCIPAL)),
            # 无参数 API（boto3 `activate_organizations_access()`），已核对官方文档。
            ("cloudformation", lambda: cfn.activate_organizations_access()),
        ):
            try:
                call()
            except ClientError as exc:
                # 不抛：已经开着的组织在某些路径上也会报错，真没开的话下面 describe 会抓住。
                notes.append(f"{label}={_err_code(exc)}")
                print(f"activate via {label} failed: {_err_code(exc)}")

    try:
        status = cfn.describe_organizations_access(CallAs=call_as).get("Status") or "UNKNOWN"
    except ClientError as exc:
        status = f"UNKNOWN ({_err_code(exc)})"
    if not status.startswith("ENABLED"):
        where = ("this account" if call_as == "SELF"
                 else "the AWS Organizations MANAGEMENT account (a delegated administrator "
                      "cannot turn these on)")
        raise RuntimeError(
            "trusted access between CloudFormation StackSets and AWS Organizations is not "
            f"active (status: {status}{'; ' + ', '.join(notes) if notes else ''}). Without it, "
            "creating a service-managed stack set fails with 'You must enable organizations "
            f"access to operate a service managed stack set'. Run these two commands from "
            f"{where}, then update the stack again:\n"
            f"  aws cloudformation activate-organizations-access --region {region}\n"
            "  aws organizations enable-aws-service-access --service-principal "
            f"{_STACKSETS_SERVICE_PRINCIPAL}"
        )
    return status


# ── 入口 ────────────────────────────────────────────────────────────────────
def handler(event, context):
    # ResponseURL 带签名，剔掉；其余属性都不含敏感值。
    print(json.dumps({k: v for k, v in event.items() if k != "ResponseURL"}, default=str))
    props = dict(event.get("ResourceProperties") or {})
    rt = event["RequestType"]
    # PhysicalResourceId 跨 Update 必须不变，否则 CFN 会在 Update 之后补发一个 Delete。
    pid = "notiops-preflight-orgs"
    try:
        if rt == "Delete":
            # `CallAs` 也要给：模板用 `Fn::GetAtt` 引它，缺了会让 Delete 之后的清理报错。
            data = {"CallAs": "SELF",
                    "LeftInPlace": "organizations trusted access (org-wide switch; other "
                                   "stack sets in this organization depend on it)"}
        else:
            account = _this_account(event)
            region = props.get("DeployRegion") or (context.invoked_function_arn.split(":")[3])
            data = _resolve_stackset_role(account, (props.get("OrganizationId") or "").strip())
            data["OrganizationsAccess"] = _activate_org_access(region, data["CallAs"])
            data["Checked"] = account
        _send(event, context, "SUCCESS", data, physical_id=pid)
    except Exception as exc:  # noqa: BLE001
        # 这里失败**就是要**让栈失败：选了多账号却建不成，静默降级 = 客户以为跨账号能用。
        # reason 直接给客户看，所以上面每一条都写成「哪里不对 + 怎么办」。
        print(f"FAILED preflight type={rt}: {exc!r}")
        _send(event, context, "FAILED", reason=str(exc) or repr(exc), physical_id=pid)
