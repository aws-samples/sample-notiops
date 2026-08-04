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


def _seed_skills(bucket):
    """把预制 skill 写入 SKILLS_BUCKET 的 skills/ 前缀(与 bff/web-chat/skills.mjs、
    core/skills.py 同构:skills/<id>/meta.json + skills/<id>/versions/<ver>.md)。
    幂等:只在 meta.json 不存在时写(不覆盖客户已改的 skill)。返回写入的 skill 数。"""
    if not bucket:
        logger.warning("SKILLS_BUCKET not set — skipping skill seed")
        return 0
    s3 = boto3.client("s3")
    base = os.path.join(os.path.dirname(__file__), "seed-skills")
    seeded = 0
    if not os.path.isdir(base):
        return 0
    for skill_id in sorted(os.listdir(base)):
        sdir = os.path.join(base, skill_id)
        meta_path = os.path.join(sdir, "meta.json")
        if not os.path.isfile(meta_path):
            continue
        meta_key = f"skills/{skill_id}/meta.json"
        # 幂等:meta.json 已存在则跳过(保护客户自定义)
        try:
            s3.head_object(Bucket=bucket, Key=meta_key)
            logger.info("skill %s already exists — skip", skill_id)
            continue
        except s3.exceptions.ClientError as e:
            if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey", "NotFound"):
                logger.warning("skill %s head_object error: %s", skill_id, e)
                continue
        # 写各版本正文
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.loads(f.read())
        vdir = os.path.join(sdir, "versions")
        for vfile in os.listdir(vdir):
            if not vfile.endswith(".md"):
                continue
            with open(os.path.join(vdir, vfile), "r", encoding="utf-8") as f:
                body = f.read()
            s3.put_object(
                Bucket=bucket, Key=f"skills/{skill_id}/versions/{vfile}",
                Body=body.encode("utf-8"), ContentType="text/markdown; charset=utf-8",
            )
        # 最后写 meta.json(作为"已就绪"标志,放最后避免半写)
        s3.put_object(
            Bucket=bucket, Key=meta_key,
            Body=json.dumps(meta, ensure_ascii=False).encode("utf-8"),
            ContentType="application/json",
        )
        seeded += 1
        logger.info("seeded skill: %s", skill_id)
    return seeded


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

        # 预制 skill 写入 S3(SKILLS_BUCKET,幂等)
        skills_seeded = _seed_skills(os.environ.get("SKILLS_BUCKET", ""))

        logger.info("Seed data: %d config items + %d skills written (others already existed)", seeded, skills_seeded)
        send_cfn(event, context, "SUCCESS", {"Seeded": str(seeded), "Skills": str(skills_seeded)})

    except Exception as e:
        logger.error("Seed data failed: %s", e)
        send_cfn(event, context, "FAILED", {"Error": str(e)})
