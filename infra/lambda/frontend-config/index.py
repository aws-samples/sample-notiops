"""
CDK Custom Resource: 将后端配置写入 S3 前端 Bucket。
前端在运行时加载 /config.json 获取 API URL 和 Cognito 配置。
"""
import os
import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")


def handler(event, context):
    """CloudFormation Custom Resource handler."""
    request_type = event.get("RequestType", "Create")
    logger.info(f"Frontend config: {request_type}")

    if request_type == "Delete":
        return {"PhysicalResourceId": "frontend-config"}

    bucket = os.environ["BUCKET_NAME"]
    config = {
        "apiBase": os.environ["API_BASE"],
        "cognitoUserPoolId": os.environ["COGNITO_USER_POOL_ID"],
        "cognitoClientId": os.environ["COGNITO_CLIENT_ID"],
    }

    s3.put_object(
        Bucket=bucket,
        Key="config.json",
        Body=json.dumps(config),
        ContentType="application/json",
        CacheControl="no-cache, no-store, must-revalidate",
    )

    logger.info(f"Config written to s3://{bucket}/config.json")
    return {"PhysicalResourceId": "frontend-config"}
