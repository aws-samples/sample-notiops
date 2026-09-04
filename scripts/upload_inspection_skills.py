#!/usr/bin/env python3
"""把 `inspection/skills/` 下的判读 skill 同步到 DevOps Agent 的 Agent Space。

## 为什么需要这个脚本

判读 skill 的内容在仓库里（`inspection/skills/`），而 DA 读的是 Agent Space
里的 Asset —— 两者之间此前**没有任何自动同步**：

```
UI 的 Skills 页        管 S3 里的 skill（notiops-data-…/skills/，12 个预置）
                       有「发布到 DevOps Agent」按钮
巡检的判读 skill        在仓库 inspection/skills/ 里
                       没有 UI 入口，setup.sh 与 CDK 里也没有上传步骤
```

`scripts/sync_inspection_skills.py` 只保证**仓库里**两份 SKILL.md 与
`_shared/GUARDRAILS.md` 逐字一致 —— 它管不到「传上去了没有、传的是哪个版本」。

实际后果（2026-08-24 实测）：巡检 space 里那两份是 **8/22** 的版本，而 8/23
往 `_shared/GUARDRAILS.md` 里加的三段（PI 方法论 / 内存双条件 / burstable）
一直没生效 —— 改了仓库不等于改了 DA 手里的那份。本脚本 + `setup.sh` 的
`[3.5/4]` 步补上这后半段。

⚠️ 2026-08-24 还踩过一次「查错 space」：用 `AgentSpaceId`（排障那个）去查，
发现两份都不在，于是误判成「从未上传」并把它们传进了排障 space。
这也是下面 `_SPACE_OUTPUT_KEY` 那段注释存在的原因。

## 用法

```bash
# 自动发现 Agent Space（从 CFN 输出读）
python3 scripts/upload_inspection_skills.py

# 或显式指定
python3 scripts/upload_inspection_skills.py --space <uuid>

# 只看会传什么，不真传
python3 scripts/upload_inspection_skills.py --dry-run
```

幂等 —— 内容没变时 `client_token` 不变，服务端不产生新版本；`asset_id` 也稳定。

⚠️ 上传的是**仓库当前内容**。跑之前确认
`python3 scripts/sync_inspection_skills.py` 是绿的，否则会把一份共享段没同步
的 skill 传上去。
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SKILLS_DIR = ROOT / "inspection" / "skills"


# 🔴 **必须是 `InspectionAgentSpaceId`，不是 `AgentSpaceId`。**
#
# 这套部署有**两个** Agent Space，是刻意拆开的（见
# `infra/lib/notiops-backend-stack.ts` 的 InspectionAgentSpace 那段注释）：
#
# ```
# AgentSpaceId            排障 / web chat 用   notiops-devops-<account>
# InspectionAgentSpaceId  巡检专用            notiops-inspection-<account>
# ```
#
# 拆开的理由之一正是 skill：**skill 是 per agent space 的**（Asset API 全部
# 必填 agentSpaceId）。判读 skill 只能待在巡检 space —— 传进排障 space 会让
# 客户的深度调查误加载它们（skill 激活是 description 语义匹配，命中并不精确），
# 或者被它们的 skip criteria 跳过（Investigation Skipped）。
#
# 而 executor 派发 task 用的是 `INSPECT_AGENT_SPACE_ID`（= 巡检那个），
# 所以 skill 传错 space 的后果是**两头都错**：
#   · 巡检 space 里没有 skill  → DA 判读时仍然加载不到 GUARDRAILS
#   · 排障 space 里多了 skill  → 污染客户的排障调查
#
# ⚠️ 2026-08-24 第一版这里读的就是 `AgentSpaceId`，真的传错过一次。
_SPACE_OUTPUT_KEY = "InspectionAgentSpaceId"


def _resolve_space(region: str) -> str:
    """从 CFN 输出拿**巡检**的 Agent Space ID。拿不到返回空串。

    ⚠️ 用 CFN 输出而不是 `ListAgentSpaces`：后者会把排障那个也列出来，
    而两个 space 的名字只差一个词（`notiops-devops-` / `notiops-inspection-`）。
    """
    try:
        import boto3
        cf = boto3.client("cloudformation", region_name=region)
        outs = cf.describe_stacks(StackName="NotiOpsBackendStack")[
            "Stacks"][0].get("Outputs", [])
        for o in outs:
            if o.get("OutputKey") == _SPACE_OUTPUT_KEY:
                return str(o.get("OutputValue") or "").strip()
        print(f"  CFN 输出里没有 {_SPACE_OUTPUT_KEY} —— "
              f"有的是: {sorted(str(o.get('OutputKey')) for o in outs if 'Space' in str(o.get('OutputKey')))}")
    except Exception as e:                     # noqa: BLE001
        print(f"  从 CFN 输出读 {_SPACE_OUTPUT_KEY} 失败: {type(e).__name__}: {e}")
    return ""


def _verify(space: str, region: str, dirs: list[str], client=None) -> int:
    """把 space 里的 `SKILL.md` 拉下来与仓库逐字对比。

    ## 为什么需要它

    上传是幂等的（内容没变时 `client_token` 不变），但「传成功了」与
    **「DA 手里那份是仓库当前版本」不是同一件事**：

    ```
    传进了错的 space        2026-08-24 真的发生过（读了 AgentSpaceId 而不是
                            InspectionAgentSpaceId）—— 上传全部成功，
                            而巡检 space 里还是 8/22 的旧版
    传的是没同步的仓库内容  `_shared/GUARDRAILS.md` 改了但没跑 sync
    有人在控制台手改过       没有任何本地信号
    ```

    这三种都表现为「DA 的判读依据不是我们以为的那份规则」，而**判读结果看起来
    完全正常** —— 它照样会输出结论，只是那些结论基于旧阈值 / 缺失的方法论段。

    所以判据是**逐字比对正文**，不是比版本号或时间戳：版本号只说明「更新过」，
    不说明「更新成了什么」。

    ## 实现说明

    `GetAssetContent` 返回的是 **zip**（`content.zipFile`），里面一个
    `SKILL.md`。⚠️ 不要用 `ListAssetFiles` / `GetAssetFile` ——
    2026-08-25 实测这两个对 skill 类型的 asset 返回**空文件列表**，
    据此判断会得出「远端是空的」这个错误结论。
    """
    import difflib
    import io
    import zipfile

    try:
        import boto3
    except ImportError as e:
        print(f"❌ 缺依赖: {e}")
        return 1

    # ⚠️ `client` 由调用方注入（多账号模式下是**跨账号**那个）。
    #    不注入就建本地的 —— 那只对部署账号自己有效。
    #    用本地 client 去 ListAssets 成员账号的 space 会
    #    ResourceNotFoundException，而下面那段会把它报成「ListAssets 失败」，
    #    读起来像 API 问题，而真相是用错了凭证。
    c = client or boto3.client("devops-agent", region_name=region)
    try:
        resp = c.list_assets(agentSpaceId=space)
    except Exception as e:                                 # noqa: BLE001
        print(f"❌ ListAssets 失败: {type(e).__name__}: {e}")
        return 1

    # 🔴 响应键是 **`items`**，不是 `assets`（2026-08-25 实测）。
    #    第一版写成 `.get("assets")` → 恒为空 → 报「space 里没有这个 skill」，
    #    而两份 skill 明明都在。**这个方向的误报特别难查**：它看起来像
    #    「上传丢了」，于是下一步动作是再传一次，而那什么都修不了。
    assets = resp.get("items") or resp.get("assets") or []
    if not assets:
        # 区分「space 是空的」与「我们没读对响应」——
        # 后者会把一次成功的验证读成失败，而失败的处置动作是「再传一次」。
        print(f"❌ 读不到 asset 列表。响应顶层键: "
              f"{[k for k in resp if k != 'ResponseMetadata']} —— "
              "如果这里面有像是列表的键而代码没认，那是 API 形状变了，"
              "不是 space 空了。")
        return 1

    # asset 名是 `inspection-<目录名>`（`skill_upload.sync_all_skills` 的约定）
    by_name = {
        str((a.get("metadata") or {}).get("name") or ""): a
        for a in assets if a.get("assetType") == "skill"
    }

    bad = 0
    unverifiable = 0
    for d in dirs:
        want = f"inspection-{d}"
        local_path = SKILLS_DIR / d / "SKILL.md"
        local = local_path.read_text(encoding="utf-8")
        a = by_name.get(want)
        if a is None:
            print(f"  ❌ {want}: space 里**没有**这个 skill "
                  f"（现有的: {sorted(k for k in by_name if k.startswith('inspection-'))}）")
            bad += 1
            continue
        try:
            r = c.get_asset_content(agentSpaceId=space, assetId=a["assetId"])
            z = zipfile.ZipFile(io.BytesIO(r["content"]["zipFile"]))
            remote = z.read("SKILL.md").decode()
        except Exception as e:                             # noqa: BLE001
            # 🔴 **「读不回来」与「内容不一致」必须分开报。**
            #
            #    成员账号的触发角色（`infra/member-devops-agent.yaml`）只有
            #    Create/Update/Delete/ListAssets，**没有** GetAsset /
            #    GetAssetContent。把 AccessDenied 报成「与仓库不一致」会让
            #    运维照着提示「再传一次」—— 而再传一万次也修不了一个
            #    IAM 缺权限，且上传本来就是成功的。
            #
            #    这正是本函数 docstring 警告的那类误报的镜像版本：
            #    那里说的是「验证通过被读成失败」，这里是「验证做不了被读成
            #    验证失败」。两者的处置动作完全不同。
            code = ""
            resp = getattr(e, "response", None)
            if isinstance(resp, dict):
                code = str((resp.get("Error") or {}).get("Code") or "")
            if "AccessDenied" in code or "AccessDenied" in type(e).__name__:
                print(f"  ⚠️ {want}: **无法逐字校验** —— 这个角色没有 "
                      f"aidevops:GetAssetContent。"
                      f"退化证据: asset v{a.get('version')}，"
                      f"更新于 {a.get('updatedAt')}（上传本身是成功的）。"
                      f"要恢复这道防线，给 member-devops-agent.yaml 的触发角色"
                      f"加 aidevops:GetAsset + GetAssetContent 并重新部署成员栈。")
                unverifiable += 1
                continue
            print(f"  ❌ {want}: 取内容失败 {type(e).__name__}: {str(e)[:110]}")
            bad += 1
            continue
        if remote.strip() == local.strip():
            print(f"  ✓ {want}: 逐字一致（{len(local)} 字符，asset v{r.get('version')}，"
                  f"更新于 {a.get('updatedAt')}）")
            continue
        bad += 1
        diff = [x for x in difflib.unified_diff(
            remote.splitlines(), local.splitlines(), "space", "repo",
            lineterm="", n=0)
            if x.startswith(("+", "-")) and not x.startswith(("+++", "---"))]
        print(f"  ❌ {want}: **不一致** —— 远端 {len(remote)} 字符 / "
              f"仓库 {len(local)} 字符，差异 {len(diff)} 行")
        for line in diff[:10]:
            print(f"       {line[:118]}")
        if len(diff) > 10:
            print(f"       …还有 {len(diff) - 10} 行")

    if bad:
        print(f"\n❌ {bad} 份 skill 与仓库不一致 —— "
              "DA 的判读依据不是当前规则。跑一次不带 --verify 的上传修好它。")
        return 1
    if unverifiable:
        # ⚠️ 退出码 **0**：没有发现任何不一致，只是这个角色证明不了一致。
        #    返回 1 会让 setup.sh / CI 把「缺一个只读权限」当成部署失败，
        #    而真正的不一致（`bad`）反而淹没在同一个非零码里。
        print(f"\n⚠️ {unverifiable} 份 skill **无法逐字校验**（缺 "
              "aidevops:GetAssetContent），另 "
              f"{len(dirs) - unverifiable} 份一致。"
              "上传成功且 asset 版本已前进，但这个角色证明不了内容。")
        return 0
    print(f"\n✅ {len(dirs)} 份 skill 与仓库完全一致 —— "
          "DA 手里的就是仓库当前版本。")
    return 0


def _sync_all_accounts(args, dirs: list[str]) -> int:
    """把判读 skill 传到**每个**已启用账号自己的巡检 space（改动⑤ 的同批项）。

    🔴 **不做这一步的后果是额度白花**：成员账号的巡检 space 里没有
    `cost-idle` / `high-load` / `_shared/GUARDRAILS.md` → DA 用通用提示词自由
    发挥 → 切不出 `## <finding_id>` 节 → 全部 `da_parse_status: parse_failed`。
    判读的钱花了，结果全是废的。
    ⚠️ 好消息是这一种**不静默**：总览页那条红色告警的判据含 parse_failed。

    🔴 **space 的解析必须复用 `inspection.adapters.da_client.resolve`**，
    与 executor 派发、reconciler 对账用的是同一个函数。各写一遍的后果是
    「skill 传进了 space A，而 task 派进了 space B」——
    2026-08-24 真的发生过一次（setup.sh 的注释里记着）。
    共用一个解析函数让那件事在结构上不可能。

    ⚠️ 部分失败**必须可见**：逐账号收集失败，最后非零退出。
    setup.sh 那侧是 best-effort 不阻断部署（那是刻意的 —— 部署不该因为一个
    成员账号的 assume 失败而停），所以这里的退出码是运维唯一的信号。
    """
    import boto3

    from inspection.adapters import accounts as acct_repo
    from inspection.adapters import da_client
    from inspection.adapters.skill_upload import sync_all_skills

    region = args.region
    ddb = boto3.resource("dynamodb", region_name=region)
    cfg_name = os.environ.get("CONFIG_TABLE", "notiops-config")
    cfg_tbl = ddb.Table(cfg_name)
    deploy_acct = boto3.client("sts", region_name=region).get_caller_identity()[
        "Account"]
    env_space = args.space or _resolve_space(region)

    try:
        accounts = acct_repo.enabled_accounts(cfg_tbl)
    except Exception as e:                     # noqa: BLE001
        print(f"❌ 读不到已启用账号列表（表 {cfg_name}）: "
              f"{type(e).__name__}: {e}")
        return 1
    if not accounts:
        print(f"⚠️ 没有已启用的账号（表 {cfg_name} 的 GSI1PK=da#accounts）"
              " —— 没有任何 space 需要同步")
        return 0

    print(f"已启用账号 {len(accounts)} 个: {accounts}")
    print(f"部署账号: {deploy_acct}   region: {region}")

    ok_n, failures = 0, []
    for acct in accounts:
        try:
            space, client = da_client.resolve(
                acct, deploy_account_id=deploy_acct, home_region=region,
                config_table=cfg_tbl, env_space_id=env_space,
                source="skill-sync")
        except Exception as e:                 # noqa: BLE001
            failures.append((acct, f"解析判读目标失败: {e}"))
            print(f"  ✗ {acct}: 解析判读目标失败 —— {e}")
            continue
        if args.dry_run:
            print(f"  · {acct} → space {space}（--dry-run，不真传）")
            ok_n += 1
            continue
        if args.verify:
            # 🔴 **校验也要逐账号做。** 只验部署账号那一个的话，
            #    本函数上方 `_verify` 的 docstring 里列的三种失败
            #    （传进错的 space / 仓库没同步 / 有人在控制台手改过）
            #    在成员账号上完全没有防线 —— 而第一种 2026-08-24 真的发生过。
            print(f"  校验 {acct} → space {space}")
            if _verify(space, region, dirs, client=client) != 0:
                failures.append((acct, "skill 与仓库不一致"))
                continue
            ok_n += 1
            continue
        try:
            res = sync_all_skills(client, space, SKILLS_DIR, notes=None)
        except Exception as e:                 # noqa: BLE001
            failures.append((acct, f"{type(e).__name__}: {e}"))
            print(f"  ✗ {acct} (space {space}): {type(e).__name__}: {e}")
            continue
        acts = ", ".join(
            f"{r.get('skill') or r.get('name') or '?'}={r.get('action')}"
            for r in res)
        print(f"  ✓ {acct} → space {space}: {acts}")
        ok_n += 1

    print(f"\n{ok_n}/{len(accounts)} 个账号已对齐。")
    if failures:
        # 🔴 逐条列出来。汇总成一句「N 个失败」会让运维不知道去哪个账号看。
        print("失败的账号（这些账号的判读会全部 parse_failed，额度照花）:")
        for acct, why in failures:
            print(f"  · {acct}: {why}")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    # 🔴 env 名是 `INSPECT_AGENT_SPACE_ID`（不是 `INSPECTION_…`）。
    #    2026-08-30 之前这里写的是多一个 `ION` 的版本 —— 全仓 CDK 与 setup.sh
    #    设的都是 `INSPECT_AGENT_SPACE_ID`，所以那条捷径**永远为空**，
    #    每次都静默落到 `_resolve_space()` 的 CFN 查询上（慢，且 CFN 拿不到时
    #    报错文案指向的是 `--space` 而不是那个 env）。
    ap.add_argument("--space", default=os.environ.get("INSPECT_AGENT_SPACE_ID", ""),
                    help="Agent Space ID（缺省读 INSPECT_AGENT_SPACE_ID，"
                         "再缺省从 CFN 输出自动发现）")
    ap.add_argument("--all-accounts", action="store_true",
                    help="传给**所有**已启用账号各自的巡检 space"
                         "（per-account agent space；部署账号也含在内）")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION")
                    or os.environ.get("DEPLOY_REGION") or "ap-northeast-1")
    ap.add_argument("--dry-run", action="store_true",
                    help="只列出会传什么，不真传")
    ap.add_argument("--verify", action="store_true",
                    help="不上传，把 space 里的 SKILL.md 拉下来与仓库逐字对比")
    args = ap.parse_args()

    # 🔴 **必须钉死 `AWS_DEFAULT_REGION`，不能只靠 `AWS_REGION`。**
    #
    # 本机跑（带 `AWS_PROFILE`）时 botocore 的 region 解析里，
    # `~/.aws/config` 那个 profile 的 `region` **压过** `AWS_REGION`，
    # 只有 `AWS_DEFAULT_REGION` 盖得住它。2026-09-02 实测：
    #
    # ```
    # AWS_PROFILE=<某个 profile> AWS_REGION=ap-northeast-1
    #   boto3.Session().region_name          → us-west-2   ← profile 赢了
    # 加上 AWS_DEFAULT_REGION=ap-northeast-1
    #   boto3.resource("dynamodb")           → ap-northeast-1
    # ```
    #
    # 后果不是报错，是**报错报在别的地方**：本脚本自己建的 client 都显式带
    # region（对的），但 `--all-accounts` 会经 `shared.devops_agent` 读
    # `da#<acct>` 行，而 `shared/queries/_client.py::_dynamodb()` 不传 region
    # → 去 us-west-2 查 `notiops-config` → `ResourceNotFoundException`
    # → 被上层包装成「解析判读目标失败」。读起来像账号没登记、或权限不足，
    # 而真相是查错了区域。实测三个账号里只有部署账号成功（它走 env space
    # 那条捷径，压根不读 DDB），两个成员账号全挂 —— 而那正好长得像
    # 「跨账号 assume 有问题」。
    #
    # ⚠️ **不改 `shared/queries/_client.py`**：Lambda 里没有 profile 也没有
    #    配置文件，`AWS_REGION` 由运行时注入，那边解析本来就是对的。
    #    为一个本机专属的差异去改所有 Lambda 共用的建连代码，风险不对等。
    os.environ.setdefault("AWS_DEFAULT_REGION", args.region)

    if not SKILLS_DIR.is_dir():
        print(f"❌ 找不到 {SKILLS_DIR.relative_to(ROOT)}")
        return 1

    dirs = sorted(p.name for p in SKILLS_DIR.iterdir()
                  if p.is_dir() and not p.name.startswith("_"))
    print(f"仓库里的判读 skill: {dirs}")

    # ⚠️ `--all-accounts` 与 `--verify` / `--dry-run` **可以叠加**
    #    （多账号里各自分流），所以这个判断要在单账号那两条分支之前。
    if args.all_accounts:
        return _sync_all_accounts(args, dirs)

    space = args.space or _resolve_space(args.region)
    if not space:
        print("❌ 解析不出 Agent Space ID。用 --space <uuid> 显式指定，"
              "或确认 NotiOpsBackendStack 有 AgentSpaceId 输出。")
        return 1
    print(f"目标 Agent Space: {space}  （region {args.region}）")

    if args.dry_run:
        print("\n--dry-run：不真上传。")
        return 0

    if args.verify:
        return _verify(space, args.region, dirs)

    try:
        import boto3
        from inspection.adapters.skill_upload import sync_all_skills
    except ImportError as e:
        print(f"❌ 缺依赖: {e}。装 boto3 或用项目的 .venv 跑。")
        return 1

    client = boto3.client("devops-agent", region_name=args.region)
    try:
        # notes=None —— 不带任何客户补充说明，传的就是仓库内容。
        res = sync_all_skills(client, space, SKILLS_DIR, notes=None)
    except Exception as e:                     # noqa: BLE001
        print(f"❌ 上传失败: {type(e).__name__}: {e}")
        return 1

    for r in res:
        name = r.get("skill") or r.get("name") or "?"
        print(f"  ✓ {name}: {r.get('action')}  asset={r.get('asset_id')}")
    print(f"\n{len(res)} 份 skill 已对齐 Agent Space。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
