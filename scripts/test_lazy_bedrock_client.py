#!/usr/bin/env python3
"""Pin the botocore behaviour the Bedrock API-key feature depends on.

Two things are asserted here, and they are the reason `core/lazy_boto.py`
exists at all:

  1. Importing any `core/` module must NOT construct a bedrock-runtime client.
     Import-time construction is what breaks api_key mode (see 2) and also
     makes a bare `import` require a resolvable AWS region.

  2. The construction-order contract, measured rather than assumed:

       setenv → construct   ⇒  Authorization: Bearer <token>
       construct → setenv   ⇒  NoAuthTokenError on every call
       construct → unsetenv ⇒  back to SigV4, no rebuild needed

     botocore resolves *which* signer to use per request (reading
     AWS_BEARER_TOKEN_BEDROCK live) but builds the *token provider* once at
     client construction. When those disagree, Bedrock traffic fails hard —
     it does not quietly fall back to the IAM role. A botocore upgrade that
     changed this would silently invalidate the design, so it is pinned.

No network: a `before-send` hook short-circuits every request with a canned
response, and the token is fake.

Run: PYTHONPATH=. python3 scripts/test_lazy_bedrock_client.py
"""
from __future__ import annotations

import os
import sys

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

# A syntactically plausible but entirely fake token. Never a real credential.
_FAKE_TOKEN = "bedrock-api-key-placeholder-for-tests"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _check(name: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {name}")
    else:
        _failed += 1
        print(f"  {FAIL} {name}" + (f" :: {detail}" if detail else ""))


def _base_env() -> None:
    os.environ["AWS_DEFAULT_REGION"] = "us-east-1"
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
    os.environ.setdefault(
        "AWS_SECRET_ACCESS_KEY",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    )
    os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)


def test_import_builds_no_bedrock_client() -> None:
    """Importing core modules must not construct a bedrock-runtime client."""
    print("test_import_builds_no_bedrock_client")
    # No region at all: an import-time construction would also raise
    # NoRegionError, so this doubles as a "import works anywhere" check.
    for k in ("AWS_REGION", "AWS_DEFAULT_REGION", "BEDROCK_REGION"):
        os.environ.pop(k, None)

    import boto3

    built: list[str] = []
    original = boto3.client

    def spy(service, *a, **kw):
        built.append(service)
        return original(service, *a, **kw)

    boto3.client = spy
    try:
        for mod in ("bedrock_intent", "case_analyze", "case_classifier",
                    "next_steps", "progress_card", "skill_authoring",
                    "skill_dispatcher", "bedrock_chat"):
            __import__(f"core.{mod}")
    finally:
        boto3.client = original

    bedrock_built = [s for s in built if s == "bedrock-runtime"]
    _check("no bedrock-runtime client built during import",
           not bedrock_built, f"built={bedrock_built}")

    # The proxy must still be usable exactly like a client object: attribute
    # access forwards, and truthiness holds (call sites do `x or _bedrock`).
    from core import bedrock_intent
    _check("_bedrock is truthy (call sites rely on `client or _bedrock`)",
           bool(bedrock_intent._bedrock))
    _check("_bedrock is a lazy proxy, not a built client",
           type(bedrock_intent._bedrock).__name__ == "LazyClient",
           type(bedrock_intent._bedrock).__name__)


def _probe_auth_scheme(client) -> tuple[str, str]:
    """Issue one Converse call, short-circuited before the wire.

    Returns (auth_scheme, error_type). `auth_scheme` is the first token of the
    Authorization header ("Bearer" / "AWS4-HMAC-SHA256") or "" when the request
    never got signed.
    """
    from botocore.awsrequest import AWSResponse

    seen: dict[str, str] = {}

    def capture(request, **kwargs):
        raw = request.headers.get("Authorization", b"")
        seen["auth"] = raw.decode() if isinstance(raw, bytes) else str(raw)
        return AWSResponse(request.url, 200, {}, b"{}")

    client.meta.events.register("before-send.bedrock-runtime.Converse", capture)
    err = ""
    try:
        client.converse(modelId="global.anthropic.claude-sonnet-5",
                        messages=[{"role": "user", "content": [{"text": "x"}]}])
    except Exception as e:  # noqa: BLE001 — the canned response isn't a real stream
        err = type(e).__name__
    finally:
        client.meta.events.unregister("before-send.bedrock-runtime.Converse", capture)

    auth = seen.get("auth", "")
    return (auth.split(" ")[0] if auth else ""), err


