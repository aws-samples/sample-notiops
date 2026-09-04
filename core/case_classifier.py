"""
AWS Support Case classifier.

Reads the DevOps Agent investigation summary and asks Claude Haiku to pick
the right serviceCode + categoryCode + issueType from the real AWS Support
service catalog (fetched once at startup via support:DescribeServices).

The classifier is constrained to choose ONLY values that exist in the live
catalog — Claude never invents codes — so CreateCase will never reject the
classification with InvalidParameterValue. On any failure (Bedrock error,
unparseable JSON, code not in catalog) we fall back to the safe defaults
(general-info / using-aws / technical) so a case still gets opened.
"""
from __future__ import annotations

import json
import logging
import re
import threading

import boto3
from botocore.exceptions import ClientError

from core import bot_llm

logger = logging.getLogger(__name__)

# 2026-09-01：本模块那几处「一个 system prompt + 一段文本 → 一段（通常是 JSON 的）
# 文本」的调用，从手搓 Anthropic body 的 invoke_model 换成 core/bot_llm 的 Converse
# 统一入口。理由与取舍全在 core/bot_llm.py 的模块 docstring 里。
# 顺带删掉 `_bedrock` / `BEDROCK_REGION`：`invoke_llm` 每次调用自己建 client（比
# LazyClient 更不会拿到过期凭证），而 BEDROCK_REGION 在三条部署路径里恒等于
# `cdk.Aws.REGION` = Lambda 自己的区域 = boto3 默认区域，去掉是**零行为变化**。
_support = boto3.client("support", region_name="us-east-1")

# Safe fallback when classification fails. These are guaranteed to exist
# in every Support plan that supports CreateCase.
FALLBACK_SERVICE = "general-info"
FALLBACK_CATEGORY = "using-aws"
FALLBACK_ISSUE_TYPE = "technical"

_catalog_lock = threading.Lock()
_catalog: list[dict] | None = None
_catalog_index: dict[str, set[str]] | None = None


def _load_catalog() -> tuple[list[dict], dict[str, set[str]]]:
    """Load (and cache) the full Support service catalog."""
    global _catalog, _catalog_index
    with _catalog_lock:
        if _catalog is not None and _catalog_index is not None:
            return _catalog, _catalog_index
        try:
            resp = _support.describe_services(language="en")
            services = resp.get("services", [])
        except ClientError as e:
            logger.error("describe_services failed: %s", e)
            _catalog = []
            _catalog_index = {}
            return _catalog, _catalog_index

        index: dict[str, set[str]] = {}
        compact: list[dict] = []
        for s in services:
            cats = [{"code": c["code"], "name": c["name"]}
                    for c in s.get("categories", [])]
            compact.append({"code": s["code"], "name": s["name"],
                            "categories": cats})
            index[s["code"]] = {c["code"] for c in cats}

        _catalog = compact
        _catalog_index = index
        logger.info("Loaded AWS Support catalog: %d services", len(compact))
        return _catalog, _catalog_index


# Category code substrings to prefer when we need to soft-repair a
# hallucinated categoryCode by picking ANY valid one under the same
# service. Generic / catch-all categories are safer defaults than
# specific ones (e.g. an EC2 case with unknown root cause shouldn't be
# auto-routed into "billing" or "limit-increase").
_DEFAULT_CATEGORY_HINTS = (
    "general",
    "guidance",
    "usage",
    "questions",
    "other",
    "performance",
    "configuration",
    "operational",
)


def _pick_default_category(valid: set[str]) -> str | None:
    """Pick the most generic category code from a valid set. Returns None
    if nothing matches the hint list."""
    valid_list = list(valid)
    for hint in _DEFAULT_CATEGORY_HINTS:
        for code in valid_list:
            if hint in code.lower():
                return code
    return None


