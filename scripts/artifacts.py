"""一键部署（方式 A）发布产物清单 —— **唯一真源**。

为什么要有这个文件：产物名散落在**十几处** —— `scripts/postprocess_template.py`
（产物常量 + `build_manifest` + 一条硬编码的数量断言）、`scripts/package_artifacts.sh`
（清理清单 / 构建步 / 形状检查 / `shasum` 入参 / 结尾文案）、
`scripts/write_release_notes_sums.py`（硬编码的产物名与行序）、
`scripts/test_postprocess_template.py` 的 fixture、一键模板里 `ArtifactBaseUrl` 参数描述里
那句产物数量，以及约十处文档与清单。漏改一处的症状全都是**部署到一半才暴露**
（stager 404 / 校验和缺一行 / 客户开栈时报 `NoSuchKey`）。

所以名字与顺序收敛到这里，其余地方**派生**。

⚠️ **两个顺序不一样，都必须留着** —— 这不是冗余：

  · `STAGING_ORDER` = StagerFn 的**搬运顺序**。小的先搬、144 MiB 的 agent zip 放最后：
    stager 是一个 custom resource，CFN 对它有等待上限，先把小的搬完能让「卡住了」这件事
    尽早暴露在一个便宜的产物上，而不是等大文件传完才发现桶名写错了。
  · `NOTES_ORDER` = release notes 校验和段的**行序**，也用作 `SHA256SUMS` 的行序。
    它是给人核对的，与搬运顺序无关。⚠️ 这两个文件的行序**以前是不一样的**
    （`package_artifacts.sh` 的 `shasum` 入参把 agent 放最后、notes 把它放第四），
    而 `write_release_notes_sums.py` 的注释却声称两者一致 —— 现在统一到本元组。
    `shasum -c` 对行序不敏感，所以这是纯粹给人看的一致性，不改变任何校验行为。

下面的自检保证两者永远是同一个集合的排列 —— 加产物时忘了往其中一个里加，
import 这个模块就会失败，而不是等到发布流程跑到一半。
"""
from __future__ import annotations

#: 全部发布产物（zip）。`SHA256SUMS` 与 `notiops-webchat.template.json` 不在这里 ——
#: 前者是这些 zip 的校验和文件、后者是模板本身，都不是被 stager 搬运的对象。
ALL: tuple[str, ...] = (
    "bff.zip",
    "chat-dist.zip",
    "web-notif.zip",
    "cost-mcp-code.zip",
    "cost-mcp-layer.zip",
    "cur-provisioner.zip",
    "im-code.zip",
    "im-layer.zip",
    "agent-code.zip",
)

#: StagerFn 的搬运顺序（小 → 大）。见模块 docstring 第一条。
STAGING_ORDER: tuple[str, ...] = (
    "bff.zip",
    "chat-dist.zip",
    "web-notif.zip",
    "cost-mcp-code.zip",
    "cost-mcp-layer.zip",
    "cur-provisioner.zip",
    "im-code.zip",
    "im-layer.zip",
    "agent-code.zip",
)

#: release notes 校验和段 + `SHA256SUMS` 的行序（给人核对用）。
NOTES_ORDER: tuple[str, ...] = (
    "bff.zip",
    "chat-dist.zip",
    "web-notif.zip",
    "agent-code.zip",
    "im-code.zip",
    "im-layer.zip",
    "cost-mcp-code.zip",
    "cost-mcp-layer.zip",
    "cur-provisioner.zip",
)

#: 按**产物名前缀**分组的「加装项」—— stager 用前缀决定跳不跳（不看安装选项的具体取值，
#: 见 infra/lambda/stager/index.py 的 `_artifacts_upsert`）。以后新增安装选项会自动落到
#: 正确一侧，不用回来改判据。
#: ⚠️ 新增前缀时：各前缀之间**不许互为前缀**（下面自检会拦），否则 stager 分不清该跳谁。
OPTIONAL_PREFIXES: tuple[str, ...] = ("im-", "cost-mcp-", "cur-provisioner")


def optional_group(name: str) -> str | None:
    """产物属于哪个加装项分组（按前缀）；核心产物返回 None。"""
    for p in OPTIONAL_PREFIXES:
        if name.startswith(p):
            return p
    return None


# ── 自检：两个顺序必须是 ALL 的排列 ──────────────────────────────────────────
# 放在 import 期而不是写成测试：这个文件被发布流程的多个脚本 import，越早失败越便宜。
def _self_check() -> None:
    for label, order in (("STAGING_ORDER", STAGING_ORDER), ("NOTES_ORDER", NOTES_ORDER)):
        if sorted(order) != sorted(ALL):
            missing = sorted(set(ALL) - set(order))
            extra = sorted(set(order) - set(ALL))
            raise AssertionError(
                f"scripts/artifacts.py: {label} is not a permutation of ALL "
                f"(missing={missing}, extra={extra}). Add the artifact to every tuple."
            )
        if len(set(order)) != len(order):
            raise AssertionError(f"scripts/artifacts.py: {label} has duplicates")
    for p in OPTIONAL_PREFIXES:
        for q in OPTIONAL_PREFIXES:
            if p != q and (p.startswith(q) or q.startswith(p)):
                raise AssertionError(
                    f"scripts/artifacts.py: optional prefixes {p!r} and {q!r} overlap -- "
                    "the stager decides by prefix, so they must be mutually distinguishable."
                )


_self_check()


if __name__ == "__main__":
    # 给 shell 用：`python3 scripts/artifacts.py sums` / `... staging` / `... all`
    import sys
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(" ".join({"all": ALL, "staging": STAGING_ORDER, "sums": NOTES_ORDER}[which]))
