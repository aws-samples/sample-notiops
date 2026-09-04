#!/usr/bin/env python3
"""Configure inspection push delivery from the CLI .

WHY THIS EXISTS
---------------
Two config rows have no write path anywhere else in the product:

    inspchat#target              who receives the push
    inspsched#config / SK=push   when the push goes out

The BFF exposes exactly three inspection write endpoints (scope / renew /
schedule) and `putSchedule` rejects any run type outside {high, idle}, so
`SK=push` cannot be reached through it. Without this script an operator has to
hand-write DynamoDB items -- and a deployment with zero delivery targets looks
completely healthy: the pipeline runs, the dashboard fills up, and nobody
receives anything.

This is deliberately a script and not a UI. Delivery targets are set once at
onboarding; building an admin page for them would need a new capability node,
new authz wiring, and a new frontend route -- none of which the feature needs
to be usable.

USAGE
-----
    # list what is configured now
    python3 scripts/inspection_config.py list

    # add / update a delivery target
    python3 scripts/inspection_config.py add-target \\
        --platform feishu --chat-id oc_xxx \\
        --accounts '*' --locale zh --severity-min CRITICAL

    # scope a target to specific accounts (repeat --accounts or comma-separate)
    python3 scripts/inspection_config.py add-target \\
        --platform slack --chat-id C0123 --accounts 111111111111,222222222222

    # disable a target without deleting it
    python3 scripts/inspection_config.py add-target \\
        --platform feishu --chat-id oc_xxx --disabled

    # change the push window (times are UTC -- see PushWindow's docstring)
    python3 scripts/inspection_config.py set-window --at-utc 03:00 --weekdays 1,2,3,4,5

    # dry-run the resolver against what is stored (no writes, no delivery)
    python3 scripts/inspection_config.py check

Environment: INSPECTION_TABLE (default notiops-inspection), AWS_REGION
(default ap-northeast-1). Standard AWS credential resolution applies.
"""
from __future__ import annotations

import argparse
import os
import sys


TABLE_MISSING_HINT = """
The inspection table does not exist in this account/region yet.

That means the inspection stack has not been deployed here -- delivery targets
live in that table, so there is nothing to configure until it exists:

    ./setup.sh                      # creates notiops-inspection
    python3 scripts/inspection_config.py list

If the table lives elsewhere, point at it explicitly:

    INSPECTION_TABLE=<name> AWS_REGION=<region> python3 scripts/inspection_config.py list
"""


def _store():
    """Build the store, and fail with an actionable message if the table is
    missing.

    Verified against a real account: without this check the raw error is
    `StoreError: query 失败: ... ResourceNotFoundException`, which does not tell
    the operator the actionable fact -- that inspection simply is not deployed
    in this region yet.
    """
    import boto3
    from botocore.exceptions import ClientError

    from inspection.adapters.store import InspectionStore

    table = os.environ.get("INSPECTION_TABLE", "notiops-inspection")
    region = os.environ.get("AWS_REGION", "ap-northeast-1")
    print(f"table={table} region={region}")

    # describe_table up front: one cheap call turns every downstream
    # ResourceNotFoundException into a single clear message.
    try:
        boto3.client("dynamodb", region_name=region).describe_table(
            TableName=table)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            print(TABLE_MISSING_HINT.strip())
            raise SystemExit(2) from None
        raise

    ddb = boto3.resource("dynamodb", region_name=region)
    return InspectionStore(ddb.Table(table))


def _split(values: list[str] | None) -> list[str]:
    """`--accounts a,b --accounts c` and `--accounts a --accounts b` both work."""
    out: list[str] = []
    for v in values or []:
        out.extend(p.strip() for p in str(v).split(",") if p.strip())
    return out


