# Wrapper around awslabs.billing-cost-management-mcp-server forcing
# streamable-http transport. See sidecars/aws-pricing-mcp/Dockerfile
# header comment for context — same workaround.
# Base image from ECR Public (AWS-hosted mirror of the official Docker library
# python image) rather than Docker Hub, per BuilderHub container security guidance.
FROM public.ecr.aws/docker/library/python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTMCP_LOG_LEVEL=ERROR \
    FASTMCP_HOST=127.0.0.1 \
    FASTMCP_PORT=8003

WORKDIR /app

RUN pip install --no-cache-dir \
        "awslabs.billing-cost-management-mcp-server" \
        "fastmcp>=2.14.0"

COPY entrypoint.py /app/entrypoint.py

EXPOSE 8003
ENTRYPOINT ["python", "/app/entrypoint.py"]
