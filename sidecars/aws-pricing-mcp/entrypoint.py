"""Force-streamable-http entrypoint for the awslabs aws-pricing-mcp-server.

The upstream `awslabs.aws_pricing_mcp_server.server.main()` calls
`mcp.run()` with no transport argument. The `mcp` instance here is
`mcp.server.fastmcp.FastMCP` (the MCP SDK's bundled FastMCP, NOT the
standalone `fastmcp` package), so the only way to pass host/port is
via `mcp.settings.host` / `mcp.settings.port`.
"""
import logging
import os

from awslabs.aws_pricing_mcp_server.server import mcp

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

mcp.settings.host = os.environ.get("FASTMCP_HOST", "127.0.0.1")
mcp.settings.port = int(os.environ.get("FASTMCP_PORT", "8001"))

log.info(
    "aws-pricing-mcp wrapper: starting streamable-http on %s:%d",
    mcp.settings.host,
    mcp.settings.port,
)
mcp.run(transport="streamable-http")
