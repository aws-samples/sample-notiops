#!/usr/bin/env bash
# backfill_runtime_env.sh — 幂等回填 AgentCore Runtime 的 env 真值 + idle 超时。
#
# 【为什么存在】单一权威实现。此前有两处各自写 runtime env,极易漂移:
#   1) deploy_agent.sh §5 —— agentcore deploy 之后强制回填(防"占位符上线")。
#   2) setup.sh —— `cdk deploy --all` 之后再补齐【只有 NotiOpsBackendStack 部署完
#      才拿得到】的两个输出(AgentSpaceId / ReportsCdnDomain)。
# deploy_agent.sh 跑在 setup.sh 早处(agent 需先建以便 WebChatStack 注入 ARN),
# 那时 NotiOpsBackendStack 还不存在 → 这两个值只能取到空串,退化成运行时自动发现 +
# 12h presigned。首次全新安装必踩;只有重跑(栈已存在)才正常。把回填收敛到本脚本,
# 两处都调它 → 逻辑不再各写一份、不会漂移。
#
# 【语义:MERGE-PATCH】只覆盖【显式传入】的 env key;其余(MEMORY_* 等框架注入的、
# 以及本次未传入的 key)原样保留。因此 setup.sh 事后只补两个值时,不会误清
# deploy_agent.sh 已设好的 gateway URL / SKILLS_BUCKET。
#
# 【用法】
#   REGION=us-east-1 RT_ARN=<runtime-arn>  bash backfill_runtime_env.sh KEY=VAL [KEY=VAL ...]
#   REGION=us-east-1 RT_ID=<runtime-id>    bash backfill_runtime_env.sh KEY=VAL [KEY=VAL ...]
# 可选 env:
#   SET_IDLE   idleRuntimeSessionTimeout 秒数(默认 3600;置空="" = 保留当前 idle 不改)。
#   UI_LANG    zh/en(默认 en),双语输出。
# 退出码:0 成功;非 0 = 取不到配置 / 更新失败(调用方决定是否阻断,通常不阻断)。
set -euo pipefail

export UI_LANG="${UI_LANG:-en}"
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

REGION="${REGION:?REGION required}"
SET_IDLE="${SET_IDLE-3600}"   # 用 - 而非 :- ,允许显式置空 = 保留当前 idle

# RT_ID:优先用显式 RT_ID,否则从 RT_ARN 取末段。
# ARN 形如 arn:aws:bedrock-agentcore:<region>:<acct>:runtime/<RuntimeId>(runtime 前是冒号,
# RuntimeId 前是斜杠);"${x##*/}" 取最后一个 / 之后,同时兼容 :runtime/ 与 /runtime/。
RT_ID="${RT_ID:-}"
if [ -z "$RT_ID" ]; then
  RT_ARN="${RT_ARN:?RT_ARN or RT_ID required}"
  RT_ID="${RT_ARN##*/}"
fi

# 传入的 env 覆盖对(KEY=VALUE),原样交给 python(空值合法 = 显式设为空串)。
OVERRIDES=("$@")
if [ "${#OVERRIDES[@]}" -eq 0 ]; then
  echo "  $(t "⚠ backfill_runtime_env: 未传入任何 KEY=VALUE,无事可做。" "⚠ backfill_runtime_env: no KEY=VALUE overrides given; nothing to do.")" >&2
  exit 0
fi

echo "  $(t "回填 runtime env(runtime=$RT_ID):" "Backfilling runtime env (runtime=$RT_ID):") ${OVERRIDES[*]%%=*}"

