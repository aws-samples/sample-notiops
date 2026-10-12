#!/usr/bin/env bash
# 重新生成 agent 依赖的精确版本表：agent-build/NotiOpsWebChat/agent-constraints.txt
#
# 什么时候跑：改了 agent 的 pyproject.toml 范围、要排除一个坏版本、或者想把依赖升到当天最新时。
# 平时**不用**跑 —— 版本表不变，每次部署装到的就是同一组版本（这正是钉它的目的）。
#
# 做三件事：
#   1. 按托管运行时的平台重新解析（与 agentcore CLI 打包的参数一致：linux/aarch64、
#      agentcore.json 里的 Python 版本、只要 wheel）；**不带**旧版本表，否则永远升不上去；
#   2. 保留文件头注释，替换版本行，打印哪些包变了版本；
#   3. 跑 scripts/verify_agent_deps.py（按新版本表真装真 import）—— 不过就不算刷新成功。
#
# 刷新之后照常走 MR：tests/test_agent_constraints.py 会核对新版本表与 pyproject 的范围、
# 已知坏版本台账是否一致；上现网前在验证账号跑一遍部署（清单 §3.269）。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$PROJECT_ROOT/agent-build/NotiOpsWebChat"
MANIFEST="$AGENT_DIR/app/NotiOpsWebChat/pyproject.toml"
OUT="$AGENT_DIR/agent-constraints.txt"

command -v uv >/dev/null 2>&1 || { echo "❌ uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2; exit 1; }

PYVER="$(python3 - "$AGENT_DIR/agentcore/agentcore.json" <<'PY'
import json, re, sys
rt = json.load(open(sys.argv[1]))["runtimes"][0].get("runtimeVersion", "")
m = re.fullmatch(r"PYTHON_(\d+)_(\d+)", rt)
print(f"{m.group(1)}.{m.group(2)}" if m else "")
PY
)"
[ -n "$PYVER" ] || { echo "❌ cannot read runtimeVersion from agentcore/agentcore.json" >&2; exit 1; }

TMP="$(mktemp "${TMPDIR:-/tmp}/notiops-constraints.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
echo "Resolving for linux/aarch64, Python $PYVER (wheels only)..."
env -u UV_CONSTRAINT uv pip compile "$MANIFEST" \
  --python-version "$PYVER" --python-platform aarch64-manylinux2014 --only-binary :all: \
  --no-header --no-annotate --quiet -o "$TMP"

python3 - "$OUT" "$TMP" <<'PY'
import datetime, os, re, sys
out_path, new_path = sys.argv[1], sys.argv[2]
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()

def pins(lines):
    d = {}
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#") and "==" in line:
            name, ver = line.split("==", 1)
            d[norm(name.split("[", 1)[0])] = ver.strip()
    return d

old_lines = open(out_path, encoding="utf-8").read().splitlines() if os.path.exists(out_path) else []
header = []
for line in old_lines:
    if line.startswith("#") or not line.strip():
        header.append(line)
    else:
        break
new = pins(open(new_path, encoding="utf-8"))
old = pins(old_lines)
stamp = f"# 当前这组版本 = {datetime.date.today().isoformat()} 由 scripts/refresh_agent_constraints.sh 重新解析（{len(new)} 个包）。"
header = [l for l in header if not l.startswith("# 当前这组版本 =")]
while header and header[-1].strip() in ("", "#"):
    header.pop()
header += ["#", stamp] if header else [stamp]
with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(header) + "\n")
    f.write("".join(f"{n}=={v}\n" for n, v in sorted(new.items())))
changed = sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
print(f"{len(new)} packages pinned; {len(changed)} changed")
for k in changed:
    print(f"  {k}: {old.get(k, '(new)')} -> {new.get(k, '(removed)')}")
PY

python3 "$PROJECT_ROOT/scripts/verify_agent_deps.py"
echo "✓ $OUT refreshed and verified."
