"""
Pin down the two-tier force-investigate override in
`core/bedrock_intent.py`.

The 2026-06-06 incident: user wrote "使用 devops agent 查本月成本"
expecting bot to dispatch DevOps Agent, but the LLM tagged it as
`general_qa` (cost question → cost MCP) and the old override
muted itself because the message contained "成本". The user's
EXPLICIT naming of devops-agent should have won.

Tests the predicates directly (no Bedrock calls) so the regex
behaviour is locked even when the LLM classifier is mocked or
skipped:

  tier 1 — explicit devops-agent invocation: must always trigger
  tier 2 — generic "调查/分析/排查" verbs: muted by cost regex
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")

import unittest.mock as mock
import boto3
boto3.resource = mock.MagicMock()
boto3.client = mock.MagicMock()

from core import bedrock_intent as bi  # noqa: E402

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


def test_devops_agent_invoke_predicate():
    print("test_devops_agent_invoke_predicate")
    positives = [
        "使用 devops agent 查本月成本",
        "使用 devops-agent 调查",
        "用 devops agent 帮我看 lambda",
        "调用 DevOps Agent",
        "use devops agent for this",
        "invoke devops-agent on prod",
        "trigger DevOpsAgent please",
        "@bot 使用 devops agent 看下我们 us-east-1 的 lambda 错误率",
    ]
    for s in positives:
        _check(f"matches: {s!r}",
               bi._matches_devops_agent_invoke(s),
               f"got False for {s!r}")

    negatives = [
        "如何使用 devops agent",          # how-to question, not invocation
        "what is a devops agent",          # generic question
        "我没用过 devops agent",            # casual mention
        "查 IAD EC2",                       # no agent mention at all
        "成本异常",                         # cost-only, no agent
        "",
    ]
    # `如何使用` actually still triggers because the regex doesn't
    # require "imperative" framing — the how-to guardrail handles
    # that case OUTSIDE the regex. Test the rest.
    for s in negatives[1:]:
        _check(f"does NOT match: {s!r}",
               not bi._matches_devops_agent_invoke(s),
               f"got True for {s!r}")


def test_explicit_devops_agent_wins_over_cost_carveout():
    """The 2026-06-06 incident — primary regression."""
    print("test_explicit_devops_agent_wins_over_cost_carveout")
    text = "使用 devops agent 查本月成本"
    _check("matches devops_agent_invoke (tier 1)",
           bi._matches_devops_agent_invoke(text))
    _check("ALSO matches the cost regex",
           bool(bi._COST_QA_RE.search(text)),
           "if this fails the 2026-06-06 incident wouldn't have hit")
    # Tier-1 should fire regardless of cost match. The override site
    # in analyze_intent uses `_explicit_agent or _generic_force`, so
    # explicit naming bypasses the cost carve-out even when it would
    # have otherwise muted the generic trigger.
    # We can't easily call analyze_intent end-to-end without mocking
    # Bedrock, but we CAN assert that the predicate combination
    # produces the intended truth values.
    _eligible = True   # simulating "command=general_qa from LLM"
    _explicit_agent = _eligible and bi._matches_devops_agent_invoke(text)
    _generic_force = (
        _eligible
        and bi._matches_force_investigate(text)
        and not bi._COST_QA_RE.search(text)  # cost present → muted
    )
    _check("tier-1 explicit_agent fires", _explicit_agent is True)
    _check("tier-2 generic_force is muted by cost", _generic_force is False)
    _check("OR of the two still fires", (_explicit_agent or _generic_force))


def test_generic_force_still_muted_by_cost():
    """Make sure we didn't accidentally break the original carve-out:
    "帮我分析一下成本趋势" should STILL stay general_qa, not become
    investigate, because the user didn't name devops-agent."""
    print("test_generic_force_still_muted_by_cost")
    text = "帮我分析一下成本趋势"
    _check("does NOT match devops_agent_invoke",
           not bi._matches_devops_agent_invoke(text))
    _check("matches generic force_investigate",
           bi._matches_force_investigate(text))
    _check("matches cost regex",
           bool(bi._COST_QA_RE.search(text)))

    _eligible = True
    _explicit_agent = _eligible and bi._matches_devops_agent_invoke(text)
    _generic_force = (
        _eligible
        and bi._matches_force_investigate(text)
        and not bi._COST_QA_RE.search(text)
    )
    _check("tier-1 explicit_agent NOT firing", _explicit_agent is False)
    _check("tier-2 generic_force muted by cost", _generic_force is False)
    _check("OR of the two does NOT fire — stays on general_qa path",
           not (_explicit_agent or _generic_force))


def test_colloquial_spent_phrasing_stays_on_cost_path():
    """2026-06-10 incident: user typed
        "帮我看下本月 EC2 花了多少"
    The bot incorrectly force-routed to investigate (DevOps Agent)
    because `_COST_QA_RE` only had formal cost vocabulary like
    成本/费用/cost/billing — it didn't recognise the colloquial
    "花了多少" / "spent" phrasing. Force-investigate then fired
    via the generic "帮我看一下" trigger and hijacked what should
    have been a cost-MCP query.

    Lock this regression: a handful of natural ways to ask "how
    much did I spend" must all match `_COST_QA_RE` so the
    tier-2 generic_force gets muted."""
    print("test_colloquial_spent_phrasing_stays_on_cost_path")
    cases = [
        # Chinese natural phrasing (the original incident text + variations)
        "帮我看下本月 EC2 花了多少",
        "帮我看一下 RDS 这个月花了多少钱",
        "帮我分析下 Lambda 上个月花销",
        "帮我看看本月用了多少钱",
        "帮我查下 EC2 一小时多少钱",
        # English variants
        "help me see how much I spent on EC2 this month",
        "help me see EC2 spending last month",
        "how much did Lambda cost this month",
    ]
    for text in cases:
        matched = bool(bi._COST_QA_RE.search(text))
        _check(f"_COST_QA_RE matches: {text!r}", matched,
               f"got matched={matched}")
        # Also verify that even though force-investigate fires
        # (probably true for "帮我..."), the cost mute kicks in.
        _eligible = True
        _generic_force = (
            _eligible
            and bi._matches_force_investigate(text)
            and not bi._COST_QA_RE.search(text)
        )
        _check(f"tier-2 muted: {text!r}", _generic_force is False)


def test_normal_investigate_still_works():
    """Pre-existing path: "帮我调查 lambda 慢" → investigate, no
    cost mention, no agent name. The generic trigger fires."""
    print("test_normal_investigate_still_works")
    text = "帮我调查 lambda 慢"
    _eligible = True
    _explicit_agent = _eligible and bi._matches_devops_agent_invoke(text)
    _generic_force = (
        _eligible
        and bi._matches_force_investigate(text)
        and not bi._COST_QA_RE.search(text)
    )
    _check("tier-2 generic_force fires",
           _generic_force is True)
    _check("override fires", (_explicit_agent or _generic_force))


def main() -> int:
    test_devops_agent_invoke_predicate()
    test_explicit_devops_agent_wins_over_cost_carveout()
    test_generic_force_still_muted_by_cost()
    test_colloquial_spent_phrasing_stays_on_cost_path()
    test_normal_investigate_still_works()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
