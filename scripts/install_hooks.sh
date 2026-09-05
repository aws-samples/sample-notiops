#!/usr/bin/env bash
# Install local git hooks. Run once after clone.
#
#   ./scripts/install_hooks.sh
#
# Sets up:
#   - .git/hooks/pre-commit  → runs scripts/lint_i18n.py on staged
#                              files. Fails the commit on any new
#                              i18n violation.
#
# Why a script (not core.hooksPath)?  We don't want to clobber a
# developer's existing global hooks. This installs a single file and
# is idempotent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/.git/hooks/pre-commit"

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "error: $REPO_ROOT is not a git repo" >&2
  exit 1
fi

cat > "$HOOK" <<'BODY'
#!/usr/bin/env bash
# notiops-devops pre-commit hook — installed by scripts/install_hooks.sh.
# Keep this body minimal; real logic lives in scripts/lint_i18n.py so
# editing it doesn't require re-installing the hook.

set -euo pipefail

# Staged files this lint can have an opinion about. **Not just .py**:
# lint_i18n.py also checks the frontend (every t("a.b.c") exists in
# i18n.ts, and every key is still referenced), so a pure .ts/.tsx change
# is exactly the kind that needs it.
#
# Plain string, not an array: `mapfile` is bash 4+ and macOS ships bash
# 3.2, and under `set -u` bash 3.2 also treats `${#ARR[@]}` on an empty
# array as unbound. Either one exits 127/1 **before** the "nothing
# staged" check, i.e. every commit on a Mac fails and this gate never
# actually runs. Same class of trap as the 12 fixed in `5dcb9fc`.
STAGED="$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.(py|ts|tsx)$' || true)"

if [ -z "$STAGED" ]; then
  exit 0
fi

# `python3`, not `python`: modern macOS has no bare `python`, and a dev
# shell without the repo .venv activated would fail on it.
PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

# Run the i18n lint on the whole repo (baseline-aware), but if it
# fails we'll show the user only the new violations they introduced.
# Cheap enough — the script walks ~40 files in <100 ms.
"$PY" scripts/lint_i18n.py
BODY

chmod +x "$HOOK"
echo "Installed pre-commit hook at $HOOK"
echo
echo "To skip the hook for a single commit: git commit --no-verify"
echo "To uninstall: rm $HOOK"