def cmd_list(args: argparse.Namespace) -> int:
    from inspection.domain.push_policy import push_window_from_item
    from inspection.domain.targets import resolve_inspection_targets

    store = _store()
    rows = store.list_chat_targets()
    print(f"\n--- delivery targets ({len(rows)} rows) ---")
    if not rows:
        print("  (none)  <-- nobody will receive any push")
    resolved = resolve_inspection_targets(rows)
    for t in resolved.targets:
        print(f"  OK       {t.key}  accounts={list(t.accounts)} "
              f"locale={t.locale} severity_min={t.severity_min}")
    for t, reason in resolved.rejected:
        print(f"  REJECTED {t.key}  {reason.value}")
    for key, note in resolved.warnings:
        print(f"  WARN     {key}  {note}")

    cfg = push_window_from_item(store.load_push_window())
    print("\n--- push window ---")
    print(f"  enabled={cfg.enabled} at_utc={cfg.at_utc} "
          f"weekdays={sorted(cfg.weekdays)} window_minutes={cfg.window_minutes} "
          f"tz_label={cfg.tz_label}")
    if store.load_push_window() is None:
        print("  (no row stored -- these are the defaults)")
    return 0


def cmd_add_target(args: argparse.Namespace) -> int:
    from inspection.domain.targets import (
        LOCALES, PLATFORMS, resolve_inspection_targets,
    )

    if args.platform not in PLATFORMS:
        print(f"error: --platform must be one of {list(PLATFORMS)}")
        return 2
    if args.locale not in LOCALES:
        print(f"error: --locale must be one of {list(LOCALES)}")
        return 2
    accounts = _split(args.accounts)
    if not accounts:
        # Mirrors RejectReason.NO_ACCOUNTS -- an empty list literally means
        # "this chat sees nothing", so refuse to write it rather than store a
        # row that will be silently rejected at push time.
        print("error: --accounts is required ('*' for all accounts). "
              "An empty list means the chat sees nothing.")
        return 2

    item = {
        "platform": args.platform,
        "chat_id": args.chat_id,
        "accounts": accounts,
        "locale": args.locale,
        "severity_min": args.severity_min.upper(),
        "enabled": not args.disabled,
    }
    if args.note:
        item["note"] = args.note

    store = _store()
    store.put_chat_target(item)
    print(f"\nwrote {args.platform}#{args.chat_id}")

    # Immediately re-resolve: a row that the resolver rejects is worse than no
    # row, because the operator believes it is configured.
    resolved = resolve_inspection_targets(store.list_chat_targets())
    for t, reason in resolved.rejected:
        if t.platform == args.platform and t.chat_id == args.chat_id:
            print(f"WARNING: the row was written but the resolver REJECTS it: "
                  f"{reason.value}")
            from inspection.domain.targets import reject_text
            print(f"         {reject_text(reason)}")
            return 1
    print("resolver accepts it")
    return 0


