/**
 * 以「仓库根」为资产的 Python Lambda 代码包 —— 允许清单的判据（待办 #36，2026-10-23）。
 *
 * 以前这五个资产是「整个仓库根减一份排除清单」，16 个函数包里混进过 teardown 的数据备份、
 * internal/ 的发布工具、scripts/、publish/、setup.sh……（详见 lib/repo-root-code.ts 文件头）。
 * 现在只收 lambda-code-packages.json 里的包。这里用 **CDK 自己的** 复制逻辑（FileSystem.copyDirectory，
 * 与 fromAsset 暂存资产是同一段代码）核三件事：
 *   1. 模式表的语义：一棵故意塞满杂物的假仓库，只有允许的包进来（点文件 / 字节码缓存 / 文档 /
 *      备份目录 / internal/ 一个都不许有），巡检的判读 skill 要留下；
 *   2. 真仓库：每个资产的顶层只有允许的包、每个 handler 的模块文件都在；
 *   3. 真 synth（NotiOpsBackendStack + ImStack）：每个用仓库根资产的函数，暂存出来的包就是它那个
 *      资产该有的样子，而且 handler 列在那个资产的 handlers 里（lambda-code-packages.json 与栈对得上）。
 * 「handler 的 import 闭包落在包里」是 Python 那边的判据：tests/test_repo_root_code_allowlist.py。
 */
import * as cdk from "aws-cdk-lib";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";
import { ImStack } from "../lib/im-stack";
import { REPO_ROOT, RepoRootCodeAsset, repoRootCodeExcludes, repoRootCodeSpecs } from "../lib/repo-root-code";

const ASSETS = Object.keys(repoRootCodeSpecs()) as RepoRootCodeAsset[];

/** im-stack.ts 读的那份共享排除清单（方式 A 的 build_im_zips.py 同一份）。 */
function imExtra(): string[] {
  return fs.readFileSync(path.join(REPO_ROOT, "infra", "im-code-exclude.txt"), "utf-8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function excludesFor(name: RepoRootCodeAsset): string[] {
  return repoRootCodeExcludes(name, name === "im" ? imExtra() : []);
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function stage(src: string, exclude: string[]): string[] {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "repo-root-code-"));
  try {
    cdk.FileSystem.copyDirectory(src, dest, { exclude });
    return listFiles(dest);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

function handlerFile(handler: string): string {
  // "pkg.mod.func" → "pkg/mod.py"
  return handler.split(".").slice(0, -1).join("/") + ".py";
}

describe("模式表的语义（假仓库，故意塞满杂物）", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-repo-"));
    const files = [
      "core/__init__.py", "core/x.py", "core/sub/y.py", "core/data.json",
      "core/__pycache__/x.cpython-314.pyc", "core/.DS_Store", "core/.hidden/z.py", "core/README.md",
      "shared/a.py",
      "inspection/skills/cost-idle/SKILL.md", "inspection/skills/.DS_Store",
      "inspection/data/elasticache_eol.json", "inspection/README.md", "inspection/pipeline.py",
      "platforms/feishu/lambda_ingress.py", "platforms/feishu/Dockerfile",
      // 仓库根的杂物 —— 一个都不许进包
      "internal/release/rc-tools/drive_setup.py", "publish/include.txt", "scripts/install_hooks.sh",
      "setup.sh", "teardown.sh", "CODEOWNERS", "README.md", "requirements-dev.txt",
      "notiops-teardown-backup-20260920T115138Z/notiops-web-chat.json",
      "notiops-oneclick-backup-20261010T035311Z/notiops-config.json",
      ".claude/worktrees/other/core/x.py", ".npmrc", ".venv/lib/site.py", ".cdk-out/asset.1/core/x.py",
      "dist/oneclick/im-code.zip", "infra/cdk.out/asset.2/x.py", "lambda_layer/python/boto3/__init__.py",
      "frontend/chat-app/dist/index.html", "node_modules/x/index.js",
    ];
    for (const f of files) {
      fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), "x");
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test("backend：只有允许的包，判读 skill 的 SKILL.md 留下", () => {
    expect(stage(root, excludesFor("backend"))).toEqual([
      "core/__init__.py", "core/data.json", "core/sub/y.py", "core/x.py",
      "inspection/data/elasticache_eol.json", "inspection/pipeline.py", "inspection/skills/cost-idle/SKILL.md",
      "shared/a.py",
    ]);
  });

  test("push：只有 core / shared", () => {
    expect(stage(root, excludesFor("push"))).toEqual([
      "core/__init__.py", "core/data.json", "core/sub/y.py", "core/x.py", "shared/a.py",
    ]);
  });

  test("im：带上共享排除清单 —— Dockerfile 与所有 .md 都剪掉（方式 A 的 im-code.zip 同口径）", () => {
    expect(stage(root, excludesFor("im"))).toEqual([
      "core/__init__.py", "core/data.json", "core/sub/y.py", "core/x.py",
      "inspection/data/elasticache_eol.json", "inspection/pipeline.py",
      "platforms/feishu/lambda_ingress.py",
      "shared/a.py",
    ]);
  });
});

