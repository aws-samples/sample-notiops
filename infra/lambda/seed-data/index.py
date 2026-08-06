"""
CDK Custom Resource: 首次部署时写入默认阈值、v3 巡检 prompt、模型 ID。
所有写入幂等(attribute_not_exists) — 不覆盖用户已修改的值。
"""
import boto3
import json
import logging
import os
import urllib.request
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def send_cfn(event, context, status, data=None):
    body = json.dumps({
        "Status": status,
        "Reason": str((data or {}).get("Error", "OK")),
        "PhysicalResourceId": context.log_stream_name,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": data or {},
    }).encode()
    req = urllib.request.Request(
        event["ResponseURL"], data=body,
        headers={"Content-Type": ""}, method="PUT",
    )
    if not (req.full_url if hasattr(req, "full_url") else str(req)).lower().startswith(("https://","http://")):
        raise ValueError("refusing non-http(s) URL")  # B310 mitigation
    urllib.request.urlopen(req)  # nosec B310 - scheme validated above


def _put_if_absent(table, item):
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(PK)",
        )
        return True
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return False


# 注:预置 skill 的 seed 已【统一】由 BFF 运行时 seedPresetSkills()(bff/web-chat/skills.mjs)负责——
# 它随代码打包 bff/web-chat/preset-skills/ 下全部官方 skill,首次访问幂等注入,author=notiops-system。
# 此 Lambda 曾另有一套 _seed_skills() 写 S3,但只覆盖少数 skill 且把 author 误写为 "NotiOps",
# 导致前端按 author 判定时把官方 skill 当成「客户自建」。为消除双写分叉,这里【不再】seed skill,
# 只保留 DynamoDB 配置(阈值 / prompt / 模型)的幂等写入。


def handler(event, context):
    if event["RequestType"] == "Delete":
        send_cfn(event, context, "SUCCESS")
        return

    try:
        table = boto3.resource("dynamodb").Table(os.environ["CONFIG_TABLE"])

        seed_path = os.path.join(os.path.dirname(__file__), "seed-data.json")
        with open(seed_path, "r", encoding="utf-8") as f:
            seed = json.loads(f.read(), parse_float=Decimal)

        seeded = 0

        # Thresholds
        for rt, thresholds in seed["thresholds"].items():
            if _put_if_absent(table, {
                "PK": f"threshold#{rt}",
                "SK": "meta",
                "resource_type": rt,
                "thresholds": thresholds,
                "description": f"{rt} default thresholds",
            }):
                seeded += 1

        # Config (appconfig# key-value pairs)
        for namespace, entries in seed["config"].items():
            for config_key, config_value in entries.items():
                if _put_if_absent(table, {
                    "PK": f"appconfig#{namespace}",
                    "SK": config_key,
                    "config_value": config_value,
                    "updated_at": "2026-01-01T00:00:00Z",
                }):
                    seeded += 1

        # 预置 skill 不在此 seed(改由 BFF 运行时 seedPresetSkills 统一负责,见上方注释)。
        logger.info("Seed data: %d config items written (others already existed)", seeded)
        send_cfn(event, context, "SUCCESS", {"Seeded": str(seeded)})

    except Exception as e:
        logger.error("Seed data failed: %s", e)
        send_cfn(event, context, "FAILED", {"Error": str(e)})
