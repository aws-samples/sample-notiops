#!/usr/bin/env python3
"""把「跨栈 CFN Export 集合」钉成 golden —— 动了它就必须先想清楚升级路径。

为什么要一道专门的闸门：CDK 的跨栈引用（`main.userPoolId` 这种传参）会在生产者
栈上**自动**生成 CFN Export，名字里带 CDK 算出来的逻辑 id 哈希，比如
`NotiOpsBackendStack:ExportsOutputFnGetAttReportsCDN7ADC2FBEDomainNameE62F8798`。
写代码的人根本看不到这些名字，于是三类改动会**静默**改掉 export 集合：

  ① 删掉一个跨栈传参（比如 2026-09-04 退掉 `idleConsoleUrl` / FrontendCDN）
  ② **改个构造 id**（`ReportsCDN` → `ReportCdn`）—— 哈希变了 = 旧 export 被删、
     新 export 被建，对 CloudFormation 来说和 ① 完全一样
  ③ 加一个 `-c` 让跨栈引用退化成字面值（`-c reportsCdnDomain=<域名>`）

而**删除**一条已部署的 export 在升级路径上是个不可自愈的坑：主栈先更 → CFN 拒绝
删除仍被 `Fn::ImportValue` 持有的 export → 主栈 `UPDATE_ROLLBACK_COMPLETE` →
重跑照样撞墙（详见 `scripts/export_retire_plan.py` 与 `setup.sh` 的预检）。预检能
救「只退役」的版本，救不了「同一版又退役又新增」的版本 —— 那种只能拆两步发布。
所以要在**代码进 main 之前**让人看见自己动了 export 集合。

这个脚本不联网、不碰 AWS：读一个已 synth 的 cloud assembly，和
`infra/exports.golden.json` 对比。CI 上跑（`cfn-export-gate`），本地可以
`--update` 重新生成 golden。

顺带钉住一条结构不变式：**主栈的 export 集合必须恰好等于各消费者栈 import 的
并集**。多出来的 export 是纯负担（以后删它又是一次上面那个坑）；少了就是
`No export named … found`，部署直接失败。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from export_retire_plan import (          # noqa: E402  复用同一套模板解析
    MAIN_STACK,
    _exports_of,
    _load_template,
    _walk_imports,
)

_TPL_SUFFIX = ".template.json"
DEFAULT_GOLDEN = pathlib.Path(__file__).resolve().parents[1] / "infra" / "exports.golden.json"


def collect(outdir: pathlib.Path) -> dict[str, dict[str, list[str]]]:
    """从 cloud assembly 读出每个栈的 exports / imports。"""
    templates = sorted(outdir.glob(f"*{_TPL_SUFFIX}"))
    if not templates:
        raise FileNotFoundError(f"{outdir} 里没有任何 *{_TPL_SUFFIX}")
    out: dict[str, dict[str, list[str]]] = {}
    for path in templates:
        template = _load_template(path)
        imports: set[str] = set()
        _walk_imports(template, imports)
        out[path.name[: -len(_TPL_SUFFIX)]] = {
            "exports": sorted(_exports_of(template)),
            "imports": sorted(imports),
        }
    return out


def structural_problems(actual: dict[str, dict[str, list[str]]]) -> list[str]:
    """与 golden 无关的硬错误 —— 这些不该靠"更新 golden"糊过去。"""
    problems: list[str] = []
    if MAIN_STACK not in actual:
        return [f"assembly 里没有主栈 {MAIN_STACK}"]

    exported = set(actual[MAIN_STACK]["exports"])
    imported: set[str] = set()
    for stack, data in actual.items():
        if stack == MAIN_STACK:
            continue
        imported |= set(data["imports"])
        if data["exports"]:
            problems.append(
                f"{stack} 也在 export（{', '.join(data['exports'])}）—— 本仓库的"
                f"约定是只有 {MAIN_STACK} 对外 export，多一个生产者就多一处"
                f"退役时会卡住的地方")

    orphan = exported - imported
    if orphan:
        problems.append(
            "主栈 export 了没人 import 的名字：" + ", ".join(sorted(orphan))
            + " —— 纯负担，将来删它又是一次「Export cannot be deleted」")
    dangling = imported - exported
    if dangling:
        problems.append(
            "有 import 找不到对应的 export：" + ", ".join(sorted(dangling))
            + " —— 部署时会直接 `No export named … found`")
    return problems


def _diff(golden: dict, actual: dict) -> list[str]:
    lines: list[str] = []
    for stack in sorted(set(golden) | set(actual)):
        if stack not in golden:
            lines.append(f"  + 新栈 {stack}")
            continue
        if stack not in actual:
            lines.append(f"  - 栈没了 {stack}")
            continue
        for kind in ("exports", "imports"):
            was, now = set(golden[stack].get(kind, [])), set(actual[stack][kind])
            for name in sorted(was - now):
                lines.append(f"  - {stack} 不再 {kind[:-1]}：{name}")
            for name in sorted(now - was):
                lines.append(f"  + {stack} 新增 {kind[:-1]}：{name}")
    return lines


def _load_golden(path: pathlib.Path) -> dict[str, dict[str, list[str]]]:
    raw = json.loads(path.read_text("utf-8"))
    # `_` 开头的键是给人看的说明，不参与比较。
    return {k: v for k, v in raw.items() if not k.startswith("_")}


_GOLDEN_DOC = [
    "本文件由 scripts/check_cfn_exports.py --update 生成，不要手改。",
    "它钉住的是 CDK 为跨栈引用自动生成的 CFN Export/Import 集合。",
    "CI 上 diff 变红不代表你写错了 —— 但**删除**任何一条已发布的 export 都会让",
    "升级路径进入 `Export … cannot be deleted as it is in use by <栈>`，主栈整栈",
    "回滚且重跑不自愈。setup.sh 的预检（scripts/export_retire_plan.py）能救",
    "「只退役」的版本；「同一版又退役又新增」必须拆成两次发布。",
    "确认过升级路径后再跑 --update：golden diff 里只有新增 → 直接发；一旦出现",
    "删除，先单独部署消费者栈放开引用，再发主栈。",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", required=True,
                        help="cdk synth 的输出目录（cloud assembly）")
    parser.add_argument("--golden", type=pathlib.Path, default=DEFAULT_GOLDEN)
    parser.add_argument("--update", action="store_true",
                        help="用当前 assembly 重写 golden（本地用，确认过升级路径再用）")
    args = parser.parse_args(argv)

    actual = collect(pathlib.Path(args.outdir))

    problems = structural_problems(actual)
    if problems:
        print("❌ 跨栈引用结构有问题（这些不该靠更新 golden 糊过去）：")
        for problem in problems:
            print(f"  · {problem}")
        return 1

    if args.update:
        payload: dict = {"__doc__": _GOLDEN_DOC}
        payload.update({k: actual[k] for k in sorted(actual)})
        args.golden.write_text(json.dumps(payload, indent=2,
                                          ensure_ascii=False) + "\n",
                               encoding="utf-8")
        print(f"✅ 已更新 {args.golden}")
        return 0

    if not args.golden.is_file():
        print(f"❌ 找不到 golden：{args.golden}", file=sys.stderr)
        return 1

    golden = _load_golden(args.golden)
    if golden == actual:
        print(f"✅ 跨栈 export/import 集合与 golden 一致"
              f"（{len(actual)} 个栈，主栈 {len(actual[MAIN_STACK]['exports'])} 条 export）")
        return 0

    print("❌ 跨栈 CFN Export/Import 集合变了：")
    for line in _diff(golden, actual):
        print(line)
    print("")
    print("🔴 **删除**任何一条已发布的 export 会让升级路径卡死：主栈先更 → CFN 拒绝")
    print("   删除仍被 Fn::ImportValue 持有的 export → UPDATE_ROLLBACK_COMPLETE，")
    print("   而且重跑不自愈。改构造 id（哈希变了）与删跨栈传参等价。")
    print("")
    print("   确认升级路径后再更新 golden：")
    print("     cd infra && npx cdk synth --quiet --all -o /tmp/synth")
    print("     cd .. && python3 scripts/check_cfn_exports.py --outdir /tmp/synth --update")
    print("   并在发布记录里记一行：哪条 export 退役了、消费者栈是否已先放开引用。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
