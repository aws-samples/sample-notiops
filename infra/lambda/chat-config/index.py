"""
CDK Custom Resource: 把 chat-app 的运行时配置写入 S3（config.json）。

与 frontend-config 不同：这里从 CustomResource 的 ResourceProperties.config
读取整段 JSON 字符串并原样写出，shape 由 CDK 决定（chatApiBase / cognito*）。
前端 src/config.ts 在运行时 fetch /config.json。
"""
import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)
s3 = boto3.client("s3")


def handler(event, context):
    request_type = event.get("RequestType", "Create")
    logger.info(f"chat-config: {request_type}")
    if request_type == "Delete":
        return {"PhysicalResourceId": "chat-config"}

    props = event.get("ResourceProperties", {})
    bucket = props["bucketName"]
    config_json = props["config"]  # 已是 JSON 字符串

    # 校验是合法 JSON（防止写出坏配置）
    json.loads(config_json)

    s3.put_object(
        Bucket=bucket,
        Key="config.json",
        Body=config_json,
        ContentType="application/json",
        CacheControl="no-cache, no-store, must-revalidate",
    )
    logger.info(f"chat config written to s3://{bucket}/config.json")
    return {"PhysicalResourceId": "chat-config"}
