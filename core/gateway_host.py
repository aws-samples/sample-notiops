"""OpenAI 兼容网关地址的主机检查 —— 三层 SSRF 拦截共用的唯一一份名单（待办 #3，2026-10-23）。

网关地址由 Admin 填写、存在 Secrets Manager `notiops/litellm-config`，有三处会照着它出网：

  · BFF（`bff/web-chat/llm_config.mjs`）：保存时验证、列模型、连通性测试；
  · 对话侧（IM 的 `core/llm_config.py` 与 webchat runtime 的那份对等实现）：每轮对话；
  · 后端任务（`shared/llm_provider.py`）：PHD 翻译 / 报告精简。

以前三处各写各的名单，彼此对不上：BFF 不拦 `*.internal` / `*.local` 与文档网段
（203.0.113.0/24 等），对话侧不拦组播、也不拦 `*.internal`，后端任务另有一份 `.internal` /
`.local` 规则；同一个地址可能「管理页能存、对话侧拒绝」，或反过来。现在三处都只看这里：

  · `BLOCKED_NETWORKS`：不许连的网段，**显式列出**而不是靠 `ipaddress.is_global` ——
    is_global 的判定随 Python 小版本变（3.12.4 / 3.13 改过名单），而 runtime 是 3.13、Lambda 是
    3.14、BFF 是 Node；显式名单才能让三处逐条一致。名单是「宁可多拦」：私网 / 回环 / 链路本地 /
    CGNAT / 文档 / 基准测试 / 保留 / 组播，以及 NAT64、废弃的 IPv4 兼容与站点本地。正经的公网网关
    不会落在这些段里。
  · IPv4 映射的 IPv6（`::ffff:a.b.c.d`）按里面那个 IPv4 判。
  · 主机名：`localhost` / `*.localhost` / `*.internal` / `*.local` 一律不收；全是数字 / 点 / `0x`
    的写法（`2130706433`、`0x7f.1`、`0177.0.0.1`）只收标准的点分四段 —— 别的写法 getaddrinfo 与
    WHATWG URL 都会悄悄换算成别的地址。

⚠️ 本文件在三个部署单元里各有一份**逐字节相同**的副本（没有共享库可用）：
   `shared/gateway_host.py`（后端任务 Lambda）、`core/gateway_host.py`（IM）、
   `agent-build/NotiOpsWebChat/app/NotiOpsWebChat/core/gateway_host.py`（webchat runtime）；
   BFF 的 `bff/web-chat/gateway_host.mjs` 是同一份名单的 JS 版。改一处要四处一起改 ——
   `tests/test_gateway_host.py` 钉着副本逐字节相同、JS 名单逐条一致，并用同一张用例表
   （`tests/fixtures/gateway_host_cases.json`，BFF 的单测也读它）跑每一份实现。

零依赖（只用标准库），不做任何网络 IO：DNS 解析由调用方做，这里只判地址。
"""
from __future__ import annotations

import ipaddress
import re

#: 不许连的网段（IPv4 在前、IPv6 在后）。与 `bff/web-chat/gateway_host.mjs::BLOCKED_NETWORKS` 逐条一致。
BLOCKED_NETWORKS: tuple[str, ...] = (
    "0.0.0.0/8",          # 「本网络」/ 未指定
    "10.0.0.0/8",         # 私网
    "100.64.0.0/10",      # CGNAT 共享地址
    "127.0.0.0/8",        # 回环
    "169.254.0.0/16",     # 链路本地（含实例元数据 169.254.169.254）
    "172.16.0.0/12",      # 私网
    "192.0.0.0/24",       # IETF 协议分配
    "192.0.2.0/24",       # 文档 TEST-NET-1
    "192.168.0.0/16",     # 私网
    "198.18.0.0/15",      # 基准测试
    "198.51.100.0/24",    # 文档 TEST-NET-2
    "203.0.113.0/24",     # 文档 TEST-NET-3
    "224.0.0.0/4",        # 组播
    "240.0.0.0/4",        # 保留（含广播 255.255.255.255）
    "::/96",              # 未指定 / 回环 / 废弃的 IPv4 兼容地址
    "64:ff9b::/96",       # NAT64 —— 后缀可以是任意内网 IPv4
    "64:ff9b:1::/48",     # 本地 NAT64
    "100::/64",           # 丢弃前缀
    "2001::/23",          # IETF 协议分配（含 Teredo、基准测试、ORCHID）
    "2001:db8::/32",      # 文档
    "3fff::/20",          # 文档（RFC 9637）
    "5f00::/16",          # SRv6 SID
    "fc00::/7",           # 唯一本地（ULA）
    "fe80::/10",          # 链路本地
    "fec0::/10",          # 站点本地（已废弃）
    "ff00::/8",           # 组播
)

#: 不许用的主机名后缀（外加恰好等于 `localhost`）。与 JS 版 `BLOCKED_NAME_SUFFIXES` 一致。
BLOCKED_NAME_SUFFIXES: tuple[str, ...] = (".localhost", ".internal", ".local")

_NETS = tuple(ipaddress.ip_network(n) for n in BLOCKED_NETWORKS)
# inet_aton 那几种写法：十进制 / 八进制 / 十六进制、一到四段。
_NUMERIC_HOST_RE = re.compile(r"(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}")
# IDNA 认作点号的几个字符（全角句点、表意句号、半角表意句号）：`gw．local` 解析时就是 `gw.local`。
_DOT_LIKE = str.maketrans({"。": ".", "．": ".", "｡": "."})


def parse_ip(text):
    """字面量 IP → `ipaddress` 对象；不是 IP 返回 None。容忍方括号与末尾的点（`[::1]`、`127.0.0.1.`）。"""
    s = str(text or "").strip().strip("[]").rstrip(".")
    if not s:
        return None
    try:
        return ipaddress.ip_address(s)
    except ValueError:
        return None


def is_blocked_address(addr) -> bool:
    """地址落在 `BLOCKED_NETWORKS` 里（IPv4 映射的 IPv6 按里面那个 IPv4 判）。

    `addr` 可以是字符串或 `ipaddress` 对象；不是合法 IP 的一律当拦（调用方只会拿解析结果来问）。
    """
    ip = addr if isinstance(addr, (ipaddress.IPv4Address, ipaddress.IPv6Address)) else parse_ip(addr)
    if ip is None:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return any(ip.version == n.version and ip in n for n in _NETS)


def host_problem(host) -> str:
    """URL 里的主机（解析 DNS **之前**）有什么问题；没问题返回 ""。

    返回值是固定的枚举词（`empty` / `localhost` / `internal_name` / `non_public_ip` /
    `numeric_host`），只用于判断与日志，不回显给用户。
    """
    h = str(host or "").strip().strip("[]").lower().translate(_DOT_LIKE).rstrip(".")
    if not h:
        return "empty"
    if h == "localhost" or h.endswith(".localhost"):
        return "localhost"
    if h.endswith(BLOCKED_NAME_SUFFIXES):
        return "internal_name"
    ip = parse_ip(h)
    if ip is not None:
        return "non_public_ip" if is_blocked_address(ip) else ""
    if _NUMERIC_HOST_RE.fullmatch(h):
        return "numeric_host"
    return ""


__all__ = ["BLOCKED_NETWORKS", "BLOCKED_NAME_SUFFIXES", "parse_ip", "is_blocked_address", "host_problem"]
