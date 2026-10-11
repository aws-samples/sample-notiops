"""CUR 1.0 / 2.0 列名适配层 — 版本差异唯一集中地。

CUR_VERSION=1（默认）：legacy 独立列
CUR_VERSION=2：aggregated_cur2 混合形态——常用列仍是独立列
  （instance_type/servicecode/product_family/region_code/location/usage_type...），
  其余在 product map / resource_tags map。

⚠️ 2.0 map 缺 key 返回 NULL（1.0 是空串）——所有取值包 COALESCE。
"""
import os
import re

V2 = os.environ.get("CUR_VERSION", "1") == "2"


def col(name: str) -> str:
    """按版本返回列表达式。传 1.0 列名，自动翻译成 2.0 写法。"""
    if not V2:
        return name
    return _V2_MAP.get(name, name)


# 1.0 列名 → 2.0 表达式（不在表里的独立列 → map 取值 + 空串归一，保持 1.0 语义）
def _m(key: str) -> str:
    return f"COALESCE(product['{key}'],'')"


_V2_MAP = {
    # product 属性：2.0 挪进 map 的
    "product_vcpu": _m("vcpu"),
    "product_gpu": _m("gpu"),
    "product_operating_system": _m("operating_system"),
    "product_capacitystatus": _m("capacitystatus"),
    "product_physical_processor": _m("physical_processor"),
    "product_product_name": _m("product_name"),
    "product_database_engine": _m("database_engine"),
    "product_availability_zone": _m("availability_zone"),
    "product_database_edition": _m("database_edition"),
    "product_cache_engine": _m("cache_engine"),
    "product_port_speed": _m("port_speed"),
    "product_volume_api_name": _m("volume_api_name"),
    "product_tenancy": _m("tenancy"),
    # 机型族：2.0 独立列 product_instance_family 是分类名（Compute optimized），
    # 真机型族在 map
    "product_instance_type_family": _m("instance_type_family"),
    # region：2.0 用 region_code 独立列
    "product_region": "COALESCE(NULLIF(product_region_code,''), product['region'], '')",
    # 2.0 独立列但 NULL 语义（1.0 是空串）——归一防 ''= 判断失效
    "product_servicecode": "COALESCE(product_servicecode,'')",
    # instance_type 保持裸列（COALESCE 会破坏 SELECT 输出列名；NULL 判断处工具 SQL 自带防线）

    "product_location": "COALESCE(product_location,'')",
    "savings_plan_savings_plan_a_r_n": "COALESCE(savings_plan_savings_plan_a_r_n,'')",
    "reservation_reservation_a_r_n": "COALESCE(reservation_reservation_a_r_n,'')",
    # ⚠️ tag key **不在这张表里** —— 上游在这里写死了某一家客户自己的几个 tag key。
    # tag 的 1.0→2.0 适配由本文件
    # 下面的 `tag_col()` 按 `CUR_TAG_KEYS` 动态做，见「客户自己的 tag 维度」那一节。
}


def tag_col(tag_column: str) -> str:
    """tag 列的版本适配：1.0 直接列名；2.0 从列名剥出 key 走 map。"""
    if not V2:
        return tag_column
    key = tag_column.replace("resource_tags_", "")
    return f"COALESCE(resource_tags['{key}'],'')"


# ── 客户自己的 tag 维度（并入 NotiOps 时参数化）─────────────────────────────────
#
# ⚠️ 上游把一组 tag key **写死**在 `_V2_MAP` 里，并且把其中两个当成**通用维度**写进了
# 四个工具的描述。那是某一家客户自己的 tag 命名，换一份 CUR 就不成立。留着不动的后果不是报错，
# 是**一个看起来合法、结果 100% 是 `(untagged)` 的维度** —— 客户会以为自己没打 tag。
#
# 现在改成声明式：
#     CUR_TAG_KEYS="team,owner"    → 提供 tag_team / tag_owner 两个维度
#     CUR_TAG_KEYS=""（默认）       → **不提供任何 tag 维度**，工具描述里也不出现
#
# key 只允许 CUR 列名安全字符集：tag key 会被拼进 SQL（1.0 是列名、2.0 是 map 下标），
# 所以这里是**注入面**，必须走允许清单，不能只 strip。
_TAG_KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,128}$")


def _parse_tag_keys() -> tuple[str, ...]:
    raw = os.environ.get("CUR_TAG_KEYS", "")
    keys = []
    for part in raw.split(","):
        k = part.strip()
        if not k:
            continue
        if not _TAG_KEY_RE.match(k):
            raise RuntimeError(
                f"CUR_TAG_KEYS contains an unsafe tag key: {k!r} "
                "(allowed: letters, digits, underscore)"
            )
        keys.append(k)
    return tuple(keys)


TAG_KEYS: tuple[str, ...] = _parse_tag_keys()


def tag_dimensions() -> dict[str, str]:
    """`tag_<key>` → 分组表达式。未配置 `CUR_TAG_KEYS` 时返回空 dict。"""
    return {
        f"tag_{k}": f"COALESCE(NULLIF({tag_col('resource_tags_user_' + k)},''),'(untagged)')"
        for k in TAG_KEYS
    }
