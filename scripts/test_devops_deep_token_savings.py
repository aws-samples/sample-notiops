"""
Self-test for the 2026-08-10 deep-investigation (DevOps Agent) token-cost work.

Pins down the three things that would silently regress:

  1. **Prompt-cache TTL is per-model.** Bedrock's default cache TTL is 5 minutes,
     but a deep investigation blocks in-tool for up to `NOTIOPS_DEVOPS_MAX_WAIT_SEC`
     (840s = 14 min) between cycle ① (issue the tool call) and cycle ② (write the
     wrap-up) — so the whole cacheable prefix expires and gets re-billed at full
     price. Fix = ttl="1h". But 1h is **model-gated**: Sonnet 4.6 only supports 5m
     and would reject "1h" with a ValidationException (same class of failure as the
     max_tokens-over-hard-limit incident). So the resolver must return None for it.

  2. **Deep investigation is topic-decoupled.** The topic gate is an *exclusion*
     list, not an allowlist, so newly added topics inherit the capability by
     default. Previously the allowlist ("investigate","finops","security") was
     hardcoded in three places (two backend + one frontend); missing one meant the
     toggle lit up but no tools were mounted = silent no-op.

  3. **Frontend and backend agree on that exclusion list.** They are separate files
     in separate languages; drift = the silent no-op above.

Run from repo root::

    python3 scripts/test_devops_deep_token_savings.py
"""
from __future__ import annotations

import os
import re
import sys
import types
from dataclasses import dataclass

