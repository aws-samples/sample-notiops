"""
目标账户管理 API 路由。
GET    /api/target-accounts       - 查询目标账户列表
POST   /api/target-accounts       - 添加目标账户
PUT    /api/target-accounts/:id   - 更新目标账户配置
DELETE /api/target-accounts/:id   - 删除目标账户
"""

import logging
import re

from shared.queries.accounts import list_accounts, get_account, put_account, delete_account
from api.errors import NotFoundError

logger = logging.getLogger(__name__)

_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
"""AWS region 的形状。与 `inspection/adapters/accounts.py` 的那个同源
（`us-east-1` / `ap-northeast-1` / `ap-southeast-3` / `us-gov-west-1` 都过）。"""

_ALL_REGIONS = "*"
"""「全部 region」哨兵。与 `inspection.adapters.accounts.ALL_REGIONS` 同值。"""

_MAX_REGIONS = 30
"""单个账号最多配几个 region。

⚠️ 不是性能考虑，是**成本**考虑：巡检按 region 串行扫（`max_workers=8`），
每个 region 每个服务一次 `GetMetricData`，而那个 API 按请求的指标数计费。
没有上限时一次写入就能把某个账号的采集成本放大到全部启用 region ×
四个服务。今天全球启用 region 数 < 30，所以这个上限不会挡住任何合法配置。
"""


def _validate_regions(regions: object, *, field: str = "regions") -> list[str]:
    """校验 region 列表。返回规范化后的列表；不合法就抛 `ValueError`。

    🔴 此前只校验「非空 list」—— 于是任意字符串都能写进去。两个后果：
       · 写进一个不存在的 region → 采集那一轮报错或静默 0 台
       · 写进 `["*"]` → 巡检按「全部启用 region」展开
         （`inspection/adapters/accounts.py` 的 `scan_region_scope`），
         而那条路上**没有数量上限** ⇒ 成本放大

    ⚠️ `*` 是合法的（UI 上有说明），但它必须**单独**出现 —— 混填
       `["us-east-1", "*"]` 时读侧是「按全部算」而不是取交集，
       那种写法的意图不明确，直接拒掉比猜更好。
    """
    if not regions or not isinstance(regions, list):
        raise ValueError(f"{field} must be a non-empty list")
    vals = [str(r).strip() for r in regions]
    if any(not v for v in vals):
        raise ValueError(f"{field} contains an empty entry")
    if _ALL_REGIONS in vals:
        if len(vals) != 1:
            raise ValueError(
                f'{field}: "*" (all regions) must be the only entry, '
                f"got {vals}. Mixing it with explicit regions is ambiguous "
                "-- the reader treats it as all regions, not an intersection")
        return [_ALL_REGIONS]
    if len(vals) > _MAX_REGIONS:
        raise ValueError(
            f"{field}: too many regions ({len(vals)} > {_MAX_REGIONS})")
    bad = [v for v in vals if not _REGION_RE.match(v)]
    if bad:
        raise ValueError(
            f"{field} contains invalid AWS region names: {bad}. "
            'Use e.g. "ap-northeast-1", or "*" alone for all regions')
    # 去重但保序
    return list(dict.fromkeys(vals))


def _validate_role_arn(role_arn: object, account_id: str) -> str:
    """校验采集角色 ARN：必须是 IAM role ARN，**且账号段 == `account_id`**。

    🔴 这是本轮最重要的一条（2026-08-30）。此前 `role_arn` 从请求体直取、
       零校验，而 `put_account(**fields)` 也不校验。于是任何能调这个 API 的人
       都能把某个合法账号的 `role_arn` 改成**他自己账号**的角色：

       ```
       PUT /api/target-accounts/<某个合法账号>
       {"role_arn": "arn:aws:iam::<攻击者账号>:role/evil"}
         → 下一轮巡检 lambda_inspection_executor 读回它并 AssumeRole
         → 攻击者在自己账号里把信任策略写成允许我们的 Lambda 角色 → 成功
         → 之后 rds/elasticache/cloudwatch/ec2 四个 client 全用他的凭证
         → 落库时 account_id 写的是那个**合法**账号
       ⇒ 巡检 finding 的完整性整个失守（伪造 finding / 隐掉真 finding），
         而那些 finding 就是派给 DA 判读、最后端到客户面前的东西。
         顺带我们的 Lambda 执行角色被诱导 assume 攻击者的角色（confused deputy）。
       ```

       ⚠️ 巡检那条路**刻意不接** `LOCKED_ACCOUNT_ID` 闸门（那是设计），
          所以闸门拦不住这条。

    ⇒ 写侧校验（这里）+ 读侧校验（四个 assume 点，见
      `shared.account_scope.assert_role_belongs_to`）两道都要有：
      写侧管新数据，读侧管已经写坏的历史数据和别的写入面。

    ⚠️ 只查账号段与 `arn:*:iam::` 形状，**不查角色名** —— 角色名有三种合法
       形态（一键接入的、手动接入的、历史手工建的），写死会挡掉合法接入。
    """
    from shared.account_scope import CrossAccountRoleMismatch, assert_role_belongs_to

    arn = str(role_arn or "").strip()
    if not arn:
        raise ValueError("role_arn is required")
    try:
        assert_role_belongs_to(arn, account_id, what="role_arn")
    except CrossAccountRoleMismatch as e:
        raise ValueError(str(e)) from e
    return arn


