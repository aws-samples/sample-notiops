#!/usr/bin/env python3
"""接线检查：domain 层算好的东西，调用方到底有没有取。

## 为什么需要它

2026-08-26 三个 subagent 审计巡检链路，36 条缺陷里**至少 6 条**是同一个形态：

```
is_rollup / RollupGroup   判定层算好了，调用侧只 len() 了一次
evaluable                 docstring 写「调用方 SHALL 用它」，全仓零读点
healthy                   to_observations 写「由调用方给出」，从来没给
skipped                   被 append 两次，然后再没有任何引用
magnitudes                生产调用点不传 → 全 0.0 → 方向恒 UP、护栏失效
metric_coverage           算了但载荷写的是另一个数
```

共同点是**静默**：没有任何现象能被功能测试观察到。3171 条单测全绿，
因为它们几乎全部直接调 domain 函数并**显式喂进**那个参数 —— 于是测的是
「domain 拿到正确输入时是对的」，而生产上那个输入根本不存在。

这类缺陷是**机械可检的**：符号在定义处出现，在调用方零出现。所以它该是
一个脚本而不是评审清单 —— 清单会腐烂，脚本会让构建红。

## 三条检查

```
① SHALL 孤儿      docstring 里说「调用方 SHALL 用它」的 property / 参数，
                  在 `inspection/` 与 `lambda_*/` 下（排除定义处自己）零读点
② 只写不读的字段   dataclass 字段被构造时赋值，但全仓没有任何 `.<field>` 读点
③ 出参黑洞        `xxx_out` / `skipped` 这类列表参数被 append，而调用方
                  拿到之后不消费
```

## 用法

```bash
python3 scripts/lint_seams.py                    # 只报新增
python3 scripts/lint_seams.py --update-baseline  # 把现有的钉成基线
python3 scripts/lint_seams.py --all              # 连基线一起列出来
```

⚠️ **一定有假阳性**（比如一个 property 只在测试里断言、或者刻意留的防御性
判据）。所以配 baseline 机制，和 `scripts/lint_i18n.py` 同一套：新增的报红，
既有的先钉住。豁免要写理由 —— 直接往 baseline 里塞一行等于开后门。
"""

from __future__ import annotations

import ast
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
BASELINE = REPO / "scripts" / ".seams_baseline.json"

# 被检查的「domain 层」与「调用方」
DOMAIN_DIRS = ("inspection",)
CALLER_DIRS = ("inspection", "lambda_inspection_executor", "lambda_inspection_scheduler",
               "api", "shared")

# docstring 里表达「调用方必须用它」的说法
_SHALL = re.compile(r"调用方\s*SHALL|caller\s+SHALL|SHALL\s+用它|由调用方")


def _py_files(dirs: tuple[str, ...], *, tests: bool = False) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for d in dirs:
        for f in (REPO / d).rglob("*.py"):
            if "__pycache__" in f.parts:
                continue
            if not tests and ("test" in f.name or "tests" in f.parts):
                continue
            out.append(f)
    return sorted(out)


def _read_points(symbol: str, *, exclude: pathlib.Path) -> int:
    r"""`x.symbol` 形式的**属性读取**次数（排除定义所在文件）。

    ⚠️ 只数属性访问，不数 `symbol=` 形式的关键字传参 —— 后者是「写」。
    一个只被写、从不被读的字段正是要找的东西。

    🔴 **走 AST 而不是正则。** 第一版用 `\.evaluable\b` 扫文本，结果被
    解释性注释骗过：

    ```
    # 🔴 `InstanceVerdict.evaluable` 的 docstring 写着「调用方 SHALL 用它」
    ```

    这一行会被数成 3 个「读点」，于是「零读点」永远不成立 —— 检查静默失效。
    而这个检查存在的全部意义就是发现零读点，假阴性等于它不存在。
    （同一类假阳性在 `tests/test_api_error_mapping.py` 上也踩过，那里也换成
    了 AST。）
    """
    n = 0
    for f in _py_files(CALLER_DIRS):
        if f == exclude:
            continue
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError:                        # pragma: no cover
            continue
        for node in ast.walk(tree):
            # `x.symbol` 出现在**读**的位置（Load），不是赋值目标
            if (isinstance(node, ast.Attribute) and node.attr == symbol
                    and isinstance(node.ctx, ast.Load)):
                n += 1
    return n


