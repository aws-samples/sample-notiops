"""CUR + Athena 阶段一的**规格唯一真源** —— 两条部署路径共用。

为什么要有这个文件
------------------
AWS 官方的 CUR → Athena 集成分两阶段，中间有 ~24h 硬性延迟：

  阶段一（本文件）：建 CUR ReportDefinition（`HOURLY` + `RESOURCES` + `Athena/Parquet`）
                    + 交付桶 + 桶策略。做完只能等。
  阶段二：AWS 首次交付后会在**同一路径下自动放一个 `crawler-cfn.yml`**
          （Glue Database + Crawler + 2 Lambda + S3 事件通知），把它部署成**另一个**
          CloudFormation 栈才真的能查 Athena。见 `lambda6_cur_finalizer/handler.py`。

阶段一原来只在 `setup.sh`（方式 B）里，用 shell 调 aws-cli 拼那串 JSON。方式 A 要自建就
必须有一份 Python 实现（一键模板里只能用内联 Lambda 的 custom resource）。
**两份各自拼一遍报告定义 = 一处改了另一处忘改**，而这种漂移的表现不是报错，是
「两条路径建出来的 CUR 字段不一样，于是同一个工具在 A 上对、在 B 上错」——
这正是 `infra/lib/constructs/im-core.ts` 文件头警告的那类隐患。

所以：**规格在这里，两边都从这里取。**
  · 方式 A：一键栈的 custom resource（`infra/lambda/cur_provisioner/`）import 本模块。
  · 方式 B：`setup.sh` 用 `python3 -m cur_provisioner.spec report-definition …` 取 JSON，
    再交给 `aws cur put-report-definition`（判据见 tests/test_cur_provisioner_parity.py）。

⚠️ 每一个字段都是有原因的，别"顺手简化"
---------------------------------------
  · `TimeUnit=HOURLY` —— 45 个成本工具里的台数/vCPU 口径是
    `SUM(usage_amount)/24`，日粒度的 CUR 会让这个除法失去意义。
  · `AdditionalSchemaElements=["RESOURCES"]` —— 少了它就没有 `line_item_resource_id`，
    资源级下钻（哪台机器、哪个卷）整块没有。
  · `AdditionalArtifacts=["ATHENA"]` —— **这一项才是让 AWS 去投放 `crawler-cfn.yml` 的开关**。
    漏了它阶段二永远等不到那个文件，而且不会有任何报错。
  · `Format/Compression=Parquet` —— Athena 上扫描量小一个数量级，而 Athena 是按扫描字节
    收费的（见 cost_mcp 的 workgroup cutoff）。
  · `RefreshClosedReports=true` —— AWS 事后修订账单（credit/退款）时会重写历史月份；
    关掉它意味着对账数字永远停在第一次交付的那一版。
  · `ReportVersioning=OVERWRITE_REPORT` —— 配合上一条：同一账期只保留一份，
    否则 Glue 表会同时看到同一个月的多个版本、金额翻倍。
"""
from __future__ import annotations

#: CUR 的 API 端点**只有 us-east-1**（它是全局服务）。无论栈部在哪个区，
#: `cur:PutReportDefinition` 都必须打这个区 —— 方式 B 的 `setup.sh` 里那行
#: `aws cur put-report-definition --region us-east-1` 是同一个道理。
#: ⚠️ 这也是方式 A 只能用 custom resource 的原因：原生资源 `AWS::CUR::ReportDefinition`
#: **只在 us-east-1 注册**（2026-09-20 实测：us-west-2 / ap-northeast-1 都是
#: `TypeNotFoundException`），而一键模板只有一份、要跑遍所有区。
CUR_API_REGION = "us-east-1"

#: 报告名与前缀。固定值而不是可配：客户升级时这两个值一变就等于换了一份 CUR
#: （旧数据留在旧路径、Glue 表指向旧前缀），而客户完全看不出发生了什么。
DEFAULT_REPORT_NAME = "notiops-cur-report"
DEFAULT_PREFIX = "cur"


