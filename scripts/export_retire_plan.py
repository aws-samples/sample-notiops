#!/usr/bin/env python3
"""算出「这次部署要不要先部消费者栈」—— 升级路径上的 CFN Export 退役预检。

背景（这个脚本存在的唯一理由）：CDK 的跨栈引用会在**生产者**栈上自动生成一条
CFN Export，消费者栈里是一个 `Fn::ImportValue`。退役某个跨栈引用时，生产者与
消费者在同一个 MR 里一起改；而 `cdk deploy --all` 按 `addStackDependency`
（`infra/bin/app.ts`）**先更主栈** —— 那一刻客户机器上已装的**老**消费者栈还
持有 `Fn::ImportValue`，CloudFormation 硬拒：

    Export <name> cannot be deleted as it is in use by WebChatStack

后果：主栈 `UPDATE_ROLLBACK_COMPLETE`、后面的栈全 SKIPPED、`setup.sh` 的
`set -e` 就地中止，而且**平淡重跑永远撞同一堵墙**（CDK CLI 把
`UPDATE_ROLLBACK_COMPLETE` 归为 `isRollbackSuccess`，不会 delete-and-recreate）。
解法是「消费者优先」：先单独 `cdk deploy <消费者栈> --exclusively` 让它把引用放开，
再跑 `--all`。这个脚本只负责判断**要不要**这么做、以及对**哪些栈**这么做。

零 AWS 调用：stdin 收 `describe-stacks` 的原始 JSON，`--outdir` 读刚 synth 出来
的 cloud assembly。所以它可以被单测（`tests/test_export_retire_plan.py`）逐分支
覆盖，也不会给部署加一次 synth。

输出**恰好一行**，四种：
  SKIP <原因>            —— 无事可做（首装 / 本次不删除任何已部署的 export）
  WAIT <StackStatus>     —— 主栈正在变更中，调用方应停手、等 CFN 收敛后重跑
  REORDER <栈> [<栈>…]   —— 这些栈必须先单独 deploy，以放开对退役 export 的引用
  FALLTHROUGH <原因>     —— 有 export 要退役，但消费者同时需要主栈**尚未产生**的
                            export —— 消费者优先在这种版本上无解（先部消费者会
                            `No export named … found`），按常规顺序部并大声告警

任何内部错误 → **非零退出**（fail closed）。绝不静默返回 SKIP：判据自己坏了而
装作「无事可做」，等于把上面那个不可自愈的死锁又放回去。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

#: 真正**瞬时**、不该并发下手的栈状态。
#: ⚠️ **故意不含 `REVIEW_IN_PROGRESS`** —— 那不是瞬时态，是「建了变更集但没执行」
#: 的**持久**态（可以停在那里几个月）。把它当瞬时会造出一个自己永远解不开的硬停：
#: 脚本让你「等 CFN 收敛后重跑」，而它根本不会自己收敛。
TRANSIENT_STATUSES = (
    "CREATE_IN_PROGRESS",
    "UPDATE_IN_PROGRESS",
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "ROLLBACK_IN_PROGRESS",
    "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
    "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    "DELETE_IN_PROGRESS",
    "IMPORT_IN_PROGRESS",
    "IMPORT_ROLLBACK_IN_PROGRESS",
)

#: 生产者栈。方式 B 的三栈布局里只有它对外 export（`infra/bin/app.ts`）。
MAIN_STACK = "NotiOpsBackendStack"

_TPL_SUFFIX = ".template.json"


def _walk_imports(node: object, out: set[str]) -> None:
    """收集模板里每一个 ``{"Fn::ImportValue": "<字面名>"}``。

    只认**单键 dict + 字符串值**这一种形状：CDK 生成的跨栈引用就是它。
    `Fn::ImportValue` 里套 `Fn::Sub` 之类是人手写的动态导入，本仓库没有，
    真出现了也不该被这个脚本猜 —— 猜错比看不见更糟。
    """
    if isinstance(node, dict):
        if len(node) == 1 and "Fn::ImportValue" in node:
            value = node["Fn::ImportValue"]
            if isinstance(value, str):
                out.add(value)
            return
        for value in node.values():
            _walk_imports(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk_imports(value, out)


def _exports_of(template: dict) -> set[str]:
    """模板里所有带 ``Export.Name`` 的 Output 名。

    ⚠️ **没有 `Export.Name` 的 Output 不算**：它不进 CFN 的全局 export 表，
    删掉它不可能造成任何依赖失败。
    """
    names: set[str] = set()
    for output in (template.get("Outputs") or {}).values():
        if not isinstance(output, dict):
            continue
        export = output.get("Export")
        if isinstance(export, dict) and isinstance(export.get("Name"), str):
            names.add(export["Name"])
    return names


def _load_template(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text("utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} 的顶层不是 object")
    return data


def plan(describe_stacks: dict, outdir: pathlib.Path) -> str:
    """判据本体。返回那**一行**输出。异常一律往外抛（调用方转非零退出）。"""
    main_template_path = outdir / f"{MAIN_STACK}{_TPL_SUFFIX}"
    if not main_template_path.is_file():
        raise FileNotFoundError(f"找不到 {main_template_path}")

    stacks = describe_stacks.get("Stacks") or []
    if not stacks:
        # 主栈还不存在 = 首装。没有"已部署的 export"，谈不上退役。
        return "SKIP 主栈尚未部署（首装）"

    status = stacks[0].get("StackStatus", "") or ""
    if status in TRANSIENT_STATUSES:
        return f"WAIT {status}"

    deployed_exports = {
        output["ExportName"]
        for output in (stacks[0].get("Outputs") or [])
        if isinstance(output, dict) and output.get("ExportName")
    }
    head_main_exports = _exports_of(_load_template(main_template_path))

    retired = deployed_exports - head_main_exports
    if not retired:
        return "SKIP 本次不删除任何已部署的 export"

    # 🔴 **别拿 HEAD 消费者模板的 imports 去交 `retired`** —— 那个交集恒为空，
    # 是一段看着精确、其实永远不成立的死代码：CDK 之所以在主栈上生成某条 export，
    # 就是因为**有消费者引用它**；HEAD 的主栈不再 export 它，正说明 HEAD 的消费者
    # 模板里已经没有那条 import 了。那条 import 只活在**已部署的**消费者栈里，而
    # cloud assembly 看不见已部署的东西。
    #
    # 精确知道「哪个已装栈还持有它」只能问 `aws cloudformation list-imports`（每条
    # 退役 export 一次调用，还得先跑一趟脚本才知道退役了哪些 → bash 要两趟）。
    # 换成保守做法：**只要有 export 要退役，就把所有带跨栈引用的消费者栈都放到主栈
    # 前面单独部一次**。代价只是每个消费者栈多一次基本 no-op 的 `--exclusively`
    # 部署（且只发生在真的退役 export 的那种升级上）；收益是不引入 AWS 调用、判据
    # 可单测、也不会因为猜错持有者而漏掉真正卡住的那个栈。
    consumers: list[str] = []
    missing: dict[str, list[str]] = {}
    for template_path in sorted(outdir.glob(f"*{_TPL_SUFFIX}")):
        stack = template_path.name[: -len(_TPL_SUFFIX)]
        if stack == MAIN_STACK:
            continue
        imports: set[str] = set()
        _walk_imports(_load_template(template_path), imports)
        if not imports:
            # 没有任何跨栈引用 → 提前部它对放开 export 毫无帮助，白花一次部署。
            continue
        # 🔴 子集守卫。消费者优先**只在**「新消费者要的 export 老主栈全都有」时
        # 合法。哪天主栈**新增**一条 export 而消费者要用（加法版本），先部消费者
        # 会 `No export named … found` → 消费者回滚 → `set -e` 在 `--all` 之前
        # 中止 → 主栈永远造不出那条 export：同一个「永久卡死」换个方向复活。
        # 「同一版里既退役又新增」本身就是发布工程隐患，真正拦它的是 CI 上的
        # `scripts/check_cfn_exports.py` + `infra/exports.golden.json`；预检这里
        # 只负责**不把事情弄得更糟**：照常规顺序部，并把话说清楚。
        gap = imports - deployed_exports
        if gap:
            missing[stack] = sorted(gap)
        consumers.append(stack)

    if missing:
        detail = "; ".join(f"{s}→{','.join(v)}" for s, v in sorted(missing.items()))
        return (f"FALLTHROUGH 消费者栈需要主栈尚未产生的 export：{detail}"
                f"｜将被退役：{','.join(sorted(retired))}")
    if not consumers:
        return f"SKIP 退役的 export 已无跨栈消费者：{','.join(sorted(retired))}"
    return "REORDER " + " ".join(consumers)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", required=True,
                        help="cdk synth 的输出目录（cloud assembly）")
    args = parser.parse_args(argv)

    try:
        describe_stacks = json.load(sys.stdin)
        if not isinstance(describe_stacks, dict):
            raise ValueError("stdin 的 describe-stacks JSON 顶层不是 object")
        line = plan(describe_stacks, pathlib.Path(args.outdir))
    except Exception as e:                                    # noqa: BLE001
        # fail closed —— 见模块 docstring。调用方看到非零就该停在 `--all` 之前。
        print(f"ERROR {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