def check_shall_orphans() -> list[str]:
    """① docstring 说「调用方 SHALL 用它」，而调用方零读点。"""
    out: list[str] = []
    for f in _py_files(DOMAIN_DIRS):
        src = f.read_text(encoding="utf-8")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            doc = ast.get_docstring(node) or ""
            if not _SHALL.search(doc):
                continue
            # 只看 property（domain 层用它表达「算好的判据」）
            is_prop = any(
                isinstance(d, ast.Name) and d.id == "property"
                for d in node.decorator_list)
            if not is_prop:
                continue
            if _read_points(node.name, exclude=f) == 0:
                out.append(
                    f"{f.relative_to(REPO)}:{node.lineno}: "
                    f"`{node.name}` 的 docstring 写着「调用方 SHALL 用它」，"
                    f"而调用方零读点 —— 那个判据算了没人取")
    return out


def check_write_only_fields() -> list[str]:
    """② dataclass 字段被赋值构造，但全仓没有 `.field` 读点。"""
    out: list[str] = []
    for f in _py_files(DOMAIN_DIRS):
        src = f.read_text(encoding="utf-8")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            is_dc = any(
                (isinstance(d, ast.Name) and d.id == "dataclass")
                or (isinstance(d, ast.Call) and isinstance(d.func, ast.Name)
                    and d.func.id == "dataclass")
                for d in node.decorator_list)
            if not is_dc:
                continue
            for stmt in node.body:
                if not isinstance(stmt, ast.AnnAssign):
                    continue
                if not isinstance(stmt.target, ast.Name):
                    continue
                name = stmt.target.id
                if name.startswith("_"):
                    continue
                # 在**任何**文件里（含定义处）都没有 `.name` 读点 → 只写不读
                if _read_points(name, exclude=pathlib.Path("/nonexistent")) == 0:
                    out.append(
                        f"{f.relative_to(REPO)}:{stmt.lineno}: "
                        f"`{node.name}.{name}` 只被构造，全仓没有任何读点 —— "
                        f"它承载的语义实际不起作用")
    return out


