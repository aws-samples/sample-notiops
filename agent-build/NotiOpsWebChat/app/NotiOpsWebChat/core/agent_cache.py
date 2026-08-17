"""Agent 实例缓存的键与 LRU 逐出 —— 从 main.py 抽出来，为了能被真正测到。

为什么单独成模块：这段逻辑此前内联在 `main.py::agent_factory()` 的闭包里，而 main.py
导入需要 strands / bedrock_agentcore 等一整套重依赖，于是
`scripts/test_webchat_agent_cache.py` 只能**手抄一份**实现来测。副本随后就漂移了 ——
真代码用 `_is_cross_account(account_id)` 决定账号键，副本写的是 `if not account_id`，
也就是说"测过了"的其实是另一段代码。抽出来之后测试直接压真实现，副本删除。

两件事在这里：
  · `build_key()`  —— 什么变了就必须换实例
  · `admit()`      —— OrderedDict 上的 LRU：命中刷新、新建后逐出、**保留刚建的那条**
"""
from __future__ import annotations

import os
from collections import OrderedDict
from typing import Callable

# 缓存上限（spec R4.3）。原为无上限 dict —— 键里加入 generation 后，每次 Admin 改配置都
# 会产生一整代新键，而旧实例各自持有 messages + ~40 个工具绑定 + Memory session manager，
# 永不释放；被污染的 generation 更能把它撑爆 microVM。
AGENT_CACHE_MAX = int(os.environ.get("NOTIOPS_AGENT_CACHE_MAX", "64"))


def build_key(*, generation, session_id, user_id, model_key=None, topic=None,
              cross_account: bool = False, account_id=None,
              devops_deep: bool = False, cred_epoch: int = 0) -> str:
    """Agent 实例的缓存键。**任何会改变实例内部构造的输入都必须在里面。**

    各维度的理由：
      · generation —— 配置变更（模型目录 / 默认模型 / 凭证）后必须重建，否则长驻 microVM
        里的旧 Agent 会一直用旧配置。只把 provider/model 入键不够：「内容变了但名字没变」
        （Key 轮换、model_id 重映射）同样需要重建（spec D2）。
      · cred_epoch —— 凭证被拒（Key 被吊销 / 轮换）后必须重建，而这件事**不会**体现在
        generation 上：generation 只在有人经 Admin 页保存时才变，直接改 Secret / 删 IAM
        user / 自动轮换都不经过它。而 botocore 在构造 client 时就把 bearer token 冻结，
        清掉 Key 缓存对已建好的 client 毫无作用 —— 那个 client 会一直用旧 token，每轮
        401，直到 microVM 回收（idle 15min / 上限 8h）。IM 侧靠 `lazy_boto.reset_all()`
        解决；webchat 靠这一维。值来自 `llm_config.credential_epoch()`，由调用方传入
        （同 cross_account：本模块不反向依赖上层）。
      · model_key / topic / account / devops_deep —— 切任一项都要换工具集：跨账号要换成
        账号安全的 boto3 兜底；深度调查开启时只挂 devops 工具、强制走 DevOps Agent。

    `cross_account` 由调用方判定后传入（main.py 的 `_is_cross_account`），本模块不重复
    实现那套判断 —— 但**归一化写在这里**，免得调用方各自拼出不同的账号键。
    """
    acct = "self" if not cross_account else str(account_id or "").strip()
    return (f"{generation}/{session_id}/{user_id}/{model_key or 'default'}/"
            f"{topic or 'general'}/{acct}/{'dd1' if devops_deep else 'dd0'}/"
            f"ce{int(cred_epoch or 0)}")


def admit(cache: "OrderedDict[str, object]", key: str,
          build: Callable[[], object],
          max_size: int = None) -> tuple[object, list[str]]:
    """LRU get-or-create。返回 (实例, 被逐出的键列表)。

    逐出**只在新建之后**做，且必须保留刚建的那条 —— 它马上要被返回，逐掉它等于每次
    调用都重建一个新 Agent（在上限被打满时这会退化成"缓存完全失效但仍付构造代价"）。
    """
    limit = AGENT_CACHE_MAX if max_size is None else max_size
    if key in cache:
        cache.move_to_end(key)       # LRU: 命中即刷新
        return cache[key], []
    cache[key] = build()
    evicted: list[str] = []
    while len(cache) > limit:
        old, _ = cache.popitem(last=False)
        evicted.append(old)
    return cache[key], evicted


__all__ = ["AGENT_CACHE_MAX", "build_key", "admit"]
