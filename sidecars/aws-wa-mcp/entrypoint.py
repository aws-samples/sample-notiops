"""Force-streamable-http entrypoint for awslabs well-architected-security-mcp-server.

`mcp` here is `mcp.server.fastmcp.FastMCP` (MCP SDK's bundled FastMCP),
so host/port go through `mcp.settings`, not through `mcp.run()` kwargs.
"""
import logging
import os

from awslabs.well_architected_security_mcp_server.server import mcp

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

mcp.settings.host = os.environ.get("FASTMCP_HOST", "127.0.0.1")
mcp.settings.port = int(os.environ.get("FASTMCP_PORT", "8002"))

log.info(
    "aws-wa-mcp wrapper: starting streamable-http on %s:%d",
    mcp.settings.host,
    mcp.settings.port,
)
mcp.run(transport="streamable-http")
