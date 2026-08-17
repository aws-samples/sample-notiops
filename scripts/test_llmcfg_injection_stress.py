"""
generation 注入压测（spec task 8.4 验收）。

与 `test_llm_config_reader.py::test_generation_validation` 的分工：那里验的是**单值**语义
（`-1 / "abc" / 1e308 / None / bool / far-future` 一律忽略且不触发强刷）；这里验的是
**规模与端到端**——单值正确不代表放大攻击下系统还稳：

  1. 1000 条各异的**合法** generation 洪泛 → DDB 读被限速钳住（不是每条一次读）
  2. 1000 条各异的**非法** generation 洪泛 → 零额外读、零异常
  3. 洪泛不得污染状态：缓存里的 generation 仍是 DDB 的值，默认模型仍可解析
  4. 洪泛不得累积内存：模块级不能有"按代"增长的容器（`_note_status` 的去重必须是单槽）
  5. Agent 实例缓存在**真 reader 驱动**下仍 ≤ 上限（不再用假的 gen 源）
  6. BFF 侧 generation 只由服务端产生：`/stream` 绝不读客户端传入的 generation

不触网：DDB 全部 stub。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_llmcfg_injection_stress.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from collections import OrderedDict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")
os.environ.setdefault("CONFIG_TABLE", "test-config")

AGENT_READER = os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                            "NotiOpsWebChat", "core", "llm_config.py")
IM_READER = os.path.join(ROOT, "core", "llm_config.py")
AGENT_CACHE = os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                           "NotiOpsWebChat", "core", "agent_cache.py")
BFF_INDEX = os.path.join(ROOT, "bff", "web-chat", "index.mjs")

FLOOD = 1000            # 8.4 要求的洪泛条数

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
    """按文件路径加载（两份 reader 同名，且需要多份独立实例来换环境变量）。"""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class _CountingTable:
    """记录读次数的最小 DDB Table stub。item 可换（模拟 Admin 改配置）。"""

    def __init__(self, item):
        self.item = item
        self.calls = 0
        self.consistent_calls = 0

    def get_item(self, Key=None, ConsistentRead=False):  # noqa: N803 (boto3 signature)
        self.calls += 1
        if ConsistentRead:
            self.consistent_calls += 1
        return {"Item": self.item} if self.item is not None else {}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _seed_item(generation=None):
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    return {
        "PK": "llmcfg", "SK": "meta",
        "generation": _now_ms() if generation is None else generation,
        "provider": "bedrock",
        "credential_mode": "iam",
        "default_model": "claude-sonnet-5",
        "models": seed["models"],
        "backend_tasks": {"phd_translate": None, "devops_report_summarize": None},
    }


def _patch(mod, table):
    mod.reset_cache()
    mod._table = lambda: table       # noqa: SLF001 — test seam
    return table


# ---------------------------------------------------------------------------
# 1. 合法 generation 洪泛 → DDB 读被限速钳住
# ---------------------------------------------------------------------------
def test_valid_generation_flood_is_rate_limited(mod, surface):
    """1000 条各异的合法 gen，全部与本地不同 → 每条都"想"强刷，但必须被限速拦住。

    没有限速时这就是一条放大通道：一条消息一次 ConsistentRead（强一致读，成本是最终
    一致读的两倍），1000 条消息 = 1000 次强一致读打在同一个 hot key 上。
    """
    print(f"test_valid_generation_flood_is_rate_limited[{surface}]")
    item_gen = _now_ms() - 60_000
    table = _patch(mod, _CountingTable(_seed_item(generation=item_gen)))
    mod.get_config()                              # 预热
    warm = table.calls
    _check("warm-up performed exactly one read", warm == 1, str(warm))

    base = _now_ms() - 30_000
    for i in range(FLOOD):
        mod.get_config(base + i)                  # 每条都与本地 generation 不同
    extra = table.calls - warm

    # 循环耗时 << 限速窗口（10s），所以窗口内只允许放行一次强刷
    _check(f"{FLOOD} distinct generations caused ≤1 forced read (got {extra})",
           extra <= 1, f"extra={extra}")
    _check("forced read used ConsistentRead", table.consistent_calls <= 1,
           str(table.consistent_calls))
    _check("read amplification is bounded well under the flood size",
           table.calls <= 3, f"total={table.calls} for {FLOOD} messages")


# ---------------------------------------------------------------------------
# 2. 非法 generation 洪泛 → 零额外读、零异常
# ---------------------------------------------------------------------------
def _hostile_values(n: int):
    """构造 n 个各异的非法 generation。8.4 点名的 -1/0/1e308/"abc"/null 都在内。

    注意 0 **是合法值**（未 seed 的目录 generation 就是 0），所以它不在这里 —— 它走
    合法路径、受限速保护，另有断言。
    """
    fixed = [-1, "abc", None, True, False, 1e308, float("inf"), float("nan"),
             10 ** 20, [], {}, "12.5", " ", "-0", "0x10", "1e5",
             _now_ms() + 30 * 24 * 3600 * 1000]      # 远期：超出允许时钟偏移
    out = list(fixed)
    i = 0
    while len(out) < n:                              # 补足到 n：各异的负数与远期值
        i += 1
        out.append(-i)
        if len(out) < n:
            out.append(f"abc{i}")
        if len(out) < n:
            out.append(_now_ms() + (30 * 24 * 3600 * 1000) + i)
    return out[:n]


def test_hostile_generation_flood_never_touches_ddb(mod, surface):
    print(f"test_hostile_generation_flood_never_touches_ddb[{surface}]")
    table = _patch(mod, _CountingTable(_seed_item()))
    mod.get_config()
    warm = table.calls

    raised = []
    for bad in _hostile_values(FLOOD):
        try:
            mod.get_config(bad)
        except Exception as e:                       # noqa: BLE001
            raised.append(f"{bad!r}: {e}")
    _check(f"{FLOOD} hostile generations raise nothing",
           not raised, "; ".join(raised[:3]))
    _check(f"{FLOOD} hostile generations trigger zero extra reads",
           table.calls == warm, f"calls {warm}->{table.calls}")


# ---------------------------------------------------------------------------
# 3. 洪泛不得污染状态
# ---------------------------------------------------------------------------
def test_flood_cannot_poison_state(mod, surface):
    """注入值绝不能落进缓存 —— 否则下一轮比较就以污染值为基准，TTL 兜底彻底失效。"""
    print(f"test_flood_cannot_poison_state[{surface}]")
    item_gen = _now_ms() - 60_000
    table = _patch(mod, _CountingTable(_seed_item(generation=item_gen)))
    mod.get_config()

    for bad in _hostile_values(200):
        mod.get_config(bad)
    for i in range(200):
        mod.get_config(_now_ms() - 30_000 + i)

    _check("cached generation is still the DDB value, not an injected one",
           mod.generation() == item_gen, f"{mod.generation()} != {item_gen}")
    _check("status() reports the DDB generation",
           mod.status()["generation"] == item_gen, str(mod.status()["generation"]))
    _check("source is still ddb (no silent fallback to builtin)",
           mod.config_source() == "ddb", mod.config_source())

    r = mod.resolve(None)
    _check("default model still resolves after the flood",
           r is not None and getattr(r, "model_id", ""), repr(r))
    _check("enabled set survived the flood", len(mod.enabled_aliases()) > 0)


# ---------------------------------------------------------------------------
# 4. 洪泛不得累积内存
# ---------------------------------------------------------------------------
def _container_sizes(mod) -> dict[str, int]:
    return {k: len(v) for k, v in vars(mod).items()
            if isinstance(v, (dict, set, list)) and not k.startswith("__")}


def test_flood_does_not_accumulate_module_state(mod, surface):
    """按代去重 / 按代缓存都必须是**单槽**，不能是"见过的 generation"集合。

    长驻进程（IM bot、AgentCore microVM）里，任何按 generation 增长的容器都是无界的：
    Admin 每改一次配置就多一条，而被污染的 generation 能一条消息加一条。
    """
    print(f"test_flood_does_not_accumulate_module_state[{surface}]")
    table = _patch(mod, _CountingTable(_seed_item(generation=_now_ms() - 60_000)))
    mod.get_config()
    before = _container_sizes(mod)

    for i in range(FLOOD):
        mod.get_config(_now_ms() - 30_000 + i)
    for bad in _hostile_values(200):
        mod.get_config(bad)

    after = _container_sizes(mod)
    grew = {k: (before.get(k, 0), after[k]) for k in after
            if after[k] > before.get(k, 0) + 2}
    _check(f"no module-level container grew with the flood ({len(after)} inspected)",
           not grew, str(grew))
    _check("config cache is a single slot, not a per-generation map",
           isinstance(getattr(mod, "_cached_cfg", None), (dict, type(None))))
    _check("status dedup key is a single slot (tuple/None), not a growing set",
           isinstance(getattr(mod, "_last_status_key", None), (tuple, type(None))),
           type(getattr(mod, "_last_status_key", None)).__name__)


# ---------------------------------------------------------------------------
# 5. 真 reader 驱动下的 Agent 实例缓存上限
# ---------------------------------------------------------------------------
def test_agent_cache_bounded_under_real_reader():
    """用**真 reader 产出的 generation** 驱动**真 agent_cache** —— 不再是假 gen 源。

    两种节奏都要过：
      · 限速开启（默认 10s 窗口）—— reader 本身把 churn 阻尼掉，实例几乎不重建；
      · 限速关闭（窗口 0）—— 1000 代全部被消费端看见，此时只有 LRU 上限拦得住。
    """
    print("test_agent_cache_bounded_under_real_reader")
    ac = _load(AGENT_CACHE, "stress_agent_cache")

    def _drive(mod, table, n):
        cache: "OrderedDict[str, str]" = OrderedDict()
        builds = 0
        gens = set()
        for i in range(n):
            new_gen = _now_ms() + i          # 每轮 Admin 改一次配置
            table.item = _seed_item(generation=new_gen)
            mod.get_config(new_gen)
            gen = mod.generation()
            gens.add(gen)
            key = ac.build_key(generation=gen, session_id="s1", user_id="u1",
                               model_key="claude-sonnet-5", topic="general",
                               cross_account=False, account_id=None, devops_deep=False)

            def _build():
                nonlocal builds
                builds += 1
                return f"agent#{builds}"

            ac.admit(cache, key, _build)
        return cache, builds, len(gens)

    # 5a) 默认限速：reader 阻尼 churn
    damped = _load(IM_READER, "stress_reader_damped")
    t1 = _patch(damped, _CountingTable(_seed_item()))
    cache1, builds1, gens1 = _drive(damped, t1, FLOOD)
    _check(f"damped: cache within bound (size={len(cache1)})",
           len(cache1) <= ac.AGENT_CACHE_MAX, str(len(cache1)))
    _check(f"damped: rate limit collapsed {FLOOD} config changes into {gens1} "
           f"generation(s) → {builds1} rebuild(s)", gens1 <= 3 and builds1 <= 3,
           f"gens={gens1} builds={builds1}")

    # 5b) 限速关闭：1000 代全部可见，只剩 LRU 兜底
    os.environ["LLMCFG_REFRESH_MIN_INTERVAL"] = "0"
    try:
        hot = _load(IM_READER, "stress_reader_hot")
    finally:
        os.environ.pop("LLMCFG_REFRESH_MIN_INTERVAL", None)
    _check("un-damped reader really has the rate limit disabled",
           hot._FORCED_REFRESH_MIN_INTERVAL == 0,      # noqa: SLF001
           str(hot._FORCED_REFRESH_MIN_INTERVAL))      # noqa: SLF001

    t2 = _patch(hot, _CountingTable(_seed_item()))
    cache2, builds2, gens2 = _drive(hot, t2, FLOOD)
    _check(f"un-damped: {gens2} distinct generations were observed",
           gens2 >= FLOOD * 0.9, str(gens2))
    _check(f"un-damped: cache still within bound (size={len(cache2)})",
           len(cache2) <= ac.AGENT_CACHE_MAX, str(len(cache2)))
    _check("un-damped: newest instance retained",
           f"agent#{builds2}" in cache2.values())


# ---------------------------------------------------------------------------
# 6. BFF：generation 只由服务端产生
# ---------------------------------------------------------------------------
def test_bff_never_reads_client_generation():
    """`/stream` 读客户端 generation 就等于把上面所有限速拱手让人。"""
    print("test_bff_never_reads_client_generation")
    src = open(BFF_INDEX).read()
    _check("index.mjs never reads body.generation",
           "body.generation" not in src)
    _check("index.mjs never reads a snake_case client generation",
           'body["generation"]' not in src and "body.gen " not in src)
    _check("generation starts at 0 (server-side default)",
           "let generation = 0;" in src)
    _check("generation is only assigned from the server-side catalog read",
           "generation = Number(picked.generation) || 0;" in src)
    assigns = [ln.strip() for ln in src.splitlines()
               if ("generation =" in ln or "generation=" in ln)
               and "==" not in ln and "generation_" not in ln
               and not ln.strip().startswith(("*", "//"))]
    _check("no other assignment to the stream generation",
           len(assigns) == 2, str(assigns))


def main() -> int:
    for path, name, surface in ((IM_READER, "stress_im", "im"),
                                (AGENT_READER, "stress_agent", "webchat")):
        mod = _load(path, name)
        test_valid_generation_flood_is_rate_limited(mod, surface)
        test_hostile_generation_flood_never_touches_ddb(mod, surface)
        test_flood_cannot_poison_state(mod, surface)
        test_flood_does_not_accumulate_module_state(mod, surface)
    test_agent_cache_bounded_under_real_reader()
    test_bff_never_reads_client_generation()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