def check_out_param_black_holes() -> list[str]:
    r"""③ 「创建一个空列表 → 传下去收集 → 自己从不读它」。

    ## 缺陷的真实形状

    ```python
    def _run_inspection(...):
        skipped: list[str] = []                    # ← 在这里创建
        pipeline.load_resources(..., skipped=skipped)   # ← 传下去被 append
        ...
        return build_stats(...)                    # ← **没有把它传进去**
    ```

    痕迹落进了一个没人读的列表。`refdata` 失败 → 证书临期与引擎 EOL 两类风险
    本轮零产出，而 run 状态照旧、`completeness` 不变（它数的是实例不是规则）。

    ## 判据（刻意做成**局部**的）

    ```
    在同一个函数体内
      ① 有 `X = []` 或 `X: list[...] = []`
      ② X 作为关键字实参传给某个调用（`f(..., k=X)`）
      ③ 而 X 在这个函数里**没有任何读点**（除了②那次传参本身）
    ```

    🔴 前两版都失败了，记下来免得再走：

    ```
    v1  正则扫 `\.symbol\b`         被解释性注释骗过（注释里提到符号名 = 读点）
    v2  全仓按变量名找「消费点」      `skipped` / `errors` 是极常见的局部名，
                                     whitelist.py 里一个无关的 `skipped` 就让它静默通过
    ```

    局部判据的代价是**只覆盖「在同一个函数里创建并传下去」这一种形态**——
    跨函数的收集链查不了。但那一种恰好是真实缺陷的形态，而且零假阳性。
    """
    out: list[str] = []
    for f in _py_files(CALLER_DIRS):
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError:                        # pragma: no cover
            continue
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            # ① 本函数里创建的空列表
            created: dict[str, int] = {}
            for node in ast.walk(fn):
                tgt = None
                if (isinstance(node, ast.AnnAssign) and node.value is not None
                        and isinstance(node.target, ast.Name)):
                    tgt, val = node.target.id, node.value
                elif (isinstance(node, ast.Assign) and len(node.targets) == 1
                        and isinstance(node.targets[0], ast.Name)):
                    tgt, val = node.targets[0].id, node.value
                if tgt and isinstance(val, ast.List) and not val.elts:
                    created[tgt] = node.lineno
            if not created:
                continue
            # ② 作为关键字实参传出去的
            passed: dict[str, str] = {}
            arg_nodes: set[int] = set()
            for node in ast.walk(fn):
                if not isinstance(node, ast.Call):
                    continue
                for kw in node.keywords:
                    if isinstance(kw.value, ast.Name) and kw.value.id in created:
                        passed[kw.value.id] = kw.arg or "?"
                        # ⚠️ **只**排除关键字转发这一处。第一版把所有位置实参
                        #    也排除了，于是 `sorted(skipped)` 这种**真读点**被
                        #    当成转发 —— 正确的写法（收集完 sorted 落库）
                        #    反而被报成缺口，而那是最刺眼的假阳性形态：
                        #    它会让人去「修」一段本来是对的代码。
                        #
                        # ⚠️ 代价是位置转发（`collect(x, skipped)`）会被算成读点
                        #    → 那种形态查不出来。本仓的出参按约定都是关键字参数
                        #    （`*` 之后），所以这个取舍是安全的。
                        arg_nodes.add(id(kw.value))
            # ③ 除了传参之外还有没有读点
            for name, kwname in sorted(passed.items()):
                reads = 0
                for node in ast.walk(fn):
                    if (isinstance(node, ast.Name) and node.id == name
                            and isinstance(node.ctx, ast.Load)
                            and id(node) not in arg_nodes):
                        reads += 1
                if reads == 0:
                    out.append(
                        f"{f.relative_to(REPO)}:{created[name]}: "
                        f"`{name} = []` 传给了 `{kwname}=` 之后**在本函数里"
                        f"再也没被读过** —— 收集到的痕迹落进一个没人读的列表")
    return out


def _is_name(node: ast.AST, name: str) -> bool:
    return isinstance(node, ast.Name) and node.id == name


def _mentions(node: ast.AST, name: str) -> bool:
    return any(_is_name(n, name) for n in ast.walk(node))


def main(argv: list[str]) -> int:
    update = "--update-baseline" in argv
    show_all = "--all" in argv

    # ⚠️ ② 默认**不跑**。它对被 `asdict()` / `as_dict()` 整体序列化的 dataclass
    #    全是假阳性（74 条），而巡检的 DTO 几乎都走那条路 —— 那么高的噪音会让
    #    人直接忽略整个脚本。`--fields` 手动跑，当一次性盘点用。
    findings = check_shall_orphans() + check_out_param_black_holes()
    if "--fields" in argv:
        findings += check_write_only_fields()

    if update:
        BASELINE.write_text(
            json.dumps(sorted(findings), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print(f"seams lint: 已把 {len(findings)} 条钉成基线 "
              f"→ {BASELINE.relative_to(REPO)}")
        return 0

    baseline = set()
    if BASELINE.exists():
        baseline = set(json.loads(BASELINE.read_text(encoding="utf-8")))
    new = [f for f in findings if f not in baseline]
    fixed = len(baseline) - len(set(findings) & baseline)

    if show_all:
        for f in sorted(findings):
            print(("  ✗ " if f not in baseline else "  · ") + f)
        print()

    if not new:
        msg = f"seams lint: clean（{len(findings)} 条已基线"
        if fixed > 0:
            msg += f"，{fixed} 条已修 —— 跑 --update-baseline 收缩基线"
        print(msg + "）")
        return 0

    print(f"seams lint: {len(new)} 条**新增**接线缺口"
          f"（{len(baseline)} 条已基线）")
    for f in new:
        print(f"  ✗ {f}")
    print()
    print("怎么办：")
    print("  · 真缺陷 → 把那个符号接到调用方（这才是修）")
    print("  · 假阳性 → 跑 --update-baseline，**并在代码里写一句为什么它不需要被读**")
    print("            直接塞基线不写理由等于开后门 —— 下一个人无从判断")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
