"""
三端模型目录一致性测试（spec task 1.1 验收标准）。

校验 `config/llm-model-catalog.json`（规范种子）能**逐字段复现**三个消费端当前的
实际行为，确保引入 DDB 目录不产生任何回归：

  * IM bot   (`core/model_catalog.py`)         : model_id / kind / max_output_tokens
  * webchat  (`agent-build/.../model/load.py`) : 已目录驱动，仅断言硬编码不回归
    （构造参数正确性见 scripts/test_webchat_load_model.py）
  * 前端      (`frontend/chat-app/src/types.ts`): label / desc_key / DEFAULT_MODEL

两处 per-surface 差异由种子的 override 字段如实建模（是现状，不是 bug）：
  * `model_id_override.im` — IM 对 Claude 用 `us.*` inference profile，webchat 用 `global.*`
    （数据驻留特性不同：us 限美国区域路由 / global 全球路由）。待决策是否统一。
  * `output_override.im`   — IM 回复是聊天尺寸（6000），webchat 要容纳长报告（min(硬上限, 32768)）

同时校验配置不变量（default ∈ 启用集、alias/short 唯一、kind 闭枚举、mantle 必须带 region 等），
这些不变量后续由 BFF 的 PUT 路由在服务端强制执行（spec R2.7）。

注：本脚本为开发期自测，输出标签一律英文（i18n lint 只允许中文出现在注释/docstring）。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_llm_catalog_seed.py
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")

from core import model_catalog as mc  # noqa: E402

SEED = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
MODELS = {m["alias"]: m for m in SEED["models"]}

# Per-surface output-token targets, mirrored from the code under test.
WEBCHAT_TARGET = 32768   # load.py _MAX_OUTPUT_TARGET
IM_TARGET = 6000         # chat-sized replies

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


def _model_id_for(entry: dict, surface: str) -> str:
    return (entry.get("model_id_override") or {}).get(surface) or entry["model_id"]


def _output_cap_for(entry: dict, surface: str, target: int) -> int:
    override = (entry.get("output_override") or {}).get(surface)
    return override if override is not None else min(entry["hard_output_limit"], target)


def _seed_entry_for_im_alias(alias: str) -> dict | None:
    return next((m for m in SEED["models"]
                 if m.get("short") == alias
                 or m["alias"] == alias
                 or alias in m.get("aliases_legacy", [])), None)


def test_seed_im_surface_claims_are_real():
    """反向校验：种子声明 `surfaces` 含 "im" 的条目，IM 目录里必须真的存在。

    只做正向校验（IM 条目都在种子里）会漏掉一类真实故障：种子把某模型标成 IM 可用、
    但 `core/model_catalog.py` 并无该条目 —— admin 选它当默认，IM 侧解析不到就静默
    回落硬编码默认，admin 的选择被吞掉（2026-08 实际发生，由 task 0.2 测试抓到）。
    """
    print("test_seed_im_surface_claims_are_real")
    im_aliases = set(mc.list_aliases())
    im_model_ids = {e.model_id for e in mc.all_entries()}
    for m in SEED["models"]:
        if "im" not in m["surfaces"]:
            continue
        resolvable = (
            m["alias"] in im_aliases
            or (m.get("short") or "") in im_aliases
            or any(a in im_aliases for a in m.get("aliases_legacy", []))
            or _model_id_for(m, "im") in im_model_ids
        )
        _check(f"seed claims {m['alias']!r} is IM-capable and IM catalogue has it",
               resolvable,
               f"IM aliases={sorted(im_aliases)}")


def test_seed_reproduces_im_catalogue():
    print("test_seed_reproduces_im_catalogue")
    for entry in mc.all_entries():
        seed = _seed_entry_for_im_alias(entry.alias)
        if seed is None:
            _check(f"IM alias {entry.alias!r} present in seed", False)
            continue
        _check(f"{entry.alias}: model_id matches",
               _model_id_for(seed, "im") == entry.model_id,
               f"seed={_model_id_for(seed, 'im')} code={entry.model_id}")
        _check(f"{entry.alias}: kind matches",
               seed["kind"] == entry.kind, f"seed={seed['kind']} code={entry.kind}")
        cap = _output_cap_for(seed, "im", IM_TARGET)
        _check(f"{entry.alias}: output cap {cap} == {entry.max_output_tokens}",
               cap == entry.max_output_tokens)


def _code_only(src: str) -> str:
    """源码去掉注释与 docstring 后的等价文本。

    给「禁止某种写法」这类断言用。在**裸文本**上扫的话，一段解释「为什么不再用旧写法」的
    注释会和旧写法本身无法区分，于是文档写得越清楚越容易假阳性。
    用 AST 重新 unparse：注释天然消失，docstring 显式剥掉。
    """
    import ast as _ast
    tree = _ast.parse(src)
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.Module, _ast.ClassDef,
                             _ast.FunctionDef, _ast.AsyncFunctionDef)):
            body = getattr(node, "body", None)
            if (body and isinstance(body[0], _ast.Expr)
                    and isinstance(body[0].value, _ast.Constant)
                    and isinstance(body[0].value.value, str)):
                body.pop(0)
    return _ast.unparse(tree)


def test_webchat_loader_is_catalogue_driven():
    """webchat 侧已无硬编码模型清单 —— 断言它不会悄悄回来。

    task 3.1 之前这里逐字段比对 `load.py` 的 `_MODEL_MAP` / `_MANTLE_MODELS` /
    `_DEFAULT`（当时它们是真源）。现在真源是目录，`load.py` 只负责按目录条目构造模型，
    **构造参数的正确性由 `scripts/test_webchat_load_model.py` 校验**（它 stub 掉 Strands
    后断言 model_id / max_tokens / prompt cache / Mantle region 逐项匹配目录）。

    本函数保留的价值是防回归：如果有人为了"省事"又在 load.py 里塞回一张模型表，
    目录就重新变成第二真源，加模型又要改多处。
    """
    print("test_webchat_loader_is_catalogue_driven")
    load_py_raw = open(os.path.join(
        ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat",
        "model", "load.py")).read()
    # 只扫**代码**，不扫注释与 docstring。裸文本扫描会把「解释旧做法为什么被废弃」的注释
    # 当成旧做法本身 —— 实测踩到：一次 merge 里注释引用了 main 的旧实现
    # `if "anthropic.claude" in model_id`，下面那条 `'in model_id' not in ...` 立刻假阳性。
    # 结果是"写清楚为什么"反而被测试惩罚，人只会去删注释而不是修代码。
    load_py = _code_only(load_py_raw)

    for banned in ("_MODEL_MAP", "_MANTLE_MODELS"):
        _check(f"load.py no longer defines {banned}",
               f"{banned} = {{" not in load_py)
    _check("load.py sources models from llm_config",
           "from core import llm_config" in load_py
           and "llm_config.resolve(" in load_py)
    # 输出上限与 prompt cache 必须来自条目字段，不能再靠 model_id 子串猜
    _check("no model_id substring inference for prompt cache",
           'in model_id' not in load_py)
    _check("max_tokens comes from the resolved spec",
           "spec.max_output_tokens" in load_py)
    _check("mantle region comes from the resolved spec",
           "spec.region" in load_py)


def test_seed_reproduces_frontend_options():
    print("test_seed_reproduces_frontend_options")
    types_ts = open(os.path.join(
        ROOT, "frontend", "chat-app", "src", "types.ts")).read()
    for fid, name, desc_key in re.findall(
            r'\{ id: "([^"]+)", name: "([^"]+)", descKey: "([^"]+)"', types_ts):
        seed = MODELS.get(fid)
        _check(f"frontend option {fid!r} present in seed", seed is not None)
        if seed:
            _check(f"{fid}: label matches", seed["label"] == name,
                   f"seed={seed['label']} fe={name}")
            _check(f"{fid}: desc_key matches", seed["desc_key"] == desc_key,
                   f"seed={seed['desc_key']} fe={desc_key}")
    fe_default = re.search(r'DEFAULT_MODEL\s*=\s*"([^"]+)"', types_ts)
    if fe_default:
        _check("frontend DEFAULT_MODEL == seed default_model",
               fe_default.group(1) == SEED["default_model"],
               f"fe={fe_default.group(1)} seed={SEED['default_model']}")


def test_config_invariants():
    """Invariants the BFF PUT route will enforce server-side (spec R2.7)."""
    print("test_config_invariants")
    default = MODELS.get(SEED["default_model"])
    _check("default_model exists in catalogue", default is not None)
    if default:
        _check("default_model is enabled", default["enabled"] is True)

    # `verified` must not appear in the seed **at all** -- the field is gone.
    #
    # It used to be `true` on all nine entries. The claim was never earned: nothing
    # had probed those models, and whether a model works depends on the deployment
    # Region and on the credential in use. Two concrete failures came out of it:
    #   * `amazon.nova-pro-v1:0` shipped as verified while being un-invokable in
    #     ap-northeast-1 (on-demand throughput isn't supported there; it needs an
    #     inference profile). Nobody found out until someone selected it.
    #   * A Bedrock API key scoped to exclude a model still let that model be
    #     saved as the default -- `validateConfig` only gated on `verified`, so a
    #     pre-declared `true` walked straight past the one check that would have
    #     caught it, and users got 403 at chat time.
    #
    # Flipping it to `false` was the first fix, but that only moved the problem:
    # the flag still had to be invalidated by hand whenever anything it depended on
    # changed (credential, Region, model availability, IAM policy), and we could
    # only ever detect one of those. The field was therefore removed outright and
    # replaced by a **live probe of the default model at save time** (BFF
    # `probeDefaultModel`), whose verdict belongs to the moment of the decision and
    # cannot go stale.
    stale = [m["alias"] for m in SEED["models"] if "verified" in m]
    _check("seed carries no verified field at all", not stale, str(stale))
    _check("at least one model enabled",
           sum(1 for m in SEED["models"] if m["enabled"]) >= 1)
    _check("aliases are unique", len(MODELS) == len(SEED["models"]))

    shorts = [m["short"] for m in SEED["models"] if m.get("short")]
    _check("short aliases are unique", len(shorts) == len(set(shorts)))
    _check("short aliases do not collide with canonical aliases",
           not (set(shorts) & set(MODELS)))

    kinds = {m["kind"] for m in SEED["models"]}
    _check("kind values within closed enum",
           kinds <= {"bedrock_anthropic", "bedrock_converse",
                     "bedrock_mantle_responses"}, str(kinds))
    _check("mantle entries declare a region",
           all(m["region"] for m in SEED["models"]
               if m["kind"] == "bedrock_mantle_responses"))
    _check("non-mantle entries leave region null",
           all(m["region"] is None for m in SEED["models"]
               if m["kind"] != "bedrock_mantle_responses"))
    # 每个非 Mantle 的 model_id 要么带跨区推理 profile 前缀，要么必须在下面这份
    # **显式白名单**里。
    #
    # 起因是一个真实缺陷：种子里写的是裸 `amazon.nova-pro-v1:0`，而它在东京不能按需
    # 直调 —— 实测 `ValidationException: Invocation of model ID amazon.nova-pro-v1:0
    # with on-demand throughput isn't supported. Retry ... with an inference profile`。
    # 种子同时把 `verified` 写死成 true，所以这条从来没被探测暴露过，只有真去选它的人
    # 才会撞上。现在这类模型是常态（新一代模型多半只提供 INFERENCE_PROFILE），裸 id
    # 反而是例外。
    #
    # 为什么不直接禁掉所有裸 id：确实有仍支持按需直调的（`deepseek.v3.2` 东京实测可用）。
    # 所以用白名单而不是硬规则 —— 加裸 id 必须先在这里登记，也就必须先想一下它到底能不能
    # 按需调。仅靠「种子与代码内置兜底一致」那条镜像断言是拦不住的：两边一起改成裸 id
    # 时它照样全绿（反向注入验证确认过）。
    _ON_DEMAND_BARE_IDS = {
        "deepseek.v3.2",   # 东京实测 Converse 直调 200
    }
    _PROFILE_PREFIXES = ("global.", "us.", "eu.", "apac.", "jp.", "au.", "us-gov.")
    for m in SEED["models"]:
        if m["kind"] == "bedrock_mantle_responses":
            continue          # Mantle 不经 bedrock-runtime，没有 profile 的概念
        mid = m["model_id"]
        _check(f"{m['alias']}: model_id is on-demand callable or profile-prefixed",
               mid.startswith(_PROFILE_PREFIXES) or mid in _ON_DEMAND_BARE_IDS,
               f"{mid} is a bare id and is not registered; if it really supports "
               f"on-demand invocation add it to _ON_DEMAND_BARE_IDS, otherwise "
               f"switch to the prefixed cross-Region inference profile")

    _check("surfaces values are valid",
           all(set(m["surfaces"]) <= {"webchat", "im"} for m in SEED["models"]))
    _check("every model declares at least one surface",
           all(m["surfaces"] for m in SEED["models"]))
    _check("hard_output_limit is a positive int",
           all(isinstance(m["hard_output_limit"], int) and m["hard_output_limit"] > 0
               for m in SEED["models"]))
    _check("provider is bedrock (litellm is Phase 2)",
           SEED["provider"] == "bedrock", SEED["provider"])
    _check("credential_mode within enum",
           SEED["credential_mode"] in ("iam", "api_key"), SEED["credential_mode"])
    backend = SEED.get("backend_tasks", {})
    for task in ("phd_translate", "devops_report_summarize"):
        val = backend.get(task)
        _check(f"backend task {task!r} is null or an enabled alias",
               val is None or (val in MODELS and MODELS[val]["enabled"]), str(val))


def main() -> int:
    test_seed_im_surface_claims_are_real()
    test_seed_reproduces_im_catalogue()
    test_webchat_loader_is_catalogue_driven()
    test_seed_reproduces_frontend_options()
    test_config_invariants()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