def test_construction_order_contract() -> None:
    print("test_construction_order_contract")
    _base_env()
    import boto3

    # (a) token present BEFORE construction → bearer auth, token on the wire
    os.environ["AWS_BEARER_TOKEN_BEDROCK"] = _FAKE_TOKEN
    good = boto3.client("bedrock-runtime")
    scheme, _ = _probe_auth_scheme(good)
    _check("setenv then construct → Bearer", scheme == "Bearer", f"scheme={scheme!r}")

    # (b) construct WITHOUT the token, then set it → hard failure.
    #     This is the regression the lazy proxy prevents.
    _base_env()
    stale = boto3.client("bedrock-runtime")
    scheme, _ = _probe_auth_scheme(stale)
    _check("no token → SigV4", scheme == "AWS4-HMAC-SHA256", f"scheme={scheme!r}")

    os.environ["AWS_BEARER_TOKEN_BEDROCK"] = _FAKE_TOKEN
    scheme, err = _probe_auth_scheme(stale)
    _check("construct then setenv → NoAuthTokenError (not a silent IAM fallback)",
           err == "NoAuthTokenError", f"scheme={scheme!r} err={err!r}")

    # (c) clearing the token on an existing client reverts to SigV4 by itself
    os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)
    scheme, _ = _probe_auth_scheme(good)
    _check("unsetenv on a bearer client → back to SigV4 without a rebuild",
           scheme == "AWS4-HMAC-SHA256", f"scheme={scheme!r}")


def test_reset_rebuilds() -> None:
    print("test_reset_rebuilds")
    _base_env()
    from core.lazy_boto import LazyClient

    lc = LazyClient("bedrock-runtime", region="us-east-1")
    first = lc._resolve()
    _check("second access reuses the same client", lc._resolve() is first)
    lc.reset()
    _check("reset() forces a rebuild", lc._resolve() is not first)


def test_proxy_stays_patchable_and_copyable() -> None:
    """The proxy must not break the ways the existing tests reach the client.

    All three of these were broken by the first version of `LazyClient`, which
    used `__slots__` and forwarded every name:
      * `mock.patch.object(mod._bedrock, "invoke_model")` — no `__dict__`, so
        setattr failed and `scripts/test_case_analyze_intent.py` aborted at its
        first NL test. It is not in CI, which is why nobody noticed.
      * `copy.copy` / `pickle` — recursion during reconstruction.
      * `hasattr(lc, "__deepcopy__")` — built a real AWS client just to answer a
        protocol probe, defeating the laziness (and raising NoRegionError instead
        of returning False where no region is configured).
    """
    print("test_proxy_stays_patchable_and_copyable")
    _base_env()
    import copy as _copy
    from unittest import mock

    from core.lazy_boto import LazyClient

    lc = LazyClient("bedrock-runtime", region="us-east-1")

    _check("a dunder probe does not build the client",
           hasattr(lc, "__deepcopy__") is False and lc._real is None)

    try:
        _copy.copy(lc)
        _check("copy.copy does not recurse", True)
    except RecursionError:
        _check("copy.copy does not recurse", False, "RecursionError")
    except Exception as e:  # noqa: BLE001
        _check("copy.copy does not recurse", False, type(e).__name__)

    _check("proxy is truthy (call sites rely on `client or _bedrock`)", bool(lc))

    try:
        with mock.patch.object(lc, "invoke_model", return_value={"patched": True}):
            got = lc.invoke_model()
        _check("mock.patch.object on the proxy works", got == {"patched": True}, repr(got))
        _check("patch is removed on exit", "invoke_model" not in lc.__dict__)
    except Exception as e:  # noqa: BLE001
        _check("mock.patch.object on the proxy works", False, f"{type(e).__name__}: {e}")

    # Patching the *module* attribute (15 existing call sites do this) must also
    # keep working — the proxy is just a value there.
    from core import bedrock_intent
    sentinel = object()
    with mock.patch.object(bedrock_intent, "_bedrock", sentinel):
        _check("patching the module attribute still works",
               bedrock_intent._bedrock is sentinel)


def main() -> int:
    test_import_builds_no_bedrock_client()
    test_construction_order_contract()
    test_reset_rebuilds()
    test_proxy_stays_patchable_and_copyable()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