# 用户手打的**缩写** → 在真实目录里要找的 code 片段（按顺序，先命中先用）。
#
# 为什么必须有这张表：AWS Support 的 service code 里**根本没有** "ec2" / "s3" 这些
# 字样（EC2 是 `amazon-elastic-compute-cloud-linux`，S3 是
# `amazon-simple-storage-service`），而缩写恰恰是用户最会打的东西 —— 没有这张表，
# 「服务名称」这一栏对最常见的输入直接失效，等于白加。
#
# 表里放的是**片段而不是 code**：真正的 code 从目录里取，所以这张表过期/写错也只会
# "匹配不上"（退回分类器），绝不会编造出一个 CreateCase 拒收的 code。
# 只收录"字面不出现在 code/名字里"的缩写 —— lambda / dynamodb / cloudfront /
# redshift / sagemaker / bedrock 这些词本身就在 code 里，靠下面的词元打分就够了。
#
# 每一条都对着**现网真实目录**（`support:DescribeServices`，2026-09-03，323 个服务）
# 核对过。别凭 AWS 的产品名想当然写 —— 实测踩到的四个坑：EKS 的 code 是 `service-eks`
# 而不是 `*-elastic-kubernetes-service`；ECS 是 `ec2-container-service`；ECR 是
# `service-container-registry-ecr`；Route 53 是 `amazon-route53`（没有连字符）。
# 改这张表时请重新跑一遍 `aws support describe-services` 核对。
_SERVICE_ALIASES: dict[str, tuple[str, ...]] = {
    # 只锁到 EC2 家族，Linux / Windows / macOS 交给 `_best`：只打 "ec2" 给
    # Linux（家族主条目 + code 最短），"ec2 windows" 给 Windows 那条。
    "ec2": ("elastic-compute-cloud",),
    "s3": ("simple-storage-service",),
    # RDS 在目录里按引擎拆成十几条（mysql / postgresql / aurora / ...），没有"总"的
    # 那一条。这里只锁到 RDS 家族，具体哪条交给 `_best` 用剩下的词元挑
    # （"rds postgres" → postgresql；只打 "rds" → code 最短的那条）。
    "rds": ("relational-database-service",),
    # `eks` 这三个字母在目录里出现在三条 code 上（service-eks / -anywhere /
    # launch-wizard-eks），靠 `_best` 的"最短即最泛化"挑出 `service-eks`。
    "eks": ("eks",),
    "ecs": ("container-service",),
    "ecr": ("container-registry",),
    "efs": ("elastic-file-system",),
    "ebs": ("elastic-block-store",),
    "elb": ("elastic-load-balancing",),
    "alb": ("elastic-load-balancing",),
    "nlb": ("elastic-load-balancing",),
    "iam": ("identity-and-access-management",),
    "vpc": ("virtual-private-cloud",),
    "sqs": ("simple-queue-service",),
    "sns": ("simple-notification-service",),
    "ses": ("simple-email-service",),
    "kms": ("key-management-service",),
    "waf": ("web-application-firewall", "waf"),
    "msk": ("managed-streaming-for-kafka", "kafka"),
    "ssm": ("systems-manager",),
    "sts": ("security-token-service", "identity-and-access-management"),
    "asg": ("auto-scaling",),
    "cw": ("cloudwatch",),
    "route53": ("route53",),
    "r53": ("route53",),
    "apigw": ("api-gateway",),
    "cfn": ("cloudformation",),
    # OpenSearch 在目录里只有三条窄变体（ingestion / serverless / managed-cluster），
    # 没有"主"条目，按最短会落到 ingestion 上；用户打 "opensearch" 几乎总是指集群。
    "opensearch": ("opensearch-service-managed-cluster",),
    "elasticsearch": ("opensearch-service-managed-cluster",),
}

# 词元打分阶段要忽略的噪声词 —— "aws" / "amazon" 出现在几乎每一条 code 里，
# 留着会让 "aws 账单" 这种输入随便匹上一个服务。
_NOISE_TOKENS = frozenset({"aws", "amazon", "the", "for", "and", "with"})


