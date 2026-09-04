#!/usr/bin/env python3
"""打 IM 加装项的两个发布产物：`im-code.zip` + `im-layer.zip`（一键部署 / 方式A）。

方式B（`setup.sh` / `cdk deploy ImStack`）里这两份东西是 CDK 资产（`Code.fromAsset`），
CDK 自己会打包上传；一键部署的客户账号没有资产桶，所以必须预先打好挂在 GitHub
Release 上，由 StagerFn 搬进客户账号的 StagingBucket（见
`infra/lib/notiops-webchat-standalone-stack.ts` 的 `imCodeKey` / `imLayerKey`）。

── 为什么代码与依赖层分开两个 zip ────────────────────────────────────────────
改动频率差两个数量级：业务代码每次发版都变，层只在 lark-oapi / slack-sdk / boto3
升版时变（~25 MiB，每次发布重传是白花的流量）。而且 Lambda 的「代码 + 层」解压后
合计 250 MB 上限只有分开算才看得清 —— 本脚本最后那条判据就是在发布前把它量出来。

── 排除清单为什么不写在这里 ──────────────────────────────────────────────────
`infra/im-code-exclude.txt` 是**两条路径共用**的单一来源（方式B 由
`infra/lib/im-stack.ts` 读同一个文件）。清单漏一条/多一条的症状只在方式A 暴露，
而且不是构建报错，是客户账号里 `Runtime.ImportModuleError` 或者部署到一半的
`Unzipped size must be smaller than 262144000 bytes`。两份清单一定会漂，所以只留一处。

用法：
  scripts/build_im_zips.py --out-dir dist/oneclick
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import sys
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXCLUDE_FILE = PROJECT_ROOT / "infra" / "im-code-exclude.txt"
LAYER_DIR = PROJECT_ROOT / "lambda_layer_im"

#: 与 infra/lib/im-stack.ts 的 `sentinels` 同一批：清单没读到（空文件 / 路径写错）时
#: `exclude=[]` 会**成功**打出一个把 .venv 和 dist/ 塞进去的包，几百 MB，
#: 而且要到客户开栈时才报 250MB 上限。这里让它当场失败。
SENTINEL_PATTERNS = ("dist/**", ".cdk-out", "**/node_modules/**")
MIN_PATTERNS = 20

#: 三个 handler（im-core.ts 里的 `handler:` 逐字对应）+ 它们必然要 import 的模块。
#: 少任何一个 = 客户账号里 ImportModuleError，而方式B 完全正常。
REQUIRED_IN_CODE = (
    "platforms/feishu/lambda_ingress.py",
    "platforms/feishu/lambda_worker.py",
    "platforms/slack/lambda_ingress.py",
    "platforms/slack/lambda_worker.py",
    "platforms/common/lambda_progress.py",
    "platforms/common/router.py",
    # 两个 ingress 的**第一行**就 import 它（EventBridge 保活探测的判定）。
    # 缺了它的形态最坑：方式A 的 ingress 一律 ImportModuleError → 公网入口整条挂，
    # 而方式B 完全正常。
    "platforms/common/warmup.py",
    "core/devops_agent.py",
    "core/nl_router.py",
    "core/ddb_state.py",
)

#: 层里必须真的装到了的包。**判具体包，不判 `python/` 目录在不在** ——
#: build_im_layer.sh 先 mkdir 再 pip install，中途失败（断网装不到 lark-oapi）
#: 会留下一个空的 `python/`，只判目录会被骗过去，然后 Lambda 上 import 崩。
REQUIRED_IN_LAYER = ("lark_oapi", "slack_sdk", "botocore", "boto3")

#: Lambda 硬上限：函数代码 + 所有层，**解压后**合计 262_144_000 字节。
#: 留 15% 余量报警，因为超了是部署到一半 CREATE_FAILED 整栈回滚（实测踩过）。
UNZIPPED_LIMIT = 262_144_000
WARN_RATIO = 0.85


def load_patterns() -> list[str]:
    if not EXCLUDE_FILE.is_file():
        sys.exit(f"exclude list not found: {EXCLUDE_FILE}")
    patterns = [
        line.strip()
        for line in EXCLUDE_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    missing = [s for s in SENTINEL_PATTERNS if s not in patterns]
    if len(patterns) < MIN_PATTERNS or missing:
        sys.exit(
            f"{EXCLUDE_FILE} 只读出 {len(patterns)} 条模式"
            + (f"，且缺哨兵 {missing}" if missing else "")
            + f"（至少要 {MIN_PATTERNS} 条）。清单不完整会把 .venv/dist 一起打进 Lambda 包。"
        )
    return patterns


def _match_segs(path_segs: list[str], pat_segs: list[str]) -> bool:
    """按路径段匹配，`**` 吃 0 个或多个段（`*` / `?` 只在段内生效）。"""
    if not pat_segs:
        return not path_segs
    head, rest = pat_segs[0], pat_segs[1:]
    if head == "**":
        if _match_segs(path_segs, rest):
            return True
        return bool(path_segs) and _match_segs(path_segs[1:], pat_segs)
    if not path_segs:
        return False
    return fnmatch.fnmatchcase(path_segs[0], head) and _match_segs(path_segs[1:], rest)


def excluded(rel_posix: str, patterns: list[str]) -> bool:
    """rel_posix 是否被清单排除。

    语义刻意对齐 CDK 的 GLOB ignore（aws-cdk-lib core/lib/fs/ignore.js，
    `minimatch(rel, pattern, {matchBase:true})`）：**不含 `/` 的模式按 basename 匹配**
    （所以 `.cdk-out` 能剪掉任意深度的同名目录、`*.md` 能剪掉任意位置的 md）。
    唯一有意的偏差：这里的 `**` 也匹配以 `.` 开头的段（minimatch 没 `dot:true`，
    不匹配）。偏差方向是"多排除一点"，且清单里所有点开头的目录都另有裸名/前缀模式兜着。
    """
    segs = rel_posix.split("/")
    for pattern in patterns:
        if "/" not in pattern:
            if fnmatch.fnmatchcase(segs[-1], pattern):
                return True
        elif _match_segs(segs, pattern.split("/")):
            return True
    return False


def collect_code(patterns: list[str]) -> list[tuple[Path, str]]:
    """走仓库根，返回 (绝对路径, zip 内路径)。命中的目录整棵剪掉（不递归进去）。"""
    files: list[tuple[Path, str]] = []
    for dirpath, dirnames, filenames in os.walk(PROJECT_ROOT):
        rel_dir = Path(dirpath).relative_to(PROJECT_ROOT).as_posix()
        # 就地改 dirnames = 剪枝。不剪只靠逐文件过滤的话，光走一遍 .venv 和
        # frontend/node_modules 就要几十秒，而且会跟着符号链接乱跑。
        dirnames[:] = sorted(
            d for d in dirnames
            if not excluded(f"{d}" if rel_dir == "." else f"{rel_dir}/{d}", patterns)
        )
        for name in sorted(filenames):
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            if excluded(rel, patterns):
                continue
            path = Path(dirpath) / name
            if path.is_file():
                files.append((path, rel))
    return files


def collect_layer() -> list[tuple[Path, str]]:
    present = sorted(p.name for p in (LAYER_DIR / "python").iterdir()) if (LAYER_DIR / "python").is_dir() else []
    missing = [p for p in REQUIRED_IN_LAYER if p not in present]
    if missing:
        sys.exit(
            f"IM 依赖层不完整：{LAYER_DIR}/python 缺 {', '.join(missing)}。\n"
            "先构建再打包：bash scripts/build_im_layer.sh\n"
            "（该脚本需要能访问 PyPI；层里是 lark-oapi + slack-sdk + boto3/botocore 的 "
            "manylinux2014_x86_64 wheel，不能用 Mac 上装的那份。）"
        )
    # ⚠️ `__pycache__` / `.pyc` **必须一起打进去**（2026-09-03 之前这里是排除它们的，
    # 那是方式A 冷启动 >10s 的直接原因）。层在 Lambda 上是只读挂载，CPython 写不出
    # 字节码缓存，所以**每一次**冷启动都要把这 10967 个 .py 重新编译一遍 —— 实测
    # 9.5~12.7s，撞上 INIT 的 10 秒硬上限。带上预编译的 .pyc 后是 2.9~5.4s。
    # 完整原因（含为什么用 unchecked-hash、为什么不精简 lark_oapi）见
    # `scripts/build_im_layer.sh` 里「预编译字节码」那段长注释。
    #
    # 方式A 与方式B 必须同口径：方式B 走 `im-stack.ts` 的 `Code.fromAsset(lambda_layer_im)`
    # （不排除任何东西，天然带上），方式A 走这里。少一边就等于一键部署的客户拿到一个
    # 每次冷启动都超时的 bot，而自己部署的人没事 —— 正是「两条路径必须对等」要防的。
    pyc = 0
    files: list[tuple[Path, str]] = []
    for dirpath, dirnames, filenames in os.walk(LAYER_DIR):
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            if name == ".DS_Store":
                continue
            path = Path(dirpath) / name
            if path.is_file():
                pyc += name.endswith(".pyc")
                files.append((path, path.relative_to(LAYER_DIR).as_posix()))
    # 预编译是构建期的事（build_im_layer.sh 会断言 .pyc 数 == .py 数）。这里只兜底
    # "拿到了一份没预编译的层"这一种情况 —— 比如有人手工 pip install 出来的目录。
    n_py = sum(1 for p, _ in files if p.name.endswith(".py"))
    if pyc < n_py:
        sys.exit(
            f"IM 依赖层没有预编译：{n_py} 个 .py 只有 {pyc} 个 .pyc。\n"
            "打出来的 im-layer.zip 会让每次冷启动重新编译整个层（Init > 10s → "
            "INIT timeout，webhook 必然失败）。\n"
            "重新构建：bash scripts/build_im_layer.sh"
        )
    return files


def write_zip(out: Path, files: list[tuple[Path, str]]) -> int:
    """写 zip，返回解压后总字节数。

    固定 mtime + 排序写入 → 同一份源码每次打出字节相同的 zip，于是 sha256 稳定，
    「换了 tag 但代码没变」不会平白无故触发客户侧的 Lambda / 层更新。
    权限位保留（层里的 .so 和 bin/ 脚本），只把时间戳抹平。
    """
    if out.exists():
        out.unlink()
    total = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, rel in sorted(files, key=lambda t: t[1]):
            data = path.read_bytes()
            total += len(data)
            info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (path.stat().st_mode & 0o777) << 16
            zf.writestr(info, data)
    return total


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", required=True, help="产物目录（im-code.zip / im-layer.zip 写这里）")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    if not out_dir.is_absolute():
        out_dir = PROJECT_ROOT / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    patterns = load_patterns()
    code_files = collect_code(patterns)
    code_names = {rel for _p, rel in code_files}

    missing = [m for m in REQUIRED_IN_CODE if m not in code_names]
    if missing:
        sys.exit(
            f"im-code.zip 会缺这些模块：{missing}\n"
            f"要么 {EXCLUDE_FILE.name} 排除得太狠，要么文件被挪走了 —— 两种都会让客户账号里的 "
            "IM Lambda 直接 ImportModuleError（而方式B 完全正常）。"
        )
    # 反向判据：清单失效时最先混进来的就是这几棵大树。
    for junk in ("node_modules/", "dist/", "infra/", "frontend/", ".venv"):
        offenders = [n for n in code_names if n.startswith(junk) or f"/{junk}" in n]
        if offenders:
            sys.exit(f"im-code.zip 里混进了 {junk}（{len(offenders)} 个文件，例如 {offenders[0]}）")

    code_zip = out_dir / "im-code.zip"
    code_unzipped = write_zip(code_zip, code_files)
    print(f"  im-code.zip   {code_zip.stat().st_size / 1024 / 1024:6.2f} MiB packed, "
          f"{code_unzipped / 1024 / 1024:6.2f} MiB unzipped, {len(code_files)} files")

    layer_files = collect_layer()
    layer_zip = out_dir / "im-layer.zip"
    layer_unzipped = write_zip(layer_zip, layer_files)
    print(f"  im-layer.zip  {layer_zip.stat().st_size / 1024 / 1024:6.2f} MiB packed, "
          f"{layer_unzipped / 1024 / 1024:6.2f} MiB unzipped, {len(layer_files)} files")

    total = code_unzipped + layer_unzipped
    print(f"  code + layer unzipped: {total / 1024 / 1024:.2f} MiB "
          f"/ {UNZIPPED_LIMIT / 1024 / 1024:.0f} MiB Lambda limit "
          f"({total / UNZIPPED_LIMIT * 100:.1f}%)")
    if total >= UNZIPPED_LIMIT:
        sys.exit("超过 Lambda「代码 + 层」解压后 250 MB 上限 —— 部署到一半会 CREATE_FAILED 整栈回滚")
    if total >= UNZIPPED_LIMIT * WARN_RATIO:
        print(f"  WARNING: 已用掉 {total / UNZIPPED_LIMIT * 100:.1f}% 的解压额度，"
              f"下一次加依赖前先看 {EXCLUDE_FILE.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