def cmd_set_window(args: argparse.Namespace) -> int:
    from datetime import time as _time

    from inspection.domain.push_policy import (
        PushWindow, push_window_from_item, push_window_to_item,
    )

    store = _store()
    current = push_window_from_item(store.load_push_window())

    at_utc = current.at_utc
    if args.at_utc:
        try:
            at_utc = _time.fromisoformat(args.at_utc)
        except ValueError:
            print(f"error: --at-utc must be HH:MM (got {args.at_utc!r})")
            return 2

    weekdays = current.weekdays
    if args.weekdays:
        try:
            parsed = frozenset(int(d) for d in _split([args.weekdays]))
        except ValueError:
            print("error: --weekdays must be comma-separated 1..7 (1=Monday)")
            return 2
        bad = [d for d in parsed if not 1 <= d <= 7]
        if bad or not parsed:
            print(f"error: --weekdays out of range: {bad or 'empty'}")
            return 2
        weekdays = parsed

    cfg = PushWindow(
        enabled=current.enabled if args.enabled is None else args.enabled,
        at_utc=at_utc,
        weekdays=weekdays,
        window_minutes=args.window_minutes or current.window_minutes,
        tz_label=args.tz_label or current.tz_label,
    )
    store.put_push_window(push_window_to_item(cfg))
    print(f"\nwrote push window: enabled={cfg.enabled} at_utc={cfg.at_utc} "
          f"weekdays={sorted(cfg.weekdays)}")

    # The window must land AFTER the inspection run, otherwise every push
    # carries yesterday's numbers under today's date.
    from inspection.domain.schedule import RunType
    runs = {c.run_type: c for c in store.load_schedules()}
    high = runs.get(RunType.HIGH)
    if high and cfg.at_utc <= high.at_utc:
        print(f"WARNING: push at {cfg.at_utc} UTC is NOT after the high-load "
              f"run at {high.at_utc} UTC -- the push would carry the previous "
              f"day's results. (The has_run_today gate stops it entirely.)")
        return 1
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Resolve what is stored and say who would receive what. No writes."""
    from inspection.domain.push_policy import kinds_due, push_window_from_item
    from inspection.domain.targets import resolve_inspection_targets

    store = _store()
    resolved = resolve_inspection_targets(store.list_chat_targets())
    cfg = push_window_from_item(store.load_push_window())

    print("\n--- would-deliver check ---")
    if resolved.is_empty:
        print("  FAIL no usable delivery target -- nobody receives any push")
        return 1
    print(f"  {len(resolved.targets)} usable target(s), "
          f"{len(resolved.rejected)} rejected")

    # Show the next few ticks that would fire, so the operator can tell
    # "configured but never fires" from "configured correctly".
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    fired = []
    probe = now.replace(second=0, microsecond=0)
    for i in range(8 * 24 * 4):        # 8 days of 15-minute ticks
        moment = probe + timedelta(minutes=15 * i)
        kinds = kinds_due(moment, cfg)
        if kinds:
            fired.append((moment, [k.value for k in kinds]))
        if len(fired) >= 3:
            break
    if not fired:
        print("  FAIL the window never fires in the next 8 days "
              f"(enabled={cfg.enabled} at_utc={cfg.at_utc} "
              f"weekdays={sorted(cfg.weekdays)})")
        return 1
    for moment, kinds in fired:
        print(f"  next fire {moment.isoformat()} -> {kinds}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Configure inspection push delivery targets and window.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="show configured targets and window")
    sub.add_parser("check", help="resolve config and report who would receive")

    t = sub.add_parser("add-target", help="add or update a delivery target")
    t.add_argument("--platform", required=True,
                   help="feishu | slack | dingtalk")
    t.add_argument("--chat-id", required=True,
                   help="Feishu chat_id / Slack channel id "
                        "(DingTalk ignores it -- one webhook = one group)")
    t.add_argument("--accounts", action="append",
                   help="'*' for all, or 12-digit account ids "
                        "(comma-separated or repeated)")
    t.add_argument("--locale", default="zh", help="zh | en (default zh)")
    t.add_argument("--severity-min", default="CRITICAL",
                   help="CRITICAL | HIGH | MEDIUM | INFO (default CRITICAL, "
                        "which is grayscale stage 3)")
    t.add_argument("--disabled", action="store_true",
                   help="write the row but keep it switched off")
    t.add_argument("--note", default="", help="free-text note")

    w = sub.add_parser("set-window", help="change the push time window")
    w.add_argument("--at-utc", help="HH:MM in UTC (default 03:00)")
    w.add_argument("--weekdays", help="comma-separated 1..7, 1=Monday")
    w.add_argument("--window-minutes", type=int)
    w.add_argument("--tz-label", help="display label only, drives nothing")
    w.add_argument("--enable", dest="enabled", action="store_true", default=None)
    w.add_argument("--disable", dest="enabled", action="store_false")

    args = ap.parse_args()
    handlers = {"list": cmd_list, "check": cmd_check,
                "add-target": cmd_add_target, "set-window": cmd_set_window}
    try:
        return handlers[args.cmd](args)
    except Exception as e:                            # noqa: BLE001
        print(f"error: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
