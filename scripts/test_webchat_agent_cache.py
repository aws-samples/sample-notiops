"""
webchat Agent 实例缓存测试（验收）。

钉住两件事：

1. **generation 入缓存键**（R4.3 / D2）——配置变更后必须重建 Agent 实例。
   只把 provider/model 入键是不够的：Key 轮换、model_id 重映射这类「内容变了但名字
   没变」的改动同样要重建，否则长驻 microVM 里的旧实例会一直用旧配置。
2. **LRU 上限**（R4.3）——原实现是无上限 dict，键里加了 generation 后每次配置变更都会
   产生一整代新键，旧实例（各持 messages + ~40 工具绑定 + Memory session manager）
   永不释放；被污染的 generation 更能把它撑爆 microVM。

本测试**直接压真实现** `core/agent_cache.py`（按文件路径加载，不导入 main.py —— 那会拉起
Strands 与 5 个 MCP 子进程）。此前这里放的是 agent_factory 的手抄副本，副本已经漂移：
真代码用 `_is_cross_account(account_id)` 归一化账号键，副本写的是 `if not account_id`，
于是「跨账号维度」这项一直测的是另一段逻辑。副本已删除。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_webchat_agent_cache.py
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
from collections import OrderedDict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP = os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat")
MAIN_PY = os.path.join(APP, "main.py")
CACHE_PY = os.path.join(APP, "core", "agent_cache.py")

PASS = "✅"
FAIL = "❌"
_failed = 0


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def _load(path: str, name: str):
    """按文件路径加载，避免与仓库根的同名 `core` 包撞车。"""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SRC = open(MAIN_PY).read()
ac = _load(CACHE_PY, "webchat_agent_cache")


class _Harness:
    """只提供计数与 gen 源；键构造与 LRU 全部走真实现。"""

    def __init__(self, cache_max: int, gen_provider):
        self.cache: "OrderedDict[str, str]" = OrderedDict()
        self.cache_max = cache_max
        self.gen_provider = gen_provider
        self.builds = 0
        self.evicted: list[str] = []

    def get(self, session_id, user_id, model_key=None, topic=None,
            account_id=None, devops_deep=False, cross_account=None):
        # main.py 传 `_is_cross_account(account_id)`；测试默认沿用「给了账号即跨账号」，
        # 需要验证归一化时显式传 cross_account。
        if cross_account is None:
            cross_account = bool(account_id)
        key = ac.build_key(
            generation=self.gen_provider(), session_id=session_id, user_id=user_id,
            model_key=model_key, topic=topic, cross_account=cross_account,
            account_id=account_id, devops_deep=devops_deep,
        )

        def _build():
            self.builds += 1
            return f"agent#{self.builds}"

        agent, ev = ac.admit(self.cache, key, _build, max_size=self.cache_max)
        self.evicted.extend(ev)
        return agent


def test_source_requirements():
    """main.py 的接线必须还在（防重构悄悄退回内联的无上限 dict / 丢掉 generation）。"""
    print("test_source_requirements")
    _check("cache is an OrderedDict (LRU capable)",
           "_OrderedDict()" in SRC and "OrderedDict as _OrderedDict" in SRC)
    _check("main.py delegates key building to agent_cache",
           "_agent_cache.build_key(" in SRC)
    _check("main.py delegates admission/eviction to agent_cache",
           "_agent_cache.admit(cache, key," in SRC)
    _check("generation is fed from llm_config",
           re.search(r"generation=llm_config\.generation\(\)", SRC) is not None)
    _check("cross-account normalisation uses _is_cross_account",
           "cross_account=_is_cross_account(account_id)" in SRC)
    _check("no hand-rolled cache key left behind in main.py",
           re.search(r'key = f"\{_gen\}/', SRC) is None)
    _check("cache max is configurable with a bounded default",
           re.search(r'AGENT_CACHE_MAX = int\(os\.environ\.get\('
                     r'"NOTIOPS_AGENT_CACHE_MAX", "(\d+)"\)\)',
                     open(CACHE_PY).read()) is not None)
    _check(f"default cache max {ac.AGENT_CACHE_MAX} is bounded and sane",
           0 < ac.AGENT_CACHE_MAX <= 256, str(ac.AGENT_CACHE_MAX))

    # entrypoint 必须在取 agent **之前**刷新配置，否则键用的是旧 generation
    refresh_at = SRC.find("llm_config.get_config(payload.get(\"generation\"))")
    agent_at = SRC.find("agent = get_or_create_agent(")
    _check("entrypoint refreshes config before resolving the agent",
           refresh_at != -1 and agent_at != -1 and refresh_at < agent_at,
           f"refresh@{refresh_at} agent@{agent_at}")


def test_generation_change_rebuilds():
    print("test_generation_change_rebuilds")
    gen = {"v": 1_700_000_000_000}
    f = _Harness(64, lambda: gen["v"])

    a1 = f.get("s1", "u1", "claude-sonnet-5")
    a2 = f.get("s1", "u1", "claude-sonnet-5")
    _check("same generation reuses the instance", a1 == a2 and f.builds == 1,
           f"builds={f.builds}")

    gen["v"] += 1000            # Admin 改了配置
    a3 = f.get("s1", "u1", "claude-sonnet-5")
    _check("generation bump rebuilds the instance", a3 != a1 and f.builds == 2,
           f"builds={f.builds}")

    # 「内容变了但名字没变」的场景（Key 轮换 / model_id 重映射）：
    # model_key 与 session 全部不变，仅 generation 变 —— 必须重建。
    gen["v"] += 1
    a4 = f.get("s1", "u1", "claude-sonnet-5")
    _check("content-only change (same alias) still rebuilds",
           a4 != a3 and f.builds == 3, f"builds={f.builds}")


def test_other_dimensions_still_separate():
    print("test_other_dimensions_still_separate")
    f = _Harness(64, lambda: 1_700_000_000_000)
    base = f.get("s1", "u1", "claude-sonnet-5", "general", None, False)
    variants = {
        "model": f.get("s1", "u1", "amazon-nova-pro", "general", None, False),
        "topic": f.get("s1", "u1", "claude-sonnet-5", "finops", None, False),
        "account": f.get("s1", "u1", "claude-sonnet-5", "general", "123456789012", False),
        "devops_deep": f.get("s1", "u1", "claude-sonnet-5", "general", None, True),
        "session": f.get("s2", "u1", "claude-sonnet-5", "general", None, False),
        "user": f.get("s1", "u2", "claude-sonnet-5", "general", None, False),
    }
    for name, inst in variants.items():
        _check(f"{name} change yields a separate instance", inst != base)


def test_account_key_normalisation():
    """账号键归一化：这正是手抄副本漂移掉的那一项。

    `cross_account=False` 时账号键必须塌成 `self` —— **不管 account_id 传了什么**。
    main.py 里 `_is_cross_account()` 会把「本账号 ID」判为非跨账号；如果 build_key 仍按
    account_id 拼键，同一个本账号会话就会拿到两份实例（传 None 一份、传自己账号 ID 一份），
    白白多建一个 Agent，且两份的工具集其实完全相同。
    """
    print("test_account_key_normalisation")
    gen = 1_700_000_000_000
    k_none = ac.build_key(generation=gen, session_id="s1", user_id="u1",
                          cross_account=False, account_id=None)
    k_self = ac.build_key(generation=gen, session_id="s1", user_id="u1",
                          cross_account=False, account_id="444455556666")
    _check("non-cross-account collapses to the same key regardless of account_id",
           k_none == k_self, f"{k_none} != {k_self}")
    # 用「包含该段」而不是「以该段结尾」：键尾会追加新维度（cred_epoch 就是这么加的），
    # endswith 会让一次纯追加变红，而它真正想断言的只是账号段被归一成 self。
    _check("account segment is 'self' when not cross-account",
           "/self/" in k_none, k_none)

    k_x = ac.build_key(generation=gen, session_id="s1", user_id="u1",
                       cross_account=True, account_id=" 111122223333 ")
    _check("cross-account uses the stripped account id", "/111122223333/" in k_x, k_x)
    _check("cross-account key differs from self key", k_x != k_none)

    # 空账号 + cross_account=True 不得抛异常（上游判定异常时的兜底）
    k_empty = ac.build_key(generation=gen, session_id="s1", user_id="u1",
                           cross_account=True, account_id=None)
    _check("cross-account with missing id degrades without raising",
           isinstance(k_empty, str) and k_empty != k_none, k_empty)


def test_lru_bound_and_recency():
    print("test_lru_bound_and_recency")
    f = _Harness(3, lambda: 1_700_000_000_000)
    for i in range(3):
        f.get(f"s{i}", "u1")
    _check("cache filled to capacity", len(f.cache) == 3, str(len(f.cache)))

    f.get("s0", "u1")                       # 触碰最旧的 → 变最新
    f.get("s9", "u1")                       # 触发逐出
    _check("cache stays within bound", len(f.cache) == 3, str(len(f.cache)))
    keys = " ".join(f.cache)
    _check("recently used entry survived eviction", "/s0/" in keys, keys)
    _check("least-recently-used entry evicted", "/s1/" not in keys, keys)
    _check("eviction is reported to the caller (for logging)",
           any("/s1/" in k for k in f.evicted), str(f.evicted))


def test_newly_built_entry_is_never_evicted():
    """上限打满后，逐出**不能**把刚建的那条挑走。

    否则每次调用都重建一个新 Agent 又立刻丢弃 —— 缓存完全失效但构造代价照付。
    """
    print("test_newly_built_entry_is_never_evicted")
    f = _Harness(1, lambda: 1_700_000_000_000)
    a1 = f.get("s1", "u1")
    a2 = f.get("s2", "u1")          # 容量 1，插入后必须逐掉 s1、留下 s2
    _check("cache still within bound of 1", len(f.cache) == 1, str(len(f.cache)))
    _check("the just-built entry is the survivor",
           list(f.cache.values()) == [a2], str(list(f.cache.values())))
    again = f.get("s2", "u1")
    _check("survivor is reused on the next call (no rebuild)",
           again == a2 and f.builds == 2, f"builds={f.builds}")
    _check("evicted entry was the older one", a1 not in f.cache.values())


def test_generation_churn_does_not_grow_unbounded():
    """被污染 / 频繁变化的 generation 不得撑爆缓存（这是加 LRU 的直接动因）。"""
    print("test_generation_churn_does_not_grow_unbounded")
    gen = {"v": 1_700_000_000_000}
    f = _Harness(64, lambda: gen["v"])
    for _ in range(500):
        gen["v"] += 1
        f.get("s1", "u1", "claude-sonnet-5")
    _check("500 generation changes stay within cache bound",
           len(f.cache) <= 64, str(len(f.cache)))
    # 期望键由 build_key 自己生成 —— 手抄键格式会在追加维度时变红，而那不是回归。
    _check("newest instance is retained",
           ac.build_key(generation=gen["v"], session_id="s1", user_id="u1",
                        model_key="claude-sonnet-5") in f.cache)


def test_cred_epoch_forces_a_rebuild():
    """凭证纪元变化必须换实例 —— 这是 webchat 唯一的 Key 失效自愈路径。

    为什么 generation 覆盖不到：generation 只在有人经 Admin 页保存时才变，而直接改
    Secret / 删 IAM user / 配了自动轮换 / 按 90 天提示去控制台轮换，全都不经过它。
    而 botocore 在**构造 client 时**把 bearer token 冻进去，之后每请求只重新决定
    「走 bearer 还是 SigV4」，不重新取值 —— 所以清掉 Key 缓存对已建好的 client 毫无
    作用，那个 client 会一直用旧 token，每轮 401，直到 microVM 回收（最长 8h）。
    IM 侧靠 `lazy_boto.reset_all()`；webchat 靠这一维。
    """
    print("test_cred_epoch_forces_a_rebuild")
    gen = 1_700_000_000_000
    base = dict(generation=gen, session_id="s1", user_id="u1",
                model_key="claude-sonnet-5")
    k0 = ac.build_key(**base, cred_epoch=0)
    k1 = ac.build_key(**base, cred_epoch=1)
    _check("a bumped credential epoch changes the key", k0 != k1, f"{k0} == {k1}")
    _check("the epoch is visible in the key", "ce1" in k1, k1)

    # 默认值必须与 0 等价，否则未传该参数的调用方会拿到另一套键（等于全量重建一次）
    _check("omitting cred_epoch equals cred_epoch=0",
           ac.build_key(**base) == k0)

    # 同纪元下仍复用，不能每次调用都换键
    _check("same epoch keeps the same key",
           ac.build_key(**base, cred_epoch=7) == ac.build_key(**base, cred_epoch=7))


def test_cred_epoch_is_wired_in_main():
    """main.py 必须真的把纪元传进来 —— 否则这一维恒为 0，等于没接。"""
    print("test_cred_epoch_is_wired_in_main")
    src = open(os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                            "NotiOpsWebChat", "main.py"), encoding="utf-8").read()
    # 剥注释行再扫：解释这一维的注释里必然出现这些标识符，裸文本扫描会把注释当实现。
    lines = [ln for ln in src.splitlines() if not ln.lstrip().startswith("#")]
    start = next((i for i, ln in enumerate(lines) if "build_key(" in ln), None)
    _check("main.py calls build_key", start is not None)
    if start is None:
        return
    # 按括号计数取到调用闭合 —— 参数里有 `llm_config.generation()` 这类嵌套调用，
    # 用正则的 `\\(.*?\\)` 会在第一个右括号处提前截断。
    depth, args = 0, []
    for ln in lines[start:]:
        args.append(ln)
        depth += ln.count("(") - ln.count(")")
        if depth <= 0:
            break
    blob = "\n".join(args)
    _check("build_key receives cred_epoch", "cred_epoch=" in blob, blob[:240])
    _check("cred_epoch comes from llm_config.credential_epoch()",
           "credential_epoch()" in blob, blob[:240])


def main() -> int:
    test_source_requirements()
    test_generation_change_rebuilds()
    test_other_dimensions_still_separate()
    test_account_key_normalisation()
    test_lru_bound_and_recency()
    test_newly_built_entry_is_never_evicted()
    test_generation_churn_does_not_grow_unbounded()
    test_cred_epoch_forces_a_rebuild()
    test_cred_epoch_is_wired_in_main()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
