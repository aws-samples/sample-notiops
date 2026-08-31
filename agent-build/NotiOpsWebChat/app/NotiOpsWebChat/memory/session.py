import contextvars
import logging
import os
import uuid
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

logger = logging.getLogger(__name__)

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
        content = None
        before = 0
        try:
            messages = event.agent.messages
            if messages and messages[-1].get("role") == "user":
                content = messages[-1].get("content") or []
                before = len(content)
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
            # Say out loud whether this turn actually got any long-term memory.
            # The base class logs only the non-empty case, which is why a
            # relevance floor that rejected everything went unnoticed for two
            # releases: no error, no warning, no line at all. One line per turn
            # is a cheap price for never debugging that blind again.
            if block is not None:
                injected = len(content) - before
                logger.info("long-term memory injected into this turn: %d block(s)", injected)


def get_memory_session_manager(session_id: Optional[str], actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        return None

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex

    # relevance_score=0.0 on purpose: top_k is the only bound.
    #
    # It is spelled out rather than omitted because the SDK's default is 0.2, not
    # "off" — leaving it out would leave an implicit floor that a future SDK bump
    # could raise under us. The base class skips the filter entirely when this is
    # falsy, so 0.0 means "off" no matter what the SDK defaults to.
    #
    # We used to pass relevance_score=0.5, which made long-term memory retrieve
    # nothing, ever — silently. Measured in us-east-1 against a real deployment's
    # own records, the service's similarity scores land far below that: a stored
    # preference scored 0.72 against a near-verbatim restatement
    # of itself, 0.41–0.49 against the natural question "what response format do I
    # prefer?", and 0.33–0.39 against unrelated questions. A 0.5 floor rejects every
    # one of those; the base class then injects nothing and logs nothing.
    #
    # Tuning the number down would not fix the design error. A stable preference like
    # "always answer briefly" has to apply to "how do I cut my EC2 bill?" — a question
    # with no semantic overlap with the preference text at all. The band that separates
    # relevant (0.41–0.49) from irrelevant (0.33–0.39) is ~0.02 wide at the boundary,
    # so any threshold that filters noise also filters exactly the case this feature
    # exists for. top_k already caps what a turn can pull in (3+3+5+3 short items),
    # and the service ranks by score, so the top few are the best available context.
    retrieval_config = {
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.0),
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.0),
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.0),
        f"/summaries/{actor_id}/{session_id}": RetrievalConfig(top_k=3, relevance_score=0.0),
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