def handle_accounts(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict | list:
    parts = path.rstrip("/").split("/")
    # For PUT/DELETE, last segment is account_id (12-digit string)
    resource_id = parts[-1] if len(parts) >= 3 and parts[-1] not in ("target-accounts",) else None

    if method == "GET":
        return _list_accounts()
    elif method == "POST":
        return _create_account(body)
    elif method == "PUT" and resource_id is not None:
        return _update_account(resource_id, body)
    elif method == "DELETE" and resource_id is not None:
        return _delete_account(resource_id)
    else:
        raise ValueError(f"Method {method} not allowed or missing resource ID")


def _list_accounts() -> dict:
    """查询目标账户列表。"""
    items = list_accounts()
    return {"items": items, "total": len(items)}


def _create_account(body: dict | None) -> dict:
    """添加目标账户。"""
    if not body:
        raise ValueError("Request body is required")

    account_id = str(body.get("account_id") or "").strip()

    if not account_id:
        raise ValueError("account_id is required")
    # 12 位数字 —— 它会被拼进 `account#<id>` 的 PK，也会被拿去比 role ARN 的
    # 账号段。不校验的话「账号段一致」这个判据可以用一个非法 account_id 满足。
    if not _ACCOUNT_RE.match(account_id):
        raise ValueError(
            f"account_id must be a 12-digit AWS account ID, got {account_id!r}")
    role_arn = _validate_role_arn(body.get("role_arn"), account_id)
    regions = _validate_regions(body.get("regions"))

    # 检查是否已存在
    existing = get_account(account_id)
    if existing:
        raise ValueError(f"Account {account_id} already exists")

    put_account(
        account_id,
        role_arn=role_arn,
        regions=regions,
        enabled=body.get("enabled", True),
        description=body.get("description", ""),
    )
    return {"account_id": account_id, "message": "Target account added"}


def _update_account(account_id: str, body: dict | None) -> dict:
    """更新目标账户配置。"""
    if not body:
        raise ValueError("Request body is required")

    if not _ACCOUNT_RE.match(str(account_id or "").strip()):
        raise ValueError(
            f"account_id must be a 12-digit AWS account ID, got {account_id!r}")

    existing = get_account(account_id)
    if not existing:
        raise NotFoundError(f"Target account {account_id} not found")

    # 🔴 **PUT 此前一条校验都没有**（连 POST 那几条非空检查都绕过了），
    #    而它能改的正是 `role_arn` —— 见 `_validate_role_arn` 的说明。
    #
    # ⚠️ 只在**请求体里带了**那个字段时才校验并覆盖。沿用既有的
    #    「不传就保留原值」语义，但**不要**把原值也过一遍校验 ——
    #    历史数据里可能有写坏的行，那种情况下改 description 会被连带拒掉，
    #    而人这时最需要的恰恰是能改。读侧那道校验会挡住真正的危险。
    fields = {
        "enabled": body.get("enabled", existing.get("enabled", True)),
        "description": body.get("description", existing.get("description", "")),
    }
    fields["role_arn"] = (
        _validate_role_arn(body["role_arn"], account_id)
        if "role_arn" in body else existing.get("role_arn", ""))
    fields["regions"] = (
        _validate_regions(body["regions"])
        if "regions" in body else existing.get("regions", []))

    put_account(account_id, **fields)
    return {"message": "Target account updated", "account_id": account_id}


def _delete_account(account_id: str) -> dict:
    """删除目标账户。"""
    existing = get_account(account_id)
    if not existing:
        raise NotFoundError(f"Target account {account_id} not found")
    delete_account(account_id)
    return {"message": "Target account deleted", "account_id": account_id}
