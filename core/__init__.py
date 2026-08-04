"""
Platform-agnostic business logic shared by all chat-platform bots
(Feishu / Slack) and the report-handler Lambda.

Modules here MUST NOT import any platform SDK (lark_oapi, slack_sdk).
They only depend on boto3 and the standard library.

Layout:
  bedrock_intent.py    - LLM intent summarization + missing-info hints
  case_classifier.py   - LLM AWS Support service/category classifier
  webhook_dispatch.py  - HMAC-signed dispatch to DevOps Agent
  ddb_state.py         - Conversation state (event/incident/task/support keys)
  support_logic.py     - AWS Support case create flow (no UI)
"""
