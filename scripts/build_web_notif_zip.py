#!/usr/bin/env python3
"""把「通知」生产端那个 Lambda 打成 `web-notif.zip`（一键部署的第 4 个发布产物）。

方式 B（`setup.sh` / `cdk deploy`）里这个函数复用 IM push 的 CDK asset，CDK 自己会
把整棵源码树打进去；一键部署（方式 A）的客户账号没有资产桶，所以必须预先打好一个
zip 挂在 GitHub Release 上，由 StagerFn 搬进客户账号（见
`infra/lib/notiops-webchat-standalone-stack.ts` 的 WebNotifFn）。

**为什么算 import 闭包而不是写死一个文件清单**：
handler 现在只 `from core import push_event`，写死 5 个路径当然也能跑。但哪天有人往
`push_event.py` 里加一句 `from core import something_else`，写死的清单不会报错 ——
方式 B 照旧（CDK 打整棵树），方式 A 的 Lambda 在客户账号里 ImportError，而症状是
「通知页面一直空着」，没人会联想到打包脚本。所以这里从入口出发做 BFS，
把第一方模块的实际依赖全带上，并在发现非 stdlib / 非 boto3 的第三方 import 时**直接失败**
（Lambda 运行时只预装 boto3；要引第三方就得先决定怎么带依赖，不能悄悄发出去）。

用法：
  scripts/build_web_notif_zip.py --out dist/oneclick/web-notif.zip
"""
from __future__ import annotations

import argparse
import ast
import sys
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

#: 入口模块。必须与 `infra/lib/constructs/web-notif-sources.ts` 的
#: `WEB_NOTIF_HANDLER`（`shared.report_delivery.web_push_handler.lambda_handler`）对得上。
ENTRY_MODULE = "shared.report_delivery.web_push_handler"

#: Lambda python3.13 运行时预装、因此不需要打进 zip 的第三方包。
#: 只有 boto3 一家 —— 别往这里加东西来"绕过"下面那个断言。
PREINSTALLED = {"boto3", "botocore"}


def _stdlib_names() -> set[str]:
    """标准库顶层模块名。`sys.stdlib_module_names` 是 3.10+ 的权威来源。"""
    names = set(sys.stdlib_module_names)
    # 内置扩展模块（_socket 之类）不在上面那个集合里也算标准库。
    names |= set(sys.builtin_module_names)
    return names


STDLIB = _stdlib_names()


def _module_path(module: str) -> Path | None:
    """模块名 → 仓库里的文件路径。只找第一方（仓库内）模块。"""
    rel = Path(*module.split("."))
    for candidate in (PROJECT_ROOT / rel.with_suffix(".py"), PROJECT_ROOT / rel / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


def _imports(path: Path) -> set[str]:
    """一个文件里所有 import 的**顶层模块名**（含相对 import 的绝对化）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    # 本文件所属的包，用来把 `from . import x` 还原成绝对名。
    pkg_parts = path.relative_to(PROJECT_ROOT).parts[:-1]
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # 相对 import
                base = list(pkg_parts[: len(pkg_parts) - (node.level - 1)] if node.level > 1 else pkg_parts)
                prefix = ".".join(base + ([node.module] if node.module else []))
                for alias in node.names:
                    found.add(f"{prefix}.{alias.name}")
            elif node.module:
                # `from core import push_event`：被 import 的名字**可能**是子模块，
                # 也可能只是个函数。两种都当候选去磁盘上找，找不到就当函数忽略。
                found.add(node.module)
                for alias in node.names:
                    found.add(f"{node.module}.{alias.name}")
    return found


def collect() -> list[Path]:
    """从入口做 BFS，返回要打进 zip 的所有仓库内 .py（含包的 __init__.py）。"""
    entry = _module_path(ENTRY_MODULE)
    if entry is None:
        sys.exit(f"entry module not found in the repo: {ENTRY_MODULE}")

    seen: dict[str, Path] = {ENTRY_MODULE: entry}
    queue = [ENTRY_MODULE]
    third_party: set[str] = set()

    while queue:
        module = queue.pop()
        for name in _imports(seen[module]):
            top = name.split(".")[0]
            if top in STDLIB:
                continue
            path = _module_path(name)
            if path is None:
                # 不是仓库内模块。可能是第三方包，也可能只是 `from x import some_func`
                # 里那个函数名（此时 `x` 自己已经作为候选进过队列）。
                if _module_path(top) is None and top not in PREINSTALLED:
                    third_party.add(top)
                continue
            if name not in seen:
                seen[name] = path
                queue.append(name)

    if third_party:
        sys.exit(
            "refusing to build: the handler now imports third-party package(s) that the "
            f"Lambda runtime does not preinstall: {sorted(third_party)}.\n"
            "The one-click zip carries no dependencies. Either drop the import or decide "
            "how to vendor it (and update this script deliberately)."
        )

    files = set(seen.values())
    # 补齐每一层包的 __init__.py：zip 里少一个 __init__.py = 运行时 ModuleNotFoundError。
    for path in list(files):
        rel = path.relative_to(PROJECT_ROOT)
        for i in range(1, len(rel.parts)):
            init = PROJECT_ROOT / Path(*rel.parts[:i]) / "__init__.py"
            if init.is_file():
                files.add(init)
    return sorted(files)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="output zip path")
    args = ap.parse_args()

    out = Path(args.out)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    files = collect()
    # 固定 mtime + 排序写入 → 同一份源码每次打出字节相同的 zip，于是 sha256 稳定，
    # 「换了 tag 但代码没变」不会平白无故触发客户侧的 Lambda 更新。
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            rel = path.relative_to(PROJECT_ROOT).as_posix()
            info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())

    print(f"  {out.relative_to(PROJECT_ROOT) if out.is_relative_to(PROJECT_ROOT) else out}"
          f"  ({out.stat().st_size / 1024:.1f} KiB, {len(files)} files)")
    for path in files:
        print(f"    {path.relative_to(PROJECT_ROOT).as_posix()}")


if __name__ == "__main__":
    main()
