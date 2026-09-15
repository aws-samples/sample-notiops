"""阿里云凭据读取（IM 侧）—— `bff/web-chat/aliyun_config.mjs` **读那一半**的语义移植。

只搬 `loadAliyunCredentials()`。**写那一半刻意不移植**：配置只在 Admin「多云」页写
（那是 BFF 的 `apiPutAliyunConfig`），IM 侧一行都不写。在这里再实现一遍校验/合并，等于
让同一个 secret 有两个写入者、两套校验 —— 而这一页最贵的 bug 恰好是「界面骗人」
（客户以为存好了、实际发不出请求）。少一个写入者就少一种骗法。

与 JS 那份的三处**故意**不同：
  1. 没有 `apiGetAliyunConfig` / `mask` / `mergeIfMasked` —— 见上，IM 不读写表单。
  2. 没有 `__setClients` 测试接缝；Python 侧测试直接 `patch.object(aliyun_config, "_sm")`
     （本仓库既有做法，见 `tests/test_im_notiops_agent_chat.py`）。
  3. `STAROPS_REGIONS` 在 JS 里定义在本文件（为了给保存表单做校验，且避免和
     starops_chat.mjs 循环依赖）。Python 侧**同样放这里**，理由只剩后半条：
     `core/starops_chat.py` import 本模块读凭据，反过来 import 就是循环。

⚠️ 两个 region 字段是**两件事**，混用会得到一个语义不明的 404：
  · `region_id`      = 要**被巡检**的地域（客户资源在哪，如 cn-hangzhou）→ 走 variables.region
  · `starops_region` = STAROps **接口**在哪（数字员工资源所在地）→ 拼进 endpoint 主机名

🔒 凭据处置口径（docs/LOGGING_STANDARD.md）：`access_key_secret` **绝不进日志、绝不进任何
文件、连长度都不记**；`starops_workspace` 的值里嵌着阿里云账号 UID（见多云证据文档 §9），
**绝不进日志**。失败只记异常**类型名**（`_safe_err`）。

ARCC 未查询（MCP server 本次会话连不上）—— 本模块按标准做法处理凭据：只读、不回显、
不记日志、按资源收窄的单个 secret。
"""
from __future__ import annotations

import json
import logging
import os
import re

from core.lazy_boto import LazyClient

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """只回异常**类型名**（botocore 再带上错误码），绝不回原始 message / 响应体。"""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


#: secret 名。⚠️ `ALIYUN_SECRET_NAME` 这个 env **今天没有任何部署路径注入**（与
#: aliyun_config.mjs:52 逐字同构，那边的注释是权威说明）。改名要同时改五处：本行、
#: `bff/web-chat/aliyun_config.mjs`、`infra/lib/constructs/web-chat-core.ts` 的授权清单、
#: `infra/lib/notiops-webchat-standalone-stack.ts` 的两份方式A清单、`teardown.sh`。
#: 2026-09-14 起还多一处：`infra/lib/constructs/im-core.ts`（IM 三个平台的读权限）。
SECRET_ID = os.environ.get("ALIYUN_SECRET_NAME") or "notiops/aliyun-credentials"

# import 期不建客户端：IM ingress 有 10s INIT 上限，且 CI 里 py_compile 扫全仓库时
# 不该需要可解析的 region（同 core/lazy_boto 文件头第 2 条）。
_sm = LazyClient("secretsmanager")

#: region id 的形状 —— 这是一道 SSRF 闸门，不是格式美化（它会被拼进 endpoint 主机名）。
_REGION_RE = re.compile(r"^[a-z0-9-]{4,32}$")
#: 客户没选地域时的默认值。
_DEFAULT_REGION = "cn-hangzhou"

#: STAROps 的**接口**地域允许清单。官方元数据里 endpoints 一共就这两条。
#: 能穷举就穷举（比 `_REGION_RE` 严）：地域会被拼进 endpoint 主机名，而请求是 IM worker 的
#: 执行角色发出去的 —— 这是允许清单式的 SSRF 闸门。将来阿里云新增地域时加一条即可。
STAROPS_REGIONS: tuple[str, ...] = ("cn-beijing", "ap-southeast-1")
DEFAULT_STAROPS_REGION = "cn-beijing"


def _read_secret() -> dict | None:
    """读 secret JSON。不存在 → `None`（= 还没配，是**正常状态**，方式A 从不预建它）。"""
    try:
        raw = _sm.get_secret_value(SecretId=SECRET_ID).get("SecretString") or "{}"
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception as e:  # noqa: BLE001 — 含 ResourceNotFoundException（未配置）
        name = type(e).__name__
        code = ""
        resp = getattr(e, "response", None)
        if isinstance(resp, dict):
            code = (resp.get("Error", {}) or {}).get("Code") or ""
        if code == "ResourceNotFoundException" or name == "ResourceNotFoundException":
            return None
        logger.warning("aliyun_config: read secret failed (%s)", _safe_err(e))
        return None


def load_aliyun_credentials() -> dict | None:
    """拿到**未脱敏**的凭据。没配好 → `None`。

    单独一个函数而不是让调用方自己读 secret：这样"谁读了明文"在 `git grep` 里是一个
    可数的清单。调用方拿到 `None` 必须**当场失败并告诉用户去配**，不许回落到"跳过阿里云
    那部分继续答"（那是静默降级）。

    这里**只搬运 STAROps 子配置、不判空**：缺员工 ID 时要由 `core/starops_chat.py` 的
    `load_starops_config()` 报出"缺哪一项"。在这里一起 `return None` 会让"没填 AK"和
    "没填数字员工 ID"变成同一句话 —— 客户会去重填已经填好的 AK。
    """
    d = _read_secret() or {}
    ak_id = str(d.get("access_key_id") or "").strip()
    ak_secret = str(d.get("access_key_secret") or "").strip()
    if not ak_id or not ak_secret:
        return None
    raw_region = str(d.get("region_id") or "")
    region = raw_region if _REGION_RE.match(raw_region) else _DEFAULT_REGION
    so_region = str(d.get("starops_region") or "")
    return {
        "accessKeyId": ak_id,
        "accessKeySecret": ak_secret,
        "regionId": region,
        "staropsEmployee": str(d.get("starops_employee") or "").strip(),
        "staropsRegion": so_region if so_region in STAROPS_REGIONS else DEFAULT_STAROPS_REGION,
        "staropsWorkspace": str(d.get("starops_workspace") or "").strip(),
        "staropsProject": str(d.get("starops_project") or "").strip(),
    }


__all__ = [
    "DEFAULT_STAROPS_REGION",
    "SECRET_ID",
    "STAROPS_REGIONS",
    "load_aliyun_credentials",
]
