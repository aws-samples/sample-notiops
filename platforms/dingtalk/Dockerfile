# Build context MUST be the repository root so the shared `core/`
# package can be COPYed into the image alongside the DingTalk adapter:
#
#   docker build -f platforms/dingtalk/Dockerfile -t notiops-dingtalk:latest .
#
# In production this image is built by CDK as part of `cdk deploy --all`
# (see infra/lib/bot-stack.ts → ContainerImage.fromAsset). The setup.sh
# wrapper handles the full flow.

FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY platforms/dingtalk/requirements.txt .
RUN pip install --no-cache-dir --retries 10 --timeout 60 -r requirements.txt

# Shared platform-agnostic business logic. Mirror feishu/slack image.
COPY core ./core
COPY shared ./shared

# DingTalk-specific adapter.
COPY platforms/dingtalk/app/*.py ./

# Stream Mode is outbound long-poll, no port to expose.
CMD ["python", "-u", "main.py"]
