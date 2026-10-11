"""Lambda 入口：MCP streamable-http (stateless, JSON) via Mangum。

lifespan 手动管理：Lambda init 阶段进入一次（StreamableHTTPSessionManager.run()
每实例只能调一次，Mangum 的 per-invoke lifespan 会二次触发导致崩溃）。
鉴权由 Function URL SigV4 完成；Host 校验关闭（AWS 分配域名）。
"""

import asyncio
import contextlib

from mangum import Mangum
from mcp.server.transport_security import TransportSecuritySettings

from cost_mcp.server import server

app = server.streamable_http_app(
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)

# 在 Lambda init 阶段启动 lifespan（router.lifespan_context 持有 session manager 的 run()）
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)
_stack = contextlib.AsyncExitStack()
_loop.run_until_complete(_stack.enter_async_context(app.router.lifespan_context(app)))

_mangum = Mangum(app, lifespan="off")


def handler(event, context):
    return _mangum(event, context)