# ── 1. 轮询等 runtime 就绪(拿到配置且非过渡态 CREATING/UPDATING),再 update ──
# agentcore deploy / cdk 刚结束时 runtime 可能仍在过渡态,get 取不到配置或 update 被拒。
CUR=""
for i in $(seq 1 12); do
  CUR=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
    --agent-runtime-id "$RT_ID" --output json 2>/dev/null || echo "")
  ST=$(printf '%s' "$CUR" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')" 2>/dev/null || echo "")
  if [ -n "$CUR" ] && [ "$ST" != "CREATING" ] && [ "$ST" != "UPDATING" ] && [ -n "$ST" ]; then
    break
  fi
  [ "$i" -lt 12 ] && sleep 6
done

if [ -z "$CUR" ]; then
  echo "  $(t "⚠ 未取到 runtime 当前配置(等待超时),跳过 env 回填(不阻断);可稍后重跑。" "⚠ Could not fetch current runtime config (wait timed out); skipping env backfill (non-blocking); re-run later.")" >&2
  exit 1
fi

# ── 2. MERGE-PATCH env + 组装 update 输入 ──
# 注意:当前配置【不能】走 stdin(下面 python 从 heredoc 读程序,stdin 被占)。落到临时文件,
# python 从 argv 指定路径读,跨 shell 稳定。
SRC_JSON="${TMPDIR:-/tmp}/notiops-rt-src-$$.json"
UPD_JSON="${TMPDIR:-/tmp}/notiops-rt-upd-$$.json"
printf '%s' "$CUR" > "$SRC_JSON"
SET_IDLE="$SET_IDLE" python3 - "$SRC_JSON" "$UPD_JSON" "${OVERRIDES[@]}" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
env = dict(d.get("environmentVariables") or {})   # 保留所有既有 key(MEMORY_* 等)
for kv in sys.argv[3:]:                            # 只覆盖显式传入的 key(merge-patch)
    k, _, v = kv.partition("=")
    if k:
        env[k] = v
out = {
    "agentRuntimeId": d["agentRuntimeId"],
    "agentRuntimeArtifact": d["agentRuntimeArtifact"],
    "roleArn": d["roleArn"],
    "networkConfiguration": d["networkConfiguration"],
    "environmentVariables": env,
    "metadataConfiguration": d.get("metadataConfiguration", {}),
}
# idle:默认 3600;SET_IDLE 置空 = 保留当前(不改),避免误动调用方不关心的生命周期。
idle = os.environ.get("SET_IDLE", "3600")
cur_life = d.get("lifecycleConfiguration", {}) or {}
if idle != "":
    out["lifecycleConfiguration"] = {
        "idleRuntimeSessionTimeout": int(idle),
        "maxLifetime": cur_life.get("maxLifetime", 28800),
    }
elif cur_life:
    out["lifecycleConfiguration"] = cur_life
json.dump(out, open(dst, "w"))
PY

# ── 3. update(重试:可能又进 UPDATING)──
OK=false
for j in 1 2 3; do
  if aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \
       --cli-input-json "file://$UPD_JSON" >/dev/null 2>&1; then
    OK=true; break
  fi
  [ "$j" -lt 3 ] && sleep 8
done
rm -f "$SRC_JSON" "$UPD_JSON"
if [ "$OK" != true ]; then
  echo "  $(t "⚠ env 回填失败(不阻断);可稍后手动 update-agent-runtime。" "⚠ env backfill failed (non-blocking); run update-agent-runtime manually later.")" >&2
  exit 1
fi

# ── 4. 核验:等 READY 后,传入的 key 里不得残留 __占位符__ ──
VCUR=""
for j in 1 2 3 4 5; do
  VCUR=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
    --agent-runtime-id "$RT_ID" --output json 2>/dev/null || echo "")
  VST=$(printf '%s' "$VCUR" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')" 2>/dev/null || echo "")
  [ "$VST" = "READY" ] && break
  sleep 6
done
if [ -n "$VCUR" ]; then
  LEFT=$(printf '%s' "$VCUR" | python3 -c "import sys,json
d=json.load(sys.stdin); env=d.get('environmentVariables') or {}
bad=[k for k,v in env.items() if isinstance(v,str) and v.startswith('__') and v.endswith('__')]
print(','.join(sorted(bad)))" 2>/dev/null || echo "")
  if [ -n "$LEFT" ]; then
    echo "  $(t "⚠ 核验:runtime env 仍有占位符未替换 → ${LEFT}。" "⚠ Check: runtime env still has unreplaced placeholders → $LEFT.")" >&2
  else
    echo "  $(t "✓ env 回填完成,无残留占位符" "✓ env backfilled; no leftover placeholders")"
  fi
fi
exit 0