def bucket_name(account_id: str, region: str) -> str:
    """CUR 交付桶名。与 `setup.sh` 里的拼法逐字相同（判据钉住）。"""
    return f"notiops-cur-{account_id}-{region}"


def report_definition(bucket: str, region: str,
                      report_name: str = DEFAULT_REPORT_NAME,
                      prefix: str = DEFAULT_PREFIX) -> dict:
    """`cur:PutReportDefinition` 的 `ReportDefinition` 入参。

    `region` 是**数据落在哪个区**（`S3Region`），不是调 API 的区（那永远是
    `CUR_API_REGION`）。
    """
    return {
        "ReportName": report_name,
        "TimeUnit": "HOURLY",
        "Format": "Parquet",
        "Compression": "Parquet",
        "AdditionalSchemaElements": ["RESOURCES"],
        "S3Bucket": bucket,
        "S3Prefix": prefix,
        "S3Region": region,
        "AdditionalArtifacts": ["ATHENA"],
        "RefreshClosedReports": True,
        "ReportVersioning": "OVERWRITE_REPORT",
    }


def bucket_policy(bucket: str, account_id: str, partition: str = "aws") -> dict:
    """CUR 交付要求的桶策略。

    ⚠️ **这份形状是从 `setup.sh` 逐字搬过来的，不是"我按官方文档重写的等价版本"。**
    原因很实在：方式 B 用这份策略建出来的 CUR **正在真实投递**（现网已验证）。
    官方文档里还有另一种写法（`2012-10-17` + `EnableAWSDataExportsToWriteToS3…` 的
    Sid 命名），语义上等价，但"语义上等价"在权限这件事上不算证据 —— 已经在投递的那
    一份才算。所以两条路径都用这一份，判据把它钉住
    （tests/test_cur_provisioner_parity.py）。

    ⚠️ `Version` 是 `2008-10-17` 而不是常见的 `2012-10-17` —— 别"顺手升级"。
    它就是现网在用的值；改它等于把一个未经验证的变更塞进客户的账单投递链路。

    两条 `Condition` 不是装饰:`aws:SourceAccount` + `aws:SourceArn` 把"谁能让
    billingreports 往这个桶写"限定到**本账号的 CUR 定义**。少了它们，这个桶就是
    「任何账号的 CUR 都能往里投递」的形状（confused deputy）。
    """
    svc = {"Service": "billingreports.amazonaws.com"}
    cond = {
        "StringEquals": {"aws:SourceAccount": account_id},
        "StringLike": {"aws:SourceArn": f"arn:{partition}:cur:{CUR_API_REGION}:{account_id}:definition/*"},
    }
    return {
        "Version": "2008-10-17",
        "Statement": [
            {"Sid": "AllowCURServiceGetAcl", "Effect": "Allow", "Principal": svc,
             "Action": ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
             "Resource": f"arn:{partition}:s3:::{bucket}",
             "Condition": cond},
            {"Sid": "AllowCURServicePutObject", "Effect": "Allow", "Principal": svc,
             "Action": "s3:PutObject",
             "Resource": f"arn:{partition}:s3:::{bucket}/*",
             "Condition": cond},
        ],
    }


if __name__ == "__main__":
    # 给 shell 用（方式 B 的 setup.sh 从这里取 JSON，而不是自己再拼一遍）：
    #   python3 -m cur_provisioner.spec report-definition <bucket> <region> [name] [prefix]
    #   python3 -m cur_provisioner.spec bucket-policy <bucket> <account-id>
    #   python3 -m cur_provisioner.spec bucket-name <account-id> <region>
    import json
    import sys

    what = sys.argv[1] if len(sys.argv) > 1 else ""
    a = sys.argv[2:]
    if what == "report-definition":
        print(json.dumps(report_definition(*a)))
    elif what == "bucket-policy":
        print(json.dumps(bucket_policy(*a)))
    elif what == "bucket-name":
        print(bucket_name(*a))
    else:
        sys.exit("usage: report-definition|bucket-policy|bucket-name ...")
