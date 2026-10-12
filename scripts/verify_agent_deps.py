#!/usr/bin/env python3
"""真装一遍、真 import 一遍 —— agent 的 strands / bedrock_agentcore 符号级冒烟检查。

## 为什么有这个脚本

2026-09-16 的 Blocker：`strands-agents 1.56.0`（2026-09-15 发布，当天即 PyPI latest）在一个
**minor** 里删掉了公开符号 `BidiAfterInvocationEvent`，而 `bedrock-agentcore 1.23.0` 的
`memory/integrations/strands/session_manager.py:14` 会 import 它。构建 manifest 的上界当时
取在 major（`< 2.0.0`），于是从那一刻起，任何人跑 `setup.sh` 装到的都是必崩的组合：容器每次
启动都在 import 阶段 `ImportError`，而外部症状是四个 CFN 栈全绿 + runtime `status: READY`
+ 聊天永久返回「服务仍在启动中」。**零代码变更**就能被上游一次发布打挂。

`tests/test_agent_dep_bounds.py` 拦的是**已知**坏版本（纯离线，每个 MR 都跑）。这个脚本拦
**未知**的：它把我们代码里每一处 `from strands… import X` / `from bedrock_agentcore… import X`
用 ast 抠出来，在一个干净 venv 里按 manifest 的约束真装一遍，然后逐个 import + getattr。
1.56.0 那次事故，这个脚本一行输出就能定位。

## 什么时候跑

  · **改 agent 依赖约束时**（manifest 文件头写的「抬上界的前提」，现在是一条能跑的命令）；
  · CI 里 manifest 有改动的 MR 自动跑（阻塞）；
  · `--latest` 当**金丝雀**跑（定时任务，不阻塞）：装上游最新版，红就说明上游又破坏了一次，
    这时候**不许**抬上界。这条是把「2026-09-15 当天就该变红」补回来的那一条。

## 用法

    ./scripts/verify_agent_deps.py                  # 按 agent-constraints.txt 的精确版本装（默认）
    ./scripts/verify_agent_deps.py --no-constraints # 只按 manifest 的范围装（当天能解析到的最新版）
    ./scripts/verify_agent_deps.py --latest         # 金丝雀：装上游最新版（无视范围和版本表）
    ./scripts/verify_agent_deps.py --full           # 装 manifest 的全部依赖（慢，最忠实）

只用标准库，不需要先装任何东西（有 `uv` 就用 `uv`，没有就退回 `python -m venv` + pip）。

## 版本表（2026-10-12 起）

部署时实际装到的版本由 `agent-build/NotiOpsWebChat/agent-constraints.txt` 钉死（deploy_agent.sh
把它设成 UV_CONSTRAINT）。所以这里默认也按那份版本表装 —— 验的就是**真正打进包的那一组**。
有 uv 时先离线装（本机缓存命中就几秒），缓存不全才联网重来；`--latest` 金丝雀照旧去拿上游最新版。
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# tomllib 只有 Python ≥ 3.11 才有，而文档与 setup.sh 前置检查认的最低版本是 3.10
# （docs/PREREQUISITES.md §2.1）。之前这里直接 `import tomllib` → 3.10 上 deploy_agent.sh
# 报「Refusing to deploy」退出，setup.sh 整个失败（2026-10-10 发版前审查实测）。
# 退路的顺序：tomllib → tomli（装了就用）→ 下面那个只认 `[project].dependencies` 的严格解析。
try:
    import tomllib as _toml
except ModuleNotFoundError:  # Python 3.10
    try:
        import tomli as _toml  # type: ignore[no-redef]
    except ModuleNotFoundError:
        _toml = None

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "agent-build" / "NotiOpsWebChat" / "app" / "NotiOpsWebChat"
BUILD_MANIFEST = APP_DIR / "pyproject.toml"
# 部署时真正装到的版本（deploy_agent.sh / package_artifacts.sh 都把它设成 UV_CONSTRAINT）。
CONSTRAINTS = REPO_ROOT / "agent-build" / "NotiOpsWebChat" / "agent-constraints.txt"

# 观测的两个顶层包 —— 也就是「上游一发版就能打挂我们」的那两个。
WATCHED_ROOTS = ("strands", "bedrock_agentcore")

# 默认安装集：让上面那些模块能 import 起来所需的最小集合。
# 例如 `strands.models.openai_responses` 顶层 import openai、`strands.tools.mcp` 需要 mcp。
# 名字必须与 manifest 里的写法一致（下面按 manifest 的约束取版本）。
CORE_INSTALL = ["strands-agents", "bedrock-agentcore", "mcp", "openai", "botocore[crt]"]

_NAME_RE = re.compile(r"^\s*(?P<name>[A-Za-z0-9._-]+)\s*(?P<extras>\[[^\]]*\])?\s*(?P<spec>.*)$")


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _project_dependencies_minimal(text: str) -> list[str]:
    """不靠 TOML 库取 `[project]` 表里的 `dependencies = [...]`（只给 Python 3.10 且没装 tomli 时用）。

    只认这个 manifest 实际的写法：双引号字符串数组，可跨行、可带 `#` 注释。逐字符扫，只有
    **字符串外面**的 `]` / `#` 才算语法 —— 依赖串里本来就有方括号（`botocore[crt]`）。
    任何意外形状（没找到、转义、单引号、数组没闭合、解析出 0 条）一律报错退出：宁可停下，
    也不能拿着残缺的依赖清单去「验证」然后放行部署。
    """
    table = re.search(r"(?ms)^\[project\][ \t]*$(.*?)(?=^\[|\Z)", text)
    if not table:
        sys.exit("[verify-deps] pyproject.toml 里找不到 [project] 表")
    body = table.group(1)
    head = re.search(r"(?m)^dependencies\s*=\s*\[", body)
    if not head:
        sys.exit("[verify-deps] pyproject.toml 里找不到 [project].dependencies")
    deps: list[str] = []
    i = head.end()
    while True:
        if i >= len(body):
            sys.exit("[verify-deps] pyproject.toml: [project].dependencies 数组没有闭合")
        c = body[i]
        if c == "#":                       # 注释到行尾
            j = body.find("\n", i)
            i = len(body) if j < 0 else j
        elif c == '"':
            j = body.find('"', i + 1)
            if j < 0:
                sys.exit("[verify-deps] pyproject.toml: dependencies 里有没闭合的字符串")
            item = body[i + 1:j]
            if "\\" in item:
                sys.exit("[verify-deps] pyproject.toml: dependencies 里出现了转义 —— 装 tomli 或用 Python ≥ 3.11 再跑")
            deps.append(item)
            i = j + 1
        elif c == "'":
            sys.exit("[verify-deps] pyproject.toml: dependencies 里出现了单引号字符串 —— 装 tomli 或用 Python ≥ 3.11 再跑")
        elif c == "]":
            break
        else:
            i += 1
    if not deps:
        sys.exit("[verify-deps] pyproject.toml: [project].dependencies 解析出 0 条")
    return deps


def manifest_requirements() -> dict[str, str]:
    """{归一化包名: 完整 PEP 508 依赖串}，直接取 manifest 原文。"""
    text = BUILD_MANIFEST.read_text(encoding="utf-8")
    deps = _toml.loads(text)["project"]["dependencies"] if _toml else _project_dependencies_minimal(text)
    out: dict[str, str] = {}
    for raw in deps:
        req = raw.split(";", 1)[0].strip()
        m = _NAME_RE.match(req)
        if not m:
            sys.exit(f"[verify-deps] manifest 里这条依赖解析不了: {raw!r}")
        out[_normalize(m.group("name"))] = req
    return out


def import_surface() -> dict[str, set[str]]:
    """用 ast 抠出打包目录里所有对 strands / bedrock_agentcore 的 import。

    返回 {模块路径: {符号名, ...}}；`import strands.x` 这种没有具体符号的记为空集合
    （只验模块本身能 import）。
    """
    surface: dict[str, set[str]] = {}

    def watched(mod: str | None) -> bool:
        return bool(mod) and mod.split(".", 1)[0] in WATCHED_ROOTS

    for path in sorted(APP_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:  # 语法错误是 py-compile 那条 job 的活，这里只报不吞
            sys.exit(f"[verify-deps] {path} 解析失败: {exc}")
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                # `from . import x` 的 node.module 是 None / level>0 —— 不是我们要的
                if node.level or not watched(node.module):
                    continue
                surface.setdefault(node.module, set()).update(a.name for a in node.names)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if watched(alias.name):
                        surface.setdefault(alias.name, set())
    return surface


# venv 里执行的验证程序。stdout 只输出一行 JSON，便于外层解析。
PROBE = r"""
import importlib, json, sys
from importlib import metadata

