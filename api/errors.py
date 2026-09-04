"""API 层的领域异常。

## 为什么不继续用裸 `KeyError` / `ValueError`

`api/handler.py` 原来按**异常类型**映射 HTTP 状态码：

```
ValueError → 400 ValidationError
KeyError   → 404 NotFound
其余        → 500 + logger.error(traceback)
```

前两条同时承担两个互不相干的角色：

```
路由主动抛的领域错误            26 处 raise KeyError(f"… not found")   → 404 对
路由内部字典取键失败（真 bug）   payload["threshold"] 字段改名了        → 404 **错**
```

后者返回给前端的是 `404 {"error":"NotFound","message":"'threshold'"}` ——
读成「这个资源不存在」，而真相是后端字段缺失。更糟的是这两类**都不进日志**
（只有 `except Exception` 那条记 traceback），也就是最需要追溯的两类
在 CloudWatch 里什么都没有。

改法：领域错误用这里的显式异常，裸 `KeyError` 归 500 并记 traceback。
"""

from __future__ import annotations


class ApiError(Exception):
    """带 HTTP 状态码的领域错误。"""

    status = 500
    code = "InternalError"


class NotFoundError(ApiError):
    """请求的资源不存在。→ 404。

    ⚠️ 只用于「客户问的那个东西确实没有」。后端自己的字段缺失是 bug，
    要让它以 500 + traceback 冒出来 —— 报成 404 会让客户以为是自己传错了 id。
    """

    status = 404
    code = "NotFound"


class ValidationError(ApiError):
    """入参不合法。→ 400。"""

    status = 400
    code = "ValidationError"
