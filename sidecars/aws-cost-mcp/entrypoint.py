"""Force-streamable-http entrypoint for awslabs billing-cost-management-mcp-server.

This server uses the standalone `fastmcp` package's FastMCP (not the
MCP SDK's bundled one), so `mcp.run()` accepts host/port via
`**transport_kwargs`. Cost MCP also needs an async `setup()` to
register sub-servers (cost-explorer, compute-optimizer, etc.) before
running, which we replicate here.
"""
import asyncio
import logging
import os

from awslabs.billing_cost_management_mcp_server.server import mcp, setup

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def _bootstrap() -> None:
    asyncio.run(setup())


_bootstrap()

host = os.environ.get("FASTMCP_HOST", "127.0.0.1")
port = int(os.environ.get("FASTMCP_PORT", "8003"))

log.info(
    "aws-cost-mcp wrapper: starting streamable-http on %s:%d",
    host,
    port,
)
mcp.run(transport="streamable-http", host=host, port=port)
