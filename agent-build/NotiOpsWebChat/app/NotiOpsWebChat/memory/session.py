"""AgentCore Memory session manager — **会话内**恢复，不做跨会话记忆。

── 现在保留什么、去掉什么（2026-09-01 产品决策）─────────────────────────────────
保留：**按 `sessionId` 持久化原始消息**。这不是"记忆功能"，而是这套架构的必需件 ——
BFF 每轮只发单轮 `prompt` + `runtimeSessionId`（`bff/web-chat/agentcore.mjs`），**客户端
不回放历史**；而 runtime 侧的 `Agent` 是进程内缓存的，缓存键里带 `model_key`/`topic`/
`account_id`/`devops_deep`，所以换模型、换主题、容器冷启动都会重建 `Agent`。少了这一层，
用户在同一个会话里换个模型再追问一句，上文就没了。对应的 SDK 调用是 `create_event` /
`list_events`（`initialize` 时按 session 拉回来），与下面说的抽取完全是两条路。

去掉：**跨会话的记忆抽取与检索**。原先 Memory 上挂了四个 strategy
（SEMANTIC `/users/{actorId}/facts`、USER_PREFERENCE `/users/{actorId}/preferences`、
SUMMARIZATION、EPISODIC），这里再配一份 `retrieval_config` 每轮去检索。现在不配
`retrieval_config` —— SDK 的 `retrieve_customer_context()` 在它为空时**直接 return**，
一次检索都不发（见 `session_manager.py` 的 `if not self.config.retrieval_config`）。
Memory 资源本身的 strategy 也一并删了（`agentcore/agentcore.json` 与
`infra/lib/notiops-webchat-standalone-stack.ts` 两条部署路径同时改）。

── 两条不要重新踩的教训（真要恢复跨会话记忆时先读这段）───────────────────────
1. **检索查询不能用"最后一条 user 消息"。** SDK 基类就是这么取的，而到
   `stream_async()` 那一刻这条消息已经是拼装完的大 prompt（账号隔离规则 + 主题指令 +
   skill 正文 + 强制联网结果 + 语言锁），动辄几十 KB。服务端对 `searchQuery` 超过
   10000 字符报 `ValidationException`，**SDK 把这个异常吞掉、返回空列表** —— 于是每个
   namespace 永远检索不到东西，还每轮白付四次往返。当时的解法是子类
   `_NotiOpsMemorySessionManager`：临时把这个 content block 换成用户原话、调完再换回去。
2. **`relevance_score` 不能设门槛。** 实测（us-east-1，拿真实部署自己的记录）：一条已存
   偏好对"几乎逐字重述"打 0.72，对自然问法「我偏好什么回答格式？」只打 0.41–0.49，
   对无关问题 0.33–0.39。0.5 的门槛把该命中的全滤掉，而基类既不注入也不记日志。把数字
   调低也不解决设计问题：「回答简短点」这条偏好本来就要作用在「怎么降 EC2 成本」上，
   两者语义零重叠，而相关(0.41–0.49)与无关(0.33–0.39)在边界只差 ~0.02。所以当时是
   `relevance_score=0.0` + 靠 `top_k` 收口，并且**显式写出来**（SDK 默认是 0.2，不写等于
   留一个会被 SDK 升级悄悄抬高的隐式门槛）。
"""
import logging
import os
import uuid
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

logger = logging.getLogger(__name__)

MEMORY_ID = os.getenv("MEMORY_NOTIOPSWEBCHATMEMORY_ID")
REGION = os.getenv("AWS_REGION")


def get_memory_session_manager(session_id: Optional[str], actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    """按 `session_id` 持久化 / 恢复本会话消息；**不检索**跨会话记忆。

    `MEMORY_ID` 为空时返回 `None`（调用方据此退化成纯进程内会话）。⚠️ 这条退化路径是
    **静默**的 —— 环境变量键名对不上就等于会话历史整块不落库，没有报错也没有日志，
    所以 `MEMORY_NOTIOPSWEBCHATMEMORY_ID` 这个键名在 CDK 与这里必须逐字一致
    （见 `notiops-webchat-standalone-stack.ts` 的注释与 `test_oneclick_parity.py` 维度 ⑦）。
    """
    if not MEMORY_ID:
        return None

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex

    # 不传 retrieval_config = 不做任何跨会话检索（顶部说明）。别"顺手补上默认值"：
    # 传空字典与不传等价，传了内容就是把跨会话记忆重新打开。
    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
        ),
        REGION
    )
