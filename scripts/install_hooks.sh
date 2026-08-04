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

# Find staged Python files. If none staged, skip — nothing to lint.
mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.py$' || true)

if [ "${#FILES[@]}" -eq 0 ]; then
  exit 0
fi

# Run the i18n lint on the whole repo (baseline-aware), but if it
# fails we'll show the user only the new violations they introduced.
# Cheap enough — the script walks ~40 files in <100 ms.
python scripts/lint_i18n.py
BODY

chmod +x "$HOOK"
echo "Installed pre-commit hook at $HOOK"
echo
echo "To skip the hook for a single commit: git commit --no-verify"
echo "To uninstall: rm $HOOK"
