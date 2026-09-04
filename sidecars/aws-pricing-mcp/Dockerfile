# Wrapper around awslabs.aws-pricing-mcp-server that forces FastMCP into
# streamable-http transport on a localhost port. The upstream container
# (`public.ecr.aws/awslabs-mcp/awslabs/aws-pricing-mcp-server:latest`)
# entrypoint hard-codes `mcp.run()` with no args; FastMCP's settings
# loader is supposed to honor FASTMCP_TRANSPORT env, but in practice the
# banner stays on STDIO when the upstream image runs in ECS — so we
# replace the entrypoint with one that passes transport explicitly.
# Base image from ECR Public (AWS-hosted mirror of the official Docker library
# python image) rather than Docker Hub, per BuilderHub container security guidance.
FROM public.ecr.aws/docker/library/python:3.14-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTMCP_LOG_LEVEL=ERROR \
    FASTMCP_HOST=127.0.0.1 \
    FASTMCP_PORT=8001

WORKDIR /app

RUN pip install --no-cache-dir \
        "awslabs.aws-pricing-mcp-server>=1.0.0" \
        "fastmcp>=2.14.0"

COPY entrypoint.py /app/entrypoint.py

EXPOSE 8001
ENTRYPOINT ["python", "/app/entrypoint.py"]