def resolve_service(text: str) -> dict | None:
    """把用户**手打的服务名**（或 code）映射成目录里真实存在的一条。

    IM 面板的「服务名称」有**三条**输入路径，都汇到这个函数：
      1. 常用服务下拉（`popular_services()`）—— 选中的值就是**真实 code**，走下面
         第 1 级"code 精确命中"原样通过；
      2. 自由文本（长尾 / 缩写 / 中文夹杂）—— 走 2~4 级模糊反查；
      3. 两个都不给 → 调用方压根不调这里，交给分类器自动判断。
    下拉只放常用的那二十条，是因为真实目录 323 条装不进 Slack `static_select`
    （硬上限 100）和飞书卡片选择器；web 端有 datalist 能做"输入即搜索"，所以那边直接
    给全量目录（见 `frontend/.../Message.tsx`）。控件不同，能力等价。

    四级匹配（顺序是**精确 → 模糊**，别调）：code/名字精确 → **缩写别名**
    （`_SERVICE_ALIASES`，因为 "ec2"/"s3" 这些字样根本不在真实 code 里）→ 名字整词包含
    → 词元打分。别名必须排在"名字包含"前面：真实名字里带括号缩写（`Elastic Compute
    Cloud (EC2 - Linux)` / `Elastic Compute Cloud (EC2-macOS)`），"ec2" 靠名字包含会
    按目录顺序随便落到 macOS 那条上。

    返回 `{"code", "name", "category"}`（`category` 是该服务下一个**通用**类别，
    因为 CreateCase 要求 service + category 是合法组合，而 IM 面板不问类别）；
    匹配不上返回 `None` —— 调用方据此退回让分类器决定，**不要**硬塞一个编造的 code
    （CreateCase 会直接 `No service exists for combination` 报错）。
    """
    q = (text or "").strip().lower()
    if not q:
        return None
    catalog, index = _load_catalog()
    if not catalog:
        return None

    def _pack(entry: dict) -> dict:
        cats = index.get(entry["code"]) or set()
        return {"code": entry["code"], "name": entry["name"],
                "category": (_pick_default_category(cats)
                             or (next(iter(cats)) if cats else ""))}

    raw_toks = [t for t in re.split(r"[^a-z0-9]+", q) if t]

    def _signal(toks: list[str]) -> list[str]:
        return [t for t in toks if len(t) > 2 and t not in _NOISE_TOKENS]

    def _hits(pats: list[re.Pattern], entry: dict) -> int:
        hay = f"{entry['code']} {entry['name']}".lower()
        return sum(1 for p in pats if p.search(hay))

    def _tok_pats(toks: list[str]) -> list[re.Pattern]:
        """词元只允许命中在**词首**（`-` / 空格 / 括号都算分隔）。

        两头都卡死不行：`postgres` 得能命中 `...-service-postgresql`。只卡词首正好 ——
        既拦住 "sts" 命中 "Outposts"（前面是字母 o），又放过合理的前缀写法。
        """
        return [re.compile(rf"(?<![a-z0-9]){re.escape(t)}") for t in toks]

    def _best(cands: list[dict], toks: list[str]) -> dict | None:
        """候选里挑一条：命中的词元数 → **家族条目优先** → code 最短。

        后两级 tie-break 都是对着真实目录实测出来的（2026-09-03，323 条）：
        同一个服务在目录里往往有一堆更窄的变体，光按出现顺序取会挑错 ——
        "lambda" 落到 `lambda-edge`（该是 `aws-lambda`）、"rds" 落到
        `service-relational-database-service-db2`（该是 mysql 那条）、
        "eks" 落到 `service-launch-wizard-eks`（该是 `service-eks`）。
        AWS 给这些窄变体用的是 `service-*` 前缀，家族主条目是 `amazon-*` / `aws-*`。
        """
        pats = _tok_pats(toks)
        best, best_key = None, None
        for s in cands:
            code = s["code"].lower()
            key = (-_hits(pats, s),
                   0 if code.startswith(("amazon-", "aws-")) else 1,
                   len(code))
            if best_key is None or key < best_key:
                best, best_key = s, key
        return best

    # 1) code / 名字精确命中（大小写无关）。
    for s in catalog:
        if q in (s["code"].lower(), s["name"].lower()):
            return _pack(s)
    # 2) 缩写别名 —— "EC2" / "rds postgres" / "帮我看 s3"。整串优先，其次按用户打的
    #    顺序看每个词元（"rds mysql" 应该命中 rds，不是 mysql）。
    for key in [q.replace(" ", ""), *raw_toks]:
        for frag in _SERVICE_ALIASES.get(key, ()):
            cands = [s for s in catalog if frag in s["code"].lower()]
            if cands:
                # 用户还打了别的词就拿剩下的词元在候选里再挑一次 —— 否则
                # "rds postgres" 会落到 RDS MySQL 上。
                rest = [t for t in _signal(raw_toks) if t != key]
                return _pack(_best(cands, rest))
    # 到这儿开始都是模糊匹配了 —— 先要求整串至少有一个"有信息量"的词元，
    # 否则 "aws" / "的" 这种输入会随便命中一条。
    toks = _signal(raw_toks)
    if not toks:
        return None
    # 3) 名字**整词**包含（"elastic beanstalk" / "elastic compute cloud" 这类完整说法）。
    #    必须卡词边界：真实名字里 "Outposts" 含子串 "sts"、"IAM Identity Center" 含
    #    "iam"，纯子串匹配会把 STS / IAM 这种短查询扔到毫不相干的服务上。
    pat = re.compile(rf"(?<![a-z0-9]){re.escape(q)}(?![a-z0-9])")
    cands = [s for s in catalog if pat.search(s["name"].lower())]
    if cands:
        return _pack(_best(cands, toks))
    # 4) 词元打分 —— 兜住 "kinesis firehose"、"cloudwatch logs" 这类写法。
    #    **必须命中用户打的第一个实词**（人几乎总是先写服务名、后写限定词）。只要求
    #    "命中任意一个词"会悄悄给出错的服务：目录里没有 Cost Explorer，"cost explorer"
    #    会靠 explorer 这一个词落到 `service-resource-explorer` 上 —— 案例照样开得出来，
    #    却落在毫不相干的队伍里，正是这次要消灭的那类静默错误。匹配不上就返回 None，
    #    让分类器决定并在结果卡上明说"你填的服务没匹配到"。
    best = _best(catalog, toks)
    if best is None:
        return None
    return _pack(best) if _hits(_tok_pats(toks[:1]), best) else None