describe("真仓库：每个资产只收允许的包，handler 都在", () => {
  const specs = repoRootCodeSpecs();
  for (const name of ASSETS) {
    test(name, () => {
      const files = stage(REPO_ROOT, excludesFor(name));
      const spec = specs[name];
      const tops = [...new Set(files.map((f) => f.split("/")[0]))].sort();
      expect(tops).toEqual([...spec.packages].sort());
      for (const h of spec.handlers) expect(files).toContain(handlerFile(h));
      const junk = files.filter((f) => f.split("/").some((seg) => seg.startsWith(".") || seg === "__pycache__")
        || f.endsWith(".pyc")
        || (f.endsWith(".md") && !(spec.keepMarkdown ?? []).some((d) => f.startsWith(`${d}/`))));
      expect(junk).toEqual([]);
      if (name === "backend") {
        for (const f of ["inspection/skills/cost-idle/SKILL.md", "inspection/skills/high-load/SKILL.md",
          "inspection/skills/_shared/GUARDRAILS.md"]) expect(files).toContain(f);
      }
    });
  }
});

describe("真 synth：函数的代码包就是它那个资产，handler 列在那个资产下", () => {
  const expected = new Map<string, RepoRootCodeAsset>();   // 暂存出来的文件清单（JSON）→ 资产名
  for (const name of ASSETS) expected.set(JSON.stringify(stage(REPO_ROOT, excludesFor(name))), name);

  interface FnResource { Type: string; Properties: { Handler?: string; Code?: { S3Key?: unknown } } }
  interface Fn { id: string; handler: string; asset?: RepoRootCodeAsset }

  function functionsWithRepoRootCode(stack: cdk.Stack, assemblyDir: string): Fn[] {
    const tpl = JSON.parse(fs.readFileSync(path.join(assemblyDir, stack.templateFile), "utf-8"));
    const out: Fn[] = [];
    for (const [id, r] of Object.entries(tpl.Resources as Record<string, FnResource>)) {
      if (r.Type !== "AWS::Lambda::Function") continue;
      const handler = r.Properties.Handler ?? "";
      const key = r.Properties.Code?.S3Key;
      if (typeof key !== "string" || !/^[0-9a-f]{64}\.zip$/.test(key)) continue;
      const dir = path.join(assemblyDir, `asset.${key.slice(0, -4)}`);
      if (!fs.existsSync(dir)) continue;
      const files = listFiles(dir);
      if (!files.some((f) => f.startsWith("core/"))) continue;   // 只看仓库根打的那几个
      out.push({ id, handler, asset: expected.get(JSON.stringify(files)) });
    }
    return out;
  }

  test("NotiOpsBackendStack + ImStack", () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-root-code-synth-"));
    try {
      const app = new cdk.App({ outdir, context: { enabledPlatforms: "feishu,slack,dingtalk" } });
      const env = { account: "111122223333", region: "us-east-1" };
      const backend = new NotiOpsBackendStack(app, "TestBackend", { env });
      const im = new ImStack(app, "TestIm", {
        env, metricsTableName: "m", configTableName: "c", conversationsTableName: "v", skillsBucketName: "s",
        enabledPlatforms: ["feishu", "slack", "dingtalk"],
      });
      const asm = app.synth();
      const fns = [...functionsWithRepoRootCode(backend, asm.directory), ...functionsWithRepoRootCode(im, asm.directory)];
      // 后端 7 + 回调 1 + 推送 2（IM push / 网页通知）+ IM（3 个平台 × 2 + progress）= 17；PHD 只在组织模式下有
      expect(fns.length).toBeGreaterThanOrEqual(17);
      const specs = repoRootCodeSpecs();
      const bad = fns
        .filter((f) => !f.asset || !specs[f.asset].handlers.includes(f.handler))
        .map((f) => `${f.id} (${f.handler}) → ${f.asset ? `资产 ${f.asset} 的 handlers 里没有它` : "代码包不是任何一个允许清单"}`);
      expect(bad).toEqual([]);
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });
});