_ROOT = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
_AGENT_APP = os.path.join(_ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat")
sys.path.insert(0, _AGENT_APP)


def _stub_strands() -> None:
    """`model/load.py` imports strands at module level, and strands isn't installed
    on a dev Mac (the staged copy under agentcore/.cache is Linux wheels — importing
    it dies in pydantic_core). Stub just the three names load.py touches, mirroring
    the real dataclass shapes from strands/models/model.py, so the *cap and TTL
    resolution logic* is genuinely exercised rather than string-matched."""
    if "strands" in sys.modules:
        return

    @dataclass
    class CacheConfig:  # mirrors strands.models.model.CacheConfig
        strategy: str = "auto"
        ttl: str | None = None

    @dataclass
    class CacheToolsConfig:  # mirrors strands.models.model.CacheToolsConfig
        type: str = "default"
        ttl: str | None = None

    class BedrockModel:  # only ever instantiated by load_model(), not by this test
        def __init__(self, **kwargs):
            self.config = kwargs

    strands = types.ModuleType("strands")
    models = types.ModuleType("strands.models")
    bedrock = types.ModuleType("strands.models.bedrock")
    model_mod = types.ModuleType("strands.models.model")
    bedrock.BedrockModel = BedrockModel
    model_mod.CacheConfig = CacheConfig
    model_mod.CacheToolsConfig = CacheToolsConfig
    strands.models = models
    models.bedrock = bedrock
    models.model = model_mod
    sys.modules.update({
        "strands": strands, "strands.models": models,
        "strands.models.bedrock": bedrock, "strands.models.model": model_mod,
    })


_stub_strands()

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


def _read(*parts: str) -> str:
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def test_cache_ttl_is_per_model():
    """1h TTL only for models whose AWS model card lists it."""
    print("test_cache_ttl_is_per_model")
    # load.py only imports from strands; import it directly to avoid pulling main.py.
    from model import load as _load  # type: ignore[import-not-found]

    # `_MODEL_MAP` 已不存在 —— 模型清单移到了 DDB 目录（core.llm_config）。这里改用
    # 目录里那份内置兜底取 alias → model_id，与运行时同一数据源。
    from core import llm_config as _cfg
    _ids = {m["alias"]: m["model_id"] for m in _cfg._BUILTIN_CATALOG["models"]}

    for key in ("claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"):
        mid = _ids[key]
        _check(f"{key} → 1h", _load._cache_ttl_for(mid) == "1h",
               f"got {_load._cache_ttl_for(mid)!r} for {mid}")

    # Sonnet 4.6 supports 5m ONLY — asking for 1h is rejected by Bedrock.
    mid46 = _ids["claude-sonnet-4-6"]
    _check("claude-sonnet-4-6 → None (5m only, 1h would be rejected)",
           _load._cache_ttl_for(mid46) is None,
           f"got {_load._cache_ttl_for(mid46)!r}")

    # Unknown / empty → conservative default (no explicit ttl).
    _check("unknown id → None", _load._cache_ttl_for("not-a-real-model") is None)
    _check('"" → None', _load._cache_ttl_for("") is None)
    _check("None → None", _load._cache_ttl_for(None) is None)


def test_cache_config_covers_messages_and_tools():
    """Claude gets both a tools checkpoint and a messages-level cachePoint,
    and no longer uses the deprecated cache_prompt."""
    print("test_cache_config_covers_messages_and_tools")
    from model import load as _load  # type: ignore[import-not-found]

    if not _load._HAS_CACHE_CONFIG:
        _check("strands exposes CacheConfig (else message-level caching is off)",
               False, "CacheConfig import failed — check strands version")
        return

    # `_bedrock_kwargs` 现在吃**目录条目**（ResolvedModel）而不是裸 model_id：prompt cache
    # 的开关来自条目的 `supports_prompt_cache`，不再按 model_id 子串猜。
    from core import llm_config as _cfg

    def _spec(alias):
        e = next(m for m in _cfg._BUILTIN_CATALOG["models"] if m["alias"] == alias)
        return _cfg.ResolvedModel(
            alias=e["alias"], model_id=e["model_id"], label=e["label"],
            kind=e["kind"], region=e["region"],
            max_output_tokens=e["hard_output_limit"],
            supports_prompt_cache=e["supports_prompt_cache"])

    kw = _load._bedrock_kwargs(_spec("claude-sonnet-5"))
    _check("cache_config set (covers history + this turn's injections)",
           kw.get("cache_config") is not None)
    _check("cache_config strategy == auto",
           getattr(kw.get("cache_config"), "strategy", None) == "auto")
    _check("cache_config ttl == 1h on default model (Sonnet 5)",
           getattr(kw.get("cache_config"), "ttl", None) == "1h")
    _check("cache_tools is a CacheToolsConfig (so it can carry a ttl)",
           type(kw.get("cache_tools")).__name__ == "CacheToolsConfig",
           f"got {type(kw.get('cache_tools')).__name__}")
    _check("cache_tools ttl == 1h on default model",
           getattr(kw.get("cache_tools"), "ttl", None) == "1h")
    _check("deprecated cache_prompt NOT set (emits UserWarning per request)",
           "cache_prompt" not in kw)

    # Sonnet 4.6: caching still on, but no explicit ttl (=> Bedrock default 5m).
    kw46 = _load._bedrock_kwargs(_spec("claude-sonnet-4-6"))
    _check("sonnet-4-6 caching on but ttl is None (5m default)",
           kw46.get("cache_config") is not None
           and getattr(kw46["cache_config"], "ttl", None) is None)

    # Non-Claude: caching stays off — now because the catalogue entry declares
    # supports_prompt_cache=false, not because of a model_id substring check.
    kw_nova = _load._bedrock_kwargs(_spec("amazon-nova-pro"))
    _check("nova: no cache args at all",
           not any(k.startswith("cache_") for k in kw_nova),
           f"got {sorted(kw_nova)}")


def test_topic_gate_is_an_exclusion_list():
    """Deep investigation is on by default for new topics; only listed ones opt out."""
    print("test_topic_gate_is_an_exclusion_list")
    src = _read(_AGENT_APP, "main.py")

    m = re.search(r"_DEVOPS_TOPICS_EXCLUDED\s*=\s*frozenset\(\{([^}]*)\}\)", src)
    _check("_DEVOPS_TOPICS_EXCLUDED exists", m is not None)
    if not m:
        return
    excluded = set(re.findall(r'"([^"]+)"', m.group(1)))
    _check("excludes exactly general/cases/whats-new",
           excluded == {"general", "cases", "whats-new"}, f"got {sorted(excluded)}")

    # Behaviour must be unchanged for the three topics that had it before...
    def has(topic: str) -> bool:
        return topic not in excluded
    for t in ("investigate", "finops", "security"):
        _check(f"{t} still has deep investigation", has(t))
    for t in ("general", "cases", "whats-new"):
        _check(f"{t} still does NOT have it", not has(t))
    # ...and a hypothetical future topic inherits it with no code change.
    _check("a brand-new topic inherits it by default", has("some-future-topic"))

    # No hardcoded allowlist tuple may survive anywhere in main.py.
    stale = [
        (n, ln.strip())
        for n, ln in enumerate(src.splitlines(), 1)
        if not ln.strip().startswith("#")
        and re.search(r'\(\s*"investigate"\s*,\s*"finops"\s*,\s*"security"\s*\)', ln)
    ]
    _check("no hardcoded (investigate, finops, security) allowlist left",
           not stale, f"found {stale}")


def test_frontend_matches_backend_exclusion_list():
    """types.ts and main.py must agree, or the toggle lights up with no tools."""
    print("test_frontend_matches_backend_exclusion_list")
    ts = _read(_ROOT, "frontend", "chat-app", "src", "types.ts")
    py = _read(_AGENT_APP, "main.py")

    mt = re.search(r"DEVOPS_TOPICS_EXCLUDED[^=]*=\s*new Set\(\[([^\]]*)\]\)", ts)
    mp = re.search(r"_DEVOPS_TOPICS_EXCLUDED\s*=\s*frozenset\(\{([^}]*)\}\)", py)
    _check("frontend DEVOPS_TOPICS_EXCLUDED exists", mt is not None)
    _check("backend _DEVOPS_TOPICS_EXCLUDED exists", mp is not None)
    if not (mt and mp):
        return
    fe = set(re.findall(r'"([^"]+)"', mt.group(1)))
    be = set(re.findall(r'"([^"]+)"', mp.group(1)))
    _check("frontend list == backend list", fe == be,
           f"frontend={sorted(fe)} backend={sorted(be)}")

    # The Composer must go through the shared helper, not re-check topic strings.
    composer = _read(_ROOT, "frontend", "chat-app", "src", "components", "Composer.tsx")
    _check("Composer uses topicHasDevopsAgent()",
           "topicHasDevopsAgent(topic)" in composer)
    _check("Composer has no devops topic string triple-check",
           'topic === "security"' not in composer)


def test_usage_event_reports_cache_hits():
    """cacheRead/cacheWrite must be emitted — the only way to observe whether
    the TTL fix actually works. Frontend ignores unknown usage keys."""
    print("test_usage_event_reports_cache_hits")
    src = _read(_AGENT_APP, "main.py")
    _check("usage event carries cacheReadInputTokens",
           '"cacheReadInputTokens": cr' in src)
    _check("usage event carries cacheWriteInputTokens",
           '"cacheWriteInputTokens": cw' in src)
    _check("cache counters are diffed against the pre-stream snapshot _u0",
           '_u0.get("cacheReadInputTokens"' in src)


def test_devops_rule_is_topic_agnostic_and_smaller():
    """The dd1 hard rule must not name topic-specific tools (it now applies to
    every topic) and must be meaningfully shorter than before."""
    print("test_devops_rule_is_topic_agnostic_and_smaller")
    src = _read(_AGENT_APP, "main.py")
    m = re.search(r"if devops_deep:\n        prompt = \(\n(.*?)\n        \) \+ prompt",
                  src, re.S)
    _check("dd1 injection block found", m is not None)
    if not m:
        return
    lits = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
    text = "".join(lit.encode().decode("unicode_escape") for lit in lits)

    # Was 4032 chars before this change; keep a ceiling so it can't creep back.
    _check("block is < 3000 chars (was 4032)", len(text) < 3000, f"got {len(text)}")
    # Assertions about the prompt NOT containing topic-specific wording - these are
    # fixtures, not user-facing text. (Hence this file sits in lint_i18n.py's
    # CJK_ALLOWLIST; the earlier \uXXXX spelling didn't help - the linter decodes escapes.)
    for word in ("FinOps", "Cost MCP", "本主题只读工具"):
        _check(f"no topic-specific wording: {word!r}", word not in text)
    # The behaviour-critical instructions must survive the trim.
    for must in ("investigate_live", "get_investigation_result",
                 "escalate_to_support", "generate_mitigation_plan",
                 "timed_out_waiting", "not_onboarded", "start_investigation"):
        _check(f"kept essential instruction: {must}", must in text)


def main() -> int:
    test_cache_ttl_is_per_model()
    test_cache_config_covers_messages_and_tools()
    test_topic_gate_is_an_exclusion_list()
    test_frontend_matches_backend_exclusion_list()
    test_usage_event_reports_cache_hits()
    test_devops_rule_is_topic_agnostic_and_smaller()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