surface = json.loads(sys.argv[1])
failures = []
for module in sorted(surface):
    try:
        mod = importlib.import_module(module)
    except Exception as exc:
        failures.append({"module": module, "symbol": None,
                         "error": type(exc).__name__ + ": " + str(exc)})
        continue
    for symbol in sorted(surface[module]):
        if hasattr(mod, symbol):
            continue
        # `from pkg.sub import name` 里 name 也可能是子模块
        try:
            importlib.import_module(module + "." + symbol)
        except Exception as exc:
            failures.append({"module": module, "symbol": symbol,
                             "error": type(exc).__name__ + ": " + str(exc)})

versions = {}
for dist in ("strands-agents", "bedrock-agentcore", "mcp", "openai", "botocore"):
    try:
        versions[dist] = metadata.version(dist)
    except metadata.PackageNotFoundError:
        pass
print(json.dumps({"failures": failures, "versions": versions}))
"""


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, **kw)


def _clean_env() -> dict[str, str]:
    """子进程环境：去掉外层（deploy_agent.sh）设的 UV_CONSTRAINT / UV_OFFLINE。

    用哪份版本表、要不要离线，由本脚本自己显式决定 —— 否则 `--latest` 金丝雀会被外层的
    UV_CONSTRAINT 悄悄钉回旧版本，「装上游最新版」就成了一句空话。
    """
    return {k: v for k, v in os.environ.items() if k not in ("UV_CONSTRAINT", "UV_OFFLINE")}


def _uv_install(uv: str, venv: Path, python: str, install: list[str],
                constraints: Path | None, offline: bool) -> int:
    """用 uv 建 venv 并装依赖；offline=True 时只用本机缓存、不输出（失败了由调用方联网重来）。"""
    env = _clean_env()
    if offline:
        env["UV_OFFLINE"] = "1"
    quiet = {"capture_output": True} if offline else {}
    if run([uv, "venv", str(venv), "--python", python], env=env, **quiet).returncode:
        return 2
    cmd = [uv, "pip", "install", "--python", str(venv / "bin" / "python"), "--quiet", *install]
    if constraints:
        cmd += ["--constraint", str(constraints)]
    return run(cmd, env=env, **quiet).returncode


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--latest", action="store_true",
                    help="金丝雀模式：忽略 manifest 上界和版本表，装上游最新版")
    ap.add_argument("--full", action="store_true",
                    help="装 manifest 的全部依赖（最忠实，但慢）")
    ap.add_argument("--constraints", default=str(CONSTRAINTS),
                    help="版本表（默认 agent-constraints.txt = 部署时真正装到的版本）")
    ap.add_argument("--no-constraints", action="store_true",
                    help="不用版本表，只按 manifest 的范围装（当天能解析到的最新版）")
    # 默认钉 3.13 而不是「当前解释器」：托管运行时是 PYTHON_3_13（见 AgentRuntimeArtifact
    # 的 Runtime 字段），要验的就是它。跟着当前解释器走会在本机（.venv 是 3.14）验出一个
    # 客户永远遇不到的组合 —— botocore[crt] 之类连 wheel 都可能还没有，那是假红。
    ap.add_argument("--python", default="3.13",
                    help="venv 的 Python 版本（默认 3.13 = 托管运行时的版本）")
    args = ap.parse_args(argv)

    # 版本表：金丝雀和 --no-constraints 不用；默认必须存在 —— 缺了它，「验证通过」验的就不是
    # 部署时真正装到的那一组了，不许静默退回「按范围装」。
    constraints: Path | None = None
    if not (args.latest or args.no_constraints):
        constraints = Path(args.constraints)
        if not constraints.is_file():
            print(f"[verify-deps] ✗ 找不到版本表 {constraints} —— 部署按它装，验证也必须按它；"
                  f"确实只想按范围验证就加 --no-constraints")
            return 2

    reqs = manifest_requirements()
    surface = import_surface()
    if not surface:
        print("[verify-deps] ✗ 一个 strands / bedrock_agentcore import 都没抠到 —— "
              "打包目录变了？这本身就是个问题，不许当成 0 个失败。")
        return 2

    n_sym = sum(len(v) for v in surface.values())
    print(f"[verify-deps] 打包目录里 {len(surface)} 个模块 / {n_sym} 个符号需要验证")

    if args.full:
        install = list(reqs.values())
    else:
        install = []
        for name in CORE_INSTALL:
            m = _NAME_RE.match(name)
            key = _normalize(m.group("name"))
            if key not in reqs:
                sys.exit(f"[verify-deps] {name} 不在 manifest 里了 —— 先更新 CORE_INSTALL")
            install.append(reqs[key])

    if args.latest:
        # 只保留包名（含 extras），丢掉版本约束 —— 让 pip/uv 去拿上游最新。
        install = [_NAME_RE.match(r).group("name") + (_NAME_RE.match(r).group("extras") or "")
                   for r in install]
        print("[verify-deps] 金丝雀模式：忽略约束，装上游最新版")

    print(f"[verify-deps] 安装：{' '.join(install)}")
    if constraints:
        print(f"[verify-deps] 版本按 {constraints.name} 钉死（= 部署时真正打进包的版本）")

    uv = shutil.which("uv")
    # mktemp 走 TMPDIR。⚠️ 别硬写 /tmp：本机 /tmp 下有个 gettext.py 会遮蔽标准库，
    # `python -m venv` 在那里直接失败。
    with tempfile.TemporaryDirectory(prefix="notiops-verify-deps-") as tmp:
        venv = Path(tmp) / "venv"
        if uv:
            # 先离线：本机缓存里都有就几秒完事；缓存不全（新机器、刚升级版本表）再联网重来。
            # 联网那次用一个新的 venv 目录，不在离线失败留下的半成品上继续。
            rc = _uv_install(uv, venv, args.python, install, constraints, offline=True)
            if rc:
                print("[verify-deps] 本机缓存不全，联网安装…")
                venv = Path(tmp) / "venv-online"
                rc = _uv_install(uv, venv, args.python, install, constraints, offline=False)
            if rc == 2:
                return 2
            py = venv / "bin" / "python"
        else:
            # `python -m venv` 挑不了版本 —— 它只会用当前解释器。对不上就必须说出来，
            # 否则「验的是 3.14、客户跑的是 3.13」这件事会静默混过去。
            here = f"{sys.version_info.major}.{sys.version_info.minor}"
            if here != args.python:
                print(f"[verify-deps] ⚠ 没有 uv，退回 python -m venv：实际用的是 "
                      f"Python {here}，不是要求的 {args.python}（托管运行时的版本）—— "
                      f"结果不完全等价。装个 uv 就对齐了。")
            if run([sys.executable, "-m", "venv", str(venv)]).returncode:
                return 2
            py = venv / "bin" / "python"
            pip_cmd = [str(py), "-m", "pip", "install", "--quiet", *install]
            if constraints:
                pip_cmd += ["-c", str(constraints)]
            rc = run(pip_cmd, env=_clean_env()).returncode
        if rc:
            print("[verify-deps] ✗ 依赖装不上 —— 约束本身解析不出来，或者网络问题")
            return 1

        payload = {m: sorted(s) for m, s in surface.items()}
        probe = run([str(py), "-c", PROBE, json.dumps(payload)],
                    capture_output=True, env={**os.environ, "PYTHONWARNINGS": "ignore"})
        if probe.returncode or not probe.stdout.strip():
            print("[verify-deps] ✗ 探针本身跑挂了：")
            print(probe.stderr[-4000:] or probe.stdout[-4000:])
            return 1
        result = json.loads(probe.stdout.strip().splitlines()[-1])

    versions = result["versions"]
    print("[verify-deps] 实际装到：" + " · ".join(f"{k} {v}" for k, v in sorted(versions.items())))

    failures = result["failures"]
    if not failures:
        print(f"[verify-deps] ✓ {n_sym} 个符号全部 import 成功")
        return 0

    print(f"[verify-deps] ✗ {len(failures)} 处 import 失败：")
    for f in failures:
        where = f["module"] + (f".{f['symbol']}" if f["symbol"] else "")
        print(f"    · {where}\n        {f['error']}")
    if args.latest:
        print("[verify-deps] 金丝雀红了 = 上游最新版与我们的代码不兼容。"
              "**不要**抬 manifest 上界；把坏版本记进 "
              "tests/test_agent_dep_bounds.py 的 KNOWN_BAD_VERSIONS。")
    elif constraints:
        print(f"[verify-deps] {constraints.name} 里钉的这组版本 import 不起来 —— 这是部署时真正会装的东西。"
              "先在 manifest 里排除坏版本，再跑 bash scripts/refresh_agent_constraints.sh 重新钉版本。")
    else:
        print("[verify-deps] manifest 约束下就装出了坏组合 —— 这是客户会装到的东西，"
              "先收紧约束再谈别的。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
