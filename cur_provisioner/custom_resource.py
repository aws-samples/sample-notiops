"""方式 A 的 CFN 自定义资源入口：栈创建时把 CUR 阶段一做掉。

为什么方式 A 必须走自定义资源，而不是用原生资源
------------------------------------------------
`AWS::CUR::ReportDefinition` **只在 us-east-1 这个区注册**（2026-09-20 实测：
us-west-2 / ap-northeast-1 都返回 `TypeNotFoundException`）。而一键模板只有一份、
要能在客户选的任何区里跑 —— 模板里一旦出现这个资源类型，非 us-east-1 的客户
连 `CREATE_IN_PROGRESS` 都到不了，直接在校验阶段失败。

自定义资源没有这个限制：Lambda 跑在栈所在的区，但它**自己**去连 us-east-1 的
`cur` 端点（见 `spec.CUR_API_REGION`）。这就是方式 B 里那行
`aws cur put-report-definition --region us-east-1` 的同一个道理，只是换成了 boto3。

⚠️ 这个 handler 的第一要务不是"做对"，是"一定回话"
--------------------------------------------------
CFN 自定义资源的协议是：Lambda 必须 PUT 一个响应到 `ResponseURL`。**没回话不会立刻
失败，而是让栈卡在 `CREATE_IN_PROGRESS` 直到超时（最长 1 小时）**，期间既不能改也不能
删。所以下面的 `try/except` 包住了**全部**逻辑，包括参数解析 —— 任何异常都要转成一次
FAILED 响应，绝不允许异常直接把 Lambda 打挂。
"""
from __future__ import annotations

import datetime
import json
import urllib.request

from botocore.exceptions import ClientError

from . import provision, spec

#: 跨 Update 必须保持不变，否则 CFN 会在 Update 成功之后**补发一个 Delete** 给旧 id
#: （它以为资源被替换了）。而我们的 Delete 是空操作，所以即使发生也不至于删东西 ——
#: 但栈事件里会多出一次莫名的 Delete，排障时很容易被误读成"谁把 CUR 删了"。
PHYSICAL_ID = "notiops-cur-provisioner"


def _send(event, context, status, data=None, reason=None):
    """与 `infra/lambda/preflight/index.py::_send` 同源（那份是内联单文件，无法共享）。"""
    body = json.dumps({
        "Status": status,
        "Reason": (reason or "ok")[:1000] + f" (log: {context.log_stream_name})",
        "PhysicalResourceId": PHYSICAL_ID,
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


def _reason(exc: Exception) -> str:
    """给客户看的失败原因 —— 写成「哪里不对 + 怎么办」，不是异常字符串照抄。

    ⚠️ 只放 AWS 的错误**码**和我们自己的说明，不放 `e.response` 里的 message ——
    那段文本会带上桶名、账号号之类的环境细节，而 CFN 的 Reason 是客户在控制台
    直接能看到、也会被贴进工单的地方。
    """
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code") or "ClientError"
        hints = {
            "AccessDenied":
                "the stack role is missing cur:PutReportDefinition or s3 bucket-creation "
                "permission. Re-deploy with the template unmodified, or set ProvisionCur=no "
                "and point CurTable at a CUR you already have.",
            "AccessDeniedException":
                "the stack role is missing cur:PutReportDefinition. Re-deploy with the "
                "template unmodified, or set ProvisionCur=no.",
            "BucketAlreadyExists":
                "the S3 bucket name is taken by another AWS account (S3 bucket names are "
                "globally unique). Set ProvisionCur=no and create the CUR manually.",
            "BucketAlreadyOwnedByYou":
                "this should have been treated as reuse -- please report it.",
            "DuplicateReportNameException":
                "a CUR report with this name already exists. Set ProvisionCur=no and pass "
                "its Athena table in CurTable.",
            "ReportLimitReachedException":
                "this account already has the maximum number of CUR reports (AWS limit). "
                "Set ProvisionCur=no and reuse one of them.",
        }
        return f"{code}: {hints.get(code, 'see the CloudWatch log for this function.')}"
    return f"{type(exc).__name__}: see the CloudWatch log for this function."


def handler(event, context):
    rt = event.get("RequestType", "")
    # ResponseURL 带签名（等于一次性凭证），剔掉再打日志。
    print(json.dumps({k: v for k, v in event.items() if k != "ResponseURL"}, default=str))
    try:
        if rt == "Delete":
            data = provision.on_delete()
        else:
            props = dict(event.get("ResourceProperties") or {})
            # 账号号取自 StackId 而不是 sts —— 省一条权限，而且它就是"栈所在的账号"，
            # 比调用者身份更贴题（与 preflight 的做法一致）。
            account_id = event["StackId"].split(":")[4]
            region = props.get("DeployRegion") or context.invoked_function_arn.split(":")[3]
            now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            data = provision.provision(
                account_id=account_id,
                region=region,
                table_name=props.get("ConfigTable") or provision.config_table_name(),
                now_iso=now_iso,
                report_name=props.get("ReportName") or spec.DEFAULT_REPORT_NAME,
                prefix=props.get("Prefix") or spec.DEFAULT_PREFIX,
            )
        _send(event, context, "SUCCESS", data)
    except Exception as exc:  # noqa: BLE001
        # 这里失败**就是要**让栈失败：客户明确选了 ProvisionCur=yes，建不成却让栈
        # 报成功，等于客户以为 CUR 有了、实际上成本主题永远退回 Cost Explorer ——
        # 正是仓库里「不许静默降级」那一条要防的事。
        print(f"FAILED cur-provisioner type={rt}: {exc!r}")
        _send(event, context, "FAILED", reason=_reason(exc))
