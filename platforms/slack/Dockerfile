# Build context MUST be the repository root so that the shared `core/`,
# `shared/`, and `platforms/` packages can be COPYed into the image
# alongside the Slack adapter:
#
#   docker build -f platforms/slack/Dockerfile -t notiops-slack:latest .
#
# In production this image is built by CDK as part of `cdk deploy --all`
# (see infra/lib/bot-stack.ts → ContainerImage.fromAsset). The setup.sh
# wrapper handles the full flow.

FROM public.ecr.aws/docker/library/python:3.14-slim

WORKDIR /app

COPY platforms/slack/requirements.txt .
RUN pip install --no-cache-dir --retries 10 --timeout 60 -r requirements.txt

# Keep full package structure so `from platforms.slack import ...`,
# `from core import ...`, `from shared.queries import ...` all resolve.
COPY core ./core
COPY shared ./shared
COPY platforms ./platforms

ENV PYTHONPATH=/app

# Socket Mode = outbound WebSocket only, no inbound port to expose.
CMD ["python", "-u", "-m", "platforms.slack.app.main"]
