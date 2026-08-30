import contextvars
import os
import uuid
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ID = os.getenv("MEMORY_NOTIOPSWEBCHATMEMORY_ID")
REGION = os.getenv("AWS_REGION")

# AgentCore Memory rejects searchCriteria.searchQuery over 10000 chars. Stay
# well under it — a retrieval query longer than a question is noise anyway.
_MAX_RETRIEVAL_QUERY = 4000

# The turn's raw user question. The entrypoint records it before invoking the
# agent; retrieve_customer_context() below reads it back. A ContextVar (not a
# module global) so concurrent turns in one container cannot cross over. Read
# in the hook's own frame, which runs synchronously in the caller's context
# (async_mode defaults to False), so no thread-propagation issue arises.
_retrieval_query: "contextvars.ContextVar[str]" = contextvars.ContextVar(
    "notiops_memory_retrieval_query", default=""
)


def set_retrieval_query(text: Optional[str]) -> None:
    """Record the turn's raw user question for memory retrieval."""
    _retrieval_query.set(str(text or ""))


def _short_query(prompt_text: str) -> str:
    q = _retrieval_query.get() or ""
    if not q:
        # No question recorded for this turn (unexpected). Degraded but safe:
        # a truncated prompt retrieves poorly, yet still beats a request the
        # service refuses outright.
        q = str(prompt_text or "")
    return q[:_MAX_RETRIEVAL_QUERY]


class _NotiOpsMemorySessionManager(AgentCoreMemorySessionManager):
    """Retrieve memories with the user's question, not the assembled prompt.

    The base class uses the last user message verbatim as the retrieval query.
    By the time a turn reaches stream_async() that message is the fully
    assembled prompt — account-isolation rules, topic directive, skill body,
    forced web-search results, language lock — routinely tens of KB. The
    service rejects a searchQuery over 10000 chars with ValidationException,
    which the SDK swallows into an empty list, so every namespace silently
    retrieved nothing: long-term memory was effectively off, and we paid four
    round trips per turn to learn that.

    Swap the short query in for the duration of the base call, then put the
    original text back so the model still sees the full prompt. The content
    block is mutated in place (same dict object), so the base class inserting
    its <user_context> block at index 0 does not disturb the restore.
    """

    def retrieve_customer_context(self, event) -> None:
        block = None
        original = None
        try:
            messages = event.agent.messages
            if messages and messages[-1].get("role") == "user":
                content = messages[-1].get("content") or []
                # Same shape check the base makes; tool-result turns carry no
                # "text" block and are skipped there too.
                if content and isinstance(content[0], dict) and "text" in content[0]:
                    block = content[0]
                    original = block["text"]
                    block["text"] = _short_query(original)
        except Exception:  # noqa: BLE001 - retrieval must never break the turn
            block = None
        try:
            return super().retrieve_customer_context(event)
        finally:
            if block is not None:
                block["text"] = original


def get_memory_session_manager(session_id: Optional[str], actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        return None

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex

    retrieval_config = {
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.5),
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.5),
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.5),
        f"/summaries/{actor_id}/{session_id}": RetrievalConfig(top_k=3, relevance_score=0.5),
    }

    return _NotiOpsMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
            retrieval_config=retrieval_config,
        ),
        REGION
    )
