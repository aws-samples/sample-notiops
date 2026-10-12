#!/usr/bin/env python3
"""Fail if any one-click release artifact contains a builder-local absolute path.

Usage: python3 scripts/check_artifacts_no_local_paths.py <dist/oneclick>

Why this exists (2026-10-11, before v1.0.30 went public): the release zips are public
GitHub Release assets, and the only content check on them at release time asks
"is every repo file in a zip also in the public snapshot?" -- it cannot see what the BUILD
writes into third-party files. pip's console-script wrappers in the two dependency layers
(`python/bin/*`) started with the builder's venv interpreter path, so a layer built from a
developer checkout carried that developer's home directory and username.

Checked: every file inside every *.zip in the directory, plus the other files there (the
template and SHA256SUMS). Needles: $HOME and the repo root, each as given and as resolved
(macOS /tmp is a symlink to /private/tmp). Third-party documentation that happens to show
some other user's home directory (e.g. "/Users/<someone>/.kube/config") is not a hit.

Not checked on purpose: the temp directory pip compiles in. CPython writes the source path
into each .pyc; for the layers that is pip's own throwaway target under $TMPDIR, which
identifies nobody and changes on every build.

Also checked (2026-10-11): the VALUES in the builder's local frontend env files
(`frontend/*/.env*`, git-ignored). Vite reads `.env.local` in production builds too, and
the chat app used to keep a fallback config built from `import.meta.env.VITE_*` -- that is
how an old, long-deleted environment's BFF URL and Cognito pool IDs ended up inside the
published chat-dist.zip. The code no longer has a production fallback; this is the backstop.
Values shorter than 12 characters and plain region names are not used as needles (too
generic). Hits are reported by variable name and file, never by value.
"""
from __future__ import annotations

import os
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MAX_REPORT = 20


_REGION = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")


def needles() -> list[bytes]:
    raw = {os.path.expanduser("~"), str(REPO), os.path.realpath(os.path.expanduser("~")),
           os.path.realpath(str(REPO)), os.path.abspath(str(REPO))}
    # never use a needle so short that it matches everything ("/", "/root" on a CI box, ...)
    return sorted({p.rstrip("/").encode() for p in raw if len(p.rstrip("/")) >= 8})


def env_value_needles(root: Path) -> dict[bytes, str]:
    """Values from `<root>/frontend/*/.env*` -> label ("VITE_X in frontend/chat-app/.env.local")."""
    out: dict[bytes, str] = {}
    for f in sorted(root.glob("frontend/*/.env*")):
        if not f.is_file():
            continue
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if len(v) < 12 or _REGION.match(v):
                continue
            out.setdefault(v.encode(), f"{k.strip()} in {f.relative_to(root)}")
    return out


def scan(out_dir: Path, extra: dict[bytes, str] | None = None) -> list[tuple[str, str, str]]:
    """Hits as (artifact, entry, what). `what` is a path needle, or the label of an env value."""
    ns = needles()
    labels = dict(extra or {})
    ns = ns + [n for n in labels if n not in ns]
    hits: list[tuple[str, str, str]] = []
    for f in sorted(out_dir.iterdir()):
        if not f.is_file():
            continue
        if f.suffix == ".zip":
            with zipfile.ZipFile(f) as z:
                for info in z.infolist():
                    if info.is_dir():
                        continue
                    data = z.read(info)
                    for n in ns:
                        if n in data:
                            hits.append((f.name, info.filename, labels.get(n) or n.decode()))
                            break
        else:
            data = f.read_bytes()
            for n in ns:
                if n in data:
                    hits.append((f.name, "", labels.get(n) or n.decode()))
                    break
    return hits


def main() -> int:
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_dir():
        sys.exit("usage: check_artifacts_no_local_paths.py <dist/oneclick>")
    hits = scan(Path(sys.argv[1]), extra=env_value_needles(REPO))
    if not hits:
        print("  no builder-local paths in any artifact")
        return 0
    home = os.path.expanduser("~")
    print(f"✗ {len(hits)} file(s) in the release artifacts contain a builder-local absolute path "
          "or a value from the builder's local frontend env files (these files are published on GitHub):",
          file=sys.stderr)
    for art, entry, needle in hits[:MAX_REPORT]:
        shown = needle.replace(home, "$HOME")
        print(f"    {art}{' :: ' + entry if entry else ''}  ({shown})", file=sys.stderr)
    if len(hits) > MAX_REPORT:
        print(f"    … and {len(hits) - MAX_REPORT} more", file=sys.stderr)
    print("  ↳ find which build step wrote it (pip console scripts, compiled bytecode, a copied config, "
          "a Vite build reading .env.local) and exclude or rewrite it there; do not publish these files.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