# IM 面板「服务名称」下拉里放哪些服务 —— 按"客户实际开案例最多"排的**常用**清单。
#
# ⚠️ 这里存的是**查询词而不是 code**：每一项都过一遍 `resolve_service()`，code 从
# 现网真实目录里取。所以这张表写错/过期只会让某一项"选不出来"（被静默跳过、下拉少一
# 条），**绝不会**在下拉里放一个 CreateCase 拒收的 code —— 那会让客户填得越具体越开不
# 出案例，正是最坑的失败形态。
#
# 为什么是"常用清单"而不是整个目录：真实目录 323 条，Slack `static_select` 硬上限
# 100 个选项，飞书卡片选择器同样装不下这个量级，`external_select` 又要 ingress 多认一
# 种 payload。所以 IM 端是 **下拉（常用）+ 自由文本（长尾）+ 不填就自动判断** 三条路，
# 而 web 端有 datalist 可以做"输入即搜索"，直接给全量目录（见 Message.tsx）。
# 两端不是同一个控件，但**能力等价**：常用的点一下，冷门的照样填得进去。
_POPULAR_SERVICE_QUERIES: tuple[str, ...] = (
    "ec2", "s3", "rds", "lambda", "eks", "ecs", "vpc", "iam",
    "cloudfront", "elb", "ebs", "efs", "dynamodb", "route53",
    "cloudwatch", "apigw", "sqs", "sns", "kms", "opensearch",
)

#: 下拉最多给几条。两边平台上限里取小的那个还留足余量（Slack 100 / 飞书更小），
#: 而且下拉超过二十来条人就不看了，长尾本来就该走自由文本。
POPULAR_SERVICE_LIMIT = 20


def popular_services() -> list[dict]:
    """IM 面板下拉用的常用服务清单 —— `[{"code", "name"}, ...]`，全部来自真实目录。

    目录读不到（`describe_services` 需要 Business/Enterprise 支持计划）就返回 `[]`：
    调用方**必须**据此把下拉整块去掉、只留自由文本，并在面板上说明。给一个空下拉、
    或者拿硬编码 code 顶上，都是静默降级。
    """
    catalog, _ = _load_catalog()
    if not catalog:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for q in _POPULAR_SERVICE_QUERIES:
        hit = resolve_service(q)
        # 必须有 category：没有合法类别的服务进了下拉 = 客户一选就开不出案例
        # （见 `support_logic.apply_case_overrides` 里那条同样的判断）。
        if not hit or not hit.get("code") or not hit.get("category"):
            continue
        if hit["code"] in seen:
            continue
        seen.add(hit["code"])
        out.append({"code": hit["code"], "name": hit.get("name") or hit["code"]})
        if len(out) >= POPULAR_SERVICE_LIMIT:
            break
    return out


def service_categories(service_code: str) -> list[dict]:
    """该服务名下真实存在的类别 —— `[{"code", "name"}, ...]`，顺序即目录顺序。

    目录读不到就返回 `[]`。调用方拿它做**展示**（"这个服务有哪些类别"），别拿它当
    校验依据 —— 校验走 `resolve_category_detail`，那条路保证同服务合法组合。
    """
    catalog, _ = _load_catalog()
    for s in catalog:
        if s["code"] == service_code:
            return [dict(c) for c in s["categories"]]
    return []


