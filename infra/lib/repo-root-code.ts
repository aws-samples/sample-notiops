import * as fs from "fs";
import * as path from "path";
import * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * 方式 B（setup.sh / CDK）里以「仓库根」为资产的 Python Lambda 代码包 —— **允许清单**（待办 #36，2026-10-23）。
 *
 * 以前这五个资产（后端 lambdaCode / devopsCallbackCode / pushLambdaCode / phdLambdaCode + IM 的 imCode）
 * 都是 `Code.fromAsset("../", { exclude: [...] })`：打包**文件系统**里的整个仓库根、减去一份按名字列的
 * 排除清单。fromAsset 不看 .gitignore，而仓库根里随时会多出东西 —— 16 个函数包里实测混进过：
 *   · teardown.sh 默认写在仓库根的数据备份（配置表 / 网页会话表的导出，验证账号 v1.0.32 实测 45 个文件）；
 *   · internal/ 的发布工具、publish/、scripts/、setup.sh、CODEOWNERS、requirements-dev.txt；
 *   · 一次 synth 里另一个会话的 worktree 检出（`.claude/worktrees/…`，858 个文件，审 assembly 拦下）。
 * 排除清单永远追不上「仓库根又多了什么」；允许清单只认「运行时要什么」。清单本身在
 * `infra/lambda-code-packages.json`（方式 A 的 im-code.zip 读同一份），每个 handler 的 import 闭包必须
 * 落在它的包里 —— tests/test_repo_root_code_allowlist.py 守着，infra/test/repo-root-code.test.ts 真 synth 核。
 *
 * 模式的语义是 CDK 的 GLOB（aws-cdk-lib core/lib/fs/ignore.js：
 * `minimatch(rel, pattern, { matchBase: true, flipNegate: true })`，逐条求值、**后面的胜出**），
 * 几个反直觉的地方决定了下面的写法：
 *   · 不带 `/` 的模式按 basename 匹配**任意深度**（matchBase）—— 所以 `*` 一条就关掉了所有东西；
 *   · minimatch 没开 `dot`：`*` 和 `**` 都不匹配点开头的名字 —— 点文件 / 点目录要单独写 `.*`；
 *   · `core/**` **不匹配** `core` 目录本身，而被判为排除的目录会整棵剪掉、不再往里走
 *     （copy.js 先对目录调 completelyIgnores）—— 所以每个包要放回两条：`!core` 和 `!core/**`；
 *   · `**` 不匹配点名，所以 `!core/**` 放不回 `core/.DS_Store` 这类东西（符合预期，下面仍显式再排一次）。
 */

/** 仓库根（绝对路径）。以前写的是相对 cwd 的 `"../"`（只在 infra/ 下跑 cdk 时成立）。 */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const REPO_ROOT_CODE_SPEC_FILE = path.join(__dirname, "..", "lambda-code-packages.json");

export type RepoRootCodeAsset = "backend" | "devopsCallback" | "push" | "phd" | "im";

export interface RepoRootCodeSpec {
  /** 收哪些顶层包（仓库根下的目录名）。 */
  packages: string[];
  /** 这些目录里的 .md 要留（其余 .md 一律不进包）。 */
  keepMarkdown?: string[];
  /** 这个资产服务的 Lambda handler（jest 拿 synth 结果反核）。 */
  handlers: string[];
}

let cache: Record<string, RepoRootCodeSpec> | undefined;

export function repoRootCodeSpecs(): Record<RepoRootCodeAsset, RepoRootCodeSpec> {
  if (!cache) {
    const raw = JSON.parse(fs.readFileSync(REPO_ROOT_CODE_SPEC_FILE, "utf-8")) as { assets?: Record<string, RepoRootCodeSpec> };
    cache = raw.assets ?? {};
  }
  return cache as Record<RepoRootCodeAsset, RepoRootCodeSpec>;
}

export function repoRootCodeSpec(name: RepoRootCodeAsset): RepoRootCodeSpec {
  const spec = repoRootCodeSpecs()[name];
  // 清单读不到 / 写坏时当场失败：`packages: []` 会**成功**打出一个空包，部署上去每个函数都
  // ImportModuleError —— 而 synth、cdk diff、部署本身全是绿的。
  if (!spec || !Array.isArray(spec.packages) || spec.packages.length === 0) {
    throw new Error(`${REPO_ROOT_CODE_SPEC_FILE}: assets.${name}.packages 缺失或为空 —— 代码包会是空的`);
  }
  for (const p of spec.packages) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
      throw new Error(`${REPO_ROOT_CODE_SPEC_FILE}: assets.${name}.packages 里的 "${p}" 不是仓库根下的 Python 包名`);
    }
    const dir = path.join(REPO_ROOT, p);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !fs.readdirSync(dir).some((f) => f.endsWith(".py"))) {
      throw new Error(`${REPO_ROOT_CODE_SPEC_FILE}: assets.${name}.packages 里的 "${p}" 在仓库根下找不到 Python 代码`);
    }
  }
  return spec;
}

/**
 * 给 `Code.fromAsset(REPO_ROOT, { exclude })` 用的模式表。**顺序有意义**（后面的胜出）。
 * `extra` 追加在最后（IM 用它带上两条路径共用的 infra/im-code-exclude.txt）。
 */
export function repoRootCodeExcludes(name: RepoRootCodeAsset, extra: string[] = []): string[] {
  const spec = repoRootCodeSpec(name);
  return [
    // ① 全关。`*` 管任意深度的普通名字，`.*` / `.*/**` 管点名（minimatch 没开 dot）。
    "*", ".*", ".*/**",
    // ② 按包放回：目录本身一条、目录里的东西一条（只写 `!core/**` 的话 `core` 目录先被整棵剪掉）。
    ...spec.packages.flatMap((p) => [`!${p}`, `!${p}/**`]),
    // ③ 包里的文档不进包，只放回运行时要读的（巡检的判读 skill）。必须在 `*.md` **之后**。
    "*.md",
    ...(spec.keepMarkdown ?? []).map((d) => `!${d}/**`),
    // ④ 包里的本机产物：字节码缓存、点文件 / 点目录。放在 ③ 之后，免得被 keepMarkdown 的否定式放回来。
    "**/__pycache__", "**/__pycache__/**", "*.pyc", "**/.*", "**/.*/**",
    ...extra,
  ];
}

export function repoRootCode(name: RepoRootCodeAsset, extra: string[] = []): lambda.AssetCode {
  return lambda.Code.fromAsset(REPO_ROOT, { exclude: repoRootCodeExcludes(name, extra) });
}

/**
 * 依赖层目录（lambda_layer / lambda_layer_im / lambda_layer_cost）的排除项。
 *
 * 只按**名字**排两样已知的本机杂物，**不能**写 `.*`：manylinux wheel 经 auditwheel 修复后可能带
 * `<包>/.libs/` 目录，里面就是那个包要加载的 .so —— 按点名一刀切，import 时才 `ImportError`，
 * 而 synth 和部署全是绿的。
 *   · `.ci-stub` —— scripts/ci_cdk_asset_stubs.sh 的占位文件。现网主层（2026-10-23 只读下载核过）
 *     就带着它：某次部署前在同一个目录里跑过 CI 占位脚本。0 字节、无害，但不该进层；
 *   · `.DS_Store` —— macOS Finder。
 */
export const LAYER_ASSET_EXCLUDES = [".ci-stub", ".DS_Store"];
