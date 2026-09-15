#!/usr/bin/env python3
"""Regenerate docs/USER_GUIDE{,.en}.html bodies from the .md sources.

Run from the repo root after editing either USER_GUIDE markdown file:

    python3 scripts/regen_user_guide_html.py

Why this exists: those two html files are the customer-facing rendering of the
guide (the promo site build re-styles them on the way out), but they have no
build step of their own -- so they silently rot whenever the .md is edited, and
the rot is invisible in review because nothing compares the two representations.

The html body is plain `pandoc --from=gfm --to=html5` output; the page around it
is a hand-tuned AWS dark theme that is NOT generated from anything. So: keep the
hand-tuned shell verbatim, swap the body, and refuse to guess if the shell
boundaries cannot be located.

Requires pandoc on PATH (`brew install pandoc`).
"""
import os
import re
import shutil
import subprocess
import sys

DOCS = [
    ("docs/USER_GUIDE.md", "docs/USER_GUIDE.html"),
    ("docs/USER_GUIDE.en.md", "docs/USER_GUIDE.en.html"),
]

OPEN_MARK = '<div class="container">'
FOOT_RE = re.compile(r'^<div class="footer">')


def title_of(md):
    """The page <title> is the markdown's own H1 -- never a second copy of it."""
    for line in open(md, encoding="utf-8"):
        if line.startswith("# "):
            return line[2:].strip()
    sys.exit(f"{md}: no H1 to take the <title> from")


def regen(pandoc, md, html):
    title = title_of(md)
    old = open(html, encoding="utf-8").read().splitlines(keepends=True)

    open_at = next((i for i, l in enumerate(old) if l.strip() == OPEN_MARK), None)
    foot_at = next((i for i, l in enumerate(old) if FOOT_RE.match(l)), None)
    if open_at is None or foot_at is None or foot_at <= open_at:
        sys.exit(f"{html}: could not find the body boundaries -- refusing to guess")

    head = "".join(old[: open_at + 1])
    foot = "".join(old[foot_at:])

    # Each html carried DEPLOYMENT.html's <title> for a while; pin it explicitly.
    head, n = re.subn(r"<title>.*?</title>", f"<title>{title}</title>", head,
                      count=1, flags=re.S)
    if n != 1:
        sys.exit(f"{html}: no <title> to replace")

    body = subprocess.run([pandoc, "--from=gfm", "--to=html5", md],
                          capture_output=True, text=True, check=True).stdout

    out = head + body.rstrip("\n") + "\n" + foot
    open(html, "w", encoding="utf-8").write(out)
    print(f"{html}: {len(out.splitlines())} lines "
          f"(body {len(body.splitlines())} lines) title={title!r}")


if __name__ == "__main__":
    pandoc = shutil.which("pandoc") or "/opt/homebrew/bin/pandoc"
    if not os.path.exists(pandoc) and not shutil.which(pandoc):
        sys.exit("pandoc not found on PATH -- install it (brew install pandoc)")
    for md, html in DOCS:
        regen(pandoc, md, html)