def resolve_category_detail(service_code: str, text: str) -> dict:
    """在 `service_code` 名下把用户打的类别映射成真实 code，并说明**怎么来的**。

    → `{"code": str, "name": str, "source": "matched" | "derived" | "none"}`
      - `matched`：用户确实打了东西，而且在**这个服务名下**找到了对应类别；
      - `derived`：没打、或打的东西这个服务名下没有 → 退回通用类别（`_pick_default_category`）；
      - `none`：这个服务在目录里没有任何类别（`code` 为空串），调用方须另作处理。

    为什么 IM 面板的「类别」是**手打**而不是像 web 那样的下拉：类别选项取决于用户
    先选了哪个服务，要联动就得在面板中途回一趟服务端重绘卡片。
      - Slack 可以：modal 的 `block_actions` 每次都带着整个 `view.state.values`，
        `views.update` 重绘不丢用户已填的任何一栏；
      - **飞书不行**：表单容器里的组件"数据为异步提交的形式 —— 用户填写完所有表单项后，
        点击绑定提交事件的按钮，才会将所有数据一次回调至服务端"
        （open.feishu.cn/document/.../card-json-v2-components/interactive-components/input）。
        也就是说选择器自己的回调**拿不到**用户已经打进去的主题/描述，中途重绘卡片
        就等于把它们清空。
    合并成一个全量下拉也不行：现网目录（2026-09-04 实测）1434 个类别 code，就算只算
    下拉里那 20 个常用服务也有 195 个，而且**几乎都是服务专属**的 —— 跨服务通用的只有
    `general-guidance`(19/20)、`feature-request`(18/20)、`apis`(15/20)、`other`(14/20)
    四个，一个拉平的清单对绝大多数选择都是非法组合。
    所以两端统一用"手打 + 服务端在该服务名下反查"，跟「服务名称」那一栏同一个套路：
    控件不同，能力等价；解析结果一律写在结果卡上（别让用户猜落到了哪个类别）。

    目录是用 `language="en"` 拉的（Support API 只支持 en / ja），所以类别名是英文 ——
    面板提示里要给英文关键词示例，中文输入匹配不上会退回通用类别并如实说明。
    """
    catalog, index = _load_catalog()
    valid = index.get(service_code) or set()
    if not valid:
        return {"code": "", "name": "", "source": "none"}

    cats = service_categories(service_code)
    names = {c["code"]: c.get("name") or c["code"] for c in cats}

    def _out(code: str, source: str) -> dict:
        return {"code": code, "name": names.get(code, code), "source": source}

    q = (text or "").strip().lower()
    if q:
        # 四级，从最确定到最宽松。候选集只有几十条，全都是 O(n) 扫描。
        for code in sorted(valid):
            if q == code.lower():
                return _out(code, "matched")
        for c in cats:
            if q == (c.get("name") or "").strip().lower():
                return _out(c["code"], "matched")
        for code in sorted(valid):
            if q in code.lower():
                return _out(code, "matched")
        for c in cats:
            if q in (c.get("name") or "").lower():
                return _out(c["code"], "matched")

    return _out(_pick_default_category(valid) or sorted(valid)[0], "derived")


def resolve_category(service_code: str, text: str) -> str:
    """在 `service_code` 名下把类别名/code 映射成真实 code；匹配不上给一个通用类别。

    **绝不跨服务挑**（CreateCase 要求同一服务下的组合），也绝不返回空串 —— 空类别
    等于非法组合。要知道"是匹配到的还是推导的"用 `resolve_category_detail`。
    """
    return resolve_category_detail(service_code, text)["code"]


def _format_catalog_for_prompt(catalog: list[dict]) -> str:
    """Render the catalog as a compact JSON-y list Claude can scan.
    Keep it tight to fit Haiku's context easily — strip names that don't
    add signal beyond the code.
    """
    lines: list[str] = []
    for s in catalog:
        cat_codes = ", ".join(c["code"] for c in s["categories"])
        lines.append(f'- "{s["code"]}" ({s["name"]}): [{cat_codes}]')
    return "\n".join(lines)


SYSTEM_PROMPT = """\
你是 AWS Support case 分类器。给定一段 DevOps Agent 的调查内容，从下方真实的
AWS Support 服务目录里，挑出最匹配的 serviceCode 和 categoryCode，并判断
issueType 是 technical 还是 customer-service。

严格规则：
1. serviceCode 必须从下方目录里**原样**复制（不能改大小写、不能编造）
2. categoryCode 必须是**该 serviceCode 名下的一个**类别 code（不能跨服务挑）
3. issueType 默认为 **"technical"**。**只有**当问题明确属于以下场景时才选
   "customer-service":
   - 账单、付款、退款问题
   - 服务限额(quota / limit)提升申请
   - 账户管理(关闭、合并、root user 重置)
   - 合同、商务、订阅级别变更
   其他所有情形(包括运维查询、性能、错误、配置、AWS 服务使用方式) → "technical"。
   含糊不清时一律按 technical 处理。
4. 如果调查内容主要围绕某个 AWS 服务（比如 EC2、S3、Lambda、RDS、Cost Explorer 等），
   就选该服务的 code（注意 EC2 区分 Linux / Windows，多数情况选 Linux 即
   "amazon-elastic-compute-cloud-linux"）
5. 如果调查跨多个服务无明确主体，可以选 "general-info"
   (注意:general-info + technical 是合法组合;technical 不要求一定是具体服务)

**严格输出 JSON**（不要 markdown 包裹），结构如下：
{
  "serviceCode": "<目录里的 code>",
  "categoryCode": "<该 service 名下的 category code>",
  "issueType": "technical" | "customer-service",
  "reason": "<一句话说明选这个分类的理由>"
}

==== AWS Support 服务目录 ====
{CATALOG}
"""


def classify(intent_summary: str, raw_text: str, summary_md: str) -> dict:
    """Pick a (serviceCode, categoryCode, issueType) for the given investigation.

    Returns a dict with keys: serviceCode, categoryCode, issueType, reason.
    On any failure, returns the safe fallback. Never raises.
    """
    fallback = {
        "serviceCode": FALLBACK_SERVICE,
        "categoryCode": FALLBACK_CATEGORY,
        "issueType": FALLBACK_ISSUE_TYPE,
        "reason": "fallback (classifier unavailable)",
    }

    catalog, index = _load_catalog()
    if not catalog or not index:
        return fallback

    investigation_blob = (
        f"用户原指令: {raw_text}\n"
        f"意图总结: {intent_summary}\n\n"
        f"调查报告(节选):\n{summary_md[:3000]}"
    )

    system = SYSTEM_PROMPT.replace("{CATALOG}",
                                   _format_catalog_for_prompt(catalog))

    text = ""
    try:
        text = bot_llm.invoke_bot_text(system, investigation_blob, max_tokens=400)
        if not text:
            return fallback
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning("Classifier JSON parse failed: %s; raw=%r", e, text[:300])
        return fallback
    except Exception as e:
        logger.warning("Classifier invocation failed: %s", e)
        return fallback

    service = (parsed.get("serviceCode") or "").strip()
    category = (parsed.get("categoryCode") or "").strip()
    issue_type = (parsed.get("issueType") or "").strip().lower()
    reason = parsed.get("reason", "")

    if service not in index:
        logger.warning("Classifier returned unknown serviceCode %r — falling back", service)
        return fallback
    # Soft repair: classifier sometimes picks a plausible-but-nonexistent
    # categoryCode under the right service (Haiku hallucinates "performance-
    # related-issues" etc.). Rather than dumping the whole classification
    # back to general-info, keep the service the user/agent intended and
    # pick a sensible default category from the same service. We prefer
    # categories whose code suggests a generic / catch-all bucket.
    if category not in index[service]:
        valid_cats = index[service]
        logger.warning("Classifier returned unknown categoryCode %r for service %r — "
                       "repairing with a same-service default", category, service)
        category = _pick_default_category(valid_cats) or next(iter(valid_cats))
    if issue_type not in ("technical", "customer-service"):
        issue_type = "technical"

    # Defense-in-depth: classifier sometimes labels routine ops questions
    # as customer-service. Only keep customer-service when the matched
    # service strongly implies billing/account/limits; otherwise prefer
    # technical so the case lands in the right Support engineer queue.
    _CUSTOMER_SERVICE_ALLOWED = {
        "billing", "account-management", "service-limit-increase",
        "customer-service", "tax-inquiries",
    }
    if issue_type == "customer-service" and service not in _CUSTOMER_SERVICE_ALLOWED:
        logger.info("Classifier proposed customer-service for service=%r; "
                    "downgrading to technical (default)", service)
        issue_type = "technical"

    logger.info("Classified case: service=%s category=%s issue=%s reason=%s",
                service, category, issue_type, reason[:120])
    return {
        "serviceCode": service,
        "categoryCode": category,
        "issueType": issue_type,
        "reason": reason,
    }
