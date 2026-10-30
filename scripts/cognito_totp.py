#!/usr/bin/env python3
"""TOTP（RFC 6238）+ Cognito 两步验证挑战的应答 —— 给冒烟 / RC / QA 脚本用（2026-10-29）。

Web 登录加了两步验证（验证器 App）之后，脚本里那几处「用户名密码直接拿令牌」会碰到两种挑战：
  · MFA_SETUP          —— 用户池「强制」档、这个用户还没绑：当场绑一个（密钥只留在本进程内存里）；
  · SOFTWARE_TOKEN_MFA —— 已经绑过：要用当初那把密钥算出 6 位码。
「可选」档下登录不受影响，但「管理」页（/admin/*）要求已绑定（bff/web-chat/mfa.mjs）—— 要调管理接口的
脚本用 `ensure_enrolled()` 先用访问令牌绑上。

不加依赖：TOTP 就是 HMAC-SHA1 + 动态截断，十几行。Cognito 不收同一个 30 秒窗口里用过的码，所以连续两次
要码时 `fresh_code()` 会等到下一个窗口（最多 30 秒）。

不打印密钥和验证码。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time

STEP = 30
DIGITS = 6


def totp(secret_b32: str, at: float | None = None, step: int = STEP, digits: int = DIGITS) -> str:
    """RFC 6238（SHA1）。secret 是 Cognito 给的 Base32 串（可以不带补齐的 `=`）。"""
    s = secret_b32.strip().replace(" ", "").upper()
    key = base64.b32decode(s + "=" * (-len(s) % 8))
    counter = int((time.time() if at is None else at) // step)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def fresh_code(secret_b32: str, used: str | None = None, *, sleep=time.sleep, now=time.time) -> str:
    """一个和 `used` 不同的码：同一窗口里用过的码 Cognito 会拒，碰上就等到下一个窗口。"""
    for _ in range(STEP + 5):
        code = totp(secret_b32, at=now())
        if code != used:
            return code
        sleep(1)
    raise RuntimeError("TOTP code did not change within one time step")


class MfaState:
    """一个进程里一位用户的验证器密钥与上一次用过的码（都不落盘）。"""

    def __init__(self, secret: str | None = None):
        self.secret = secret
        self.used: str | None = None

    def code(self) -> str:
        if not self.secret:
            raise RuntimeError("no TOTP secret for this user")
        self.used = fresh_code(self.secret, self.used)
        return self.used


def answer_mfa(idp, resp: dict, *, client_id: str, username: str, state: MfaState,
               pool_id: str | None = None) -> dict:
    """把 (admin_)initiate_auth / respond_to_auth_challenge 之后剩下的两步验证挑战答完，返回 AuthenticationResult。

    `pool_id` 给了就走 admin_respond_to_auth_challenge（对应 ADMIN_USER_PASSWORD_AUTH）。

    答过 MFA_SETUP 的，拿到令牌后再用新的访问令牌把 TOTP 设成「启用 + 首选」，和登录页（Login.tsx）一样：
    登录时绑定只**登记**验证器、不启用，AdminGetUser 里看不出他绑过，「管理」页门禁就当他没绑。
    """
    def respond(**kw):
        if pool_id:
            return idp.admin_respond_to_auth_challenge(UserPoolId=pool_id, ClientId=client_id, **kw)
        return idp.respond_to_auth_challenge(ClientId=client_id, **kw)

    set_up = False
    for _ in range(4):
        name = resp.get("ChallengeName")
        if not name:
            auth = resp["AuthenticationResult"]
            if set_up:
                idp.set_user_mfa_preference(AccessToken=auth["AccessToken"],
                                            SoftwareTokenMfaSettings={"Enabled": True, "PreferredMfa": True})
            return auth
        if name == "MFA_SETUP":
            a = idp.associate_software_token(Session=resp["Session"])
            state.secret, state.used = a["SecretCode"], None
            v = idp.verify_software_token(Session=a["Session"], UserCode=state.code())
            if v.get("Status") != "SUCCESS":
                raise RuntimeError("TOTP setup was not accepted")
            resp = respond(ChallengeName="MFA_SETUP", Session=v["Session"],
                           ChallengeResponses={"USERNAME": username})
            set_up = True
        elif name == "SOFTWARE_TOKEN_MFA":
            if not state.secret:
                raise RuntimeError(
                    "sign-in asks for an authenticator code, but this script does not know the user's TOTP key "
                    "(reset the user's two-step verification first, or pass the key in)")
            resp = respond(ChallengeName="SOFTWARE_TOKEN_MFA", Session=resp["Session"],
                           ChallengeResponses={"USERNAME": username, "SOFTWARE_TOKEN_MFA_CODE": state.code()})
        else:
            raise RuntimeError(f"unexpected auth challenge: {name}")
    raise RuntimeError("too many auth challenges")


def pool_mode(idp, pool_id: str) -> str:
    """用户池的档位：OFF / OPTIONAL / REQUIRED（与 bff/web-chat/mfa.mjs::modeOf 同一口径）。"""
    r = idp.get_user_pool_mfa_config(UserPoolId=pool_id)
    if not (r.get("SoftwareTokenMfaConfiguration") or {}).get("Enabled"):
        return "OFF"
    return {"ON": "REQUIRED", "OPTIONAL": "OPTIONAL"}.get(r.get("MfaConfiguration"), "OFF")


def enrolled(idp, pool_id: str, username: str) -> bool:
    u = idp.admin_get_user(UserPoolId=pool_id, Username=username)
    return "SOFTWARE_TOKEN_MFA" in (u.get("UserMFASettingList") or [])


def ensure_enrolled(idp, pool_id: str, username: str, access_token: str, state: MfaState) -> bool:
    """用户池不是「关闭」档、而这个用户还没绑：用访问令牌当场绑上（密钥记进 state）。返回这次有没有绑。

    「管理」页门禁读的是 Cognito 里此刻的状态，所以绑完之后**手里这张令牌**就能调管理接口，不用重新登录。
    """
    if pool_mode(idp, pool_id) == "OFF" or enrolled(idp, pool_id, username):
        return False
    a = idp.associate_software_token(AccessToken=access_token)
    state.secret, state.used = a["SecretCode"], None
    v = idp.verify_software_token(AccessToken=access_token, UserCode=state.code())
    if v.get("Status") != "SUCCESS":
        raise RuntimeError("TOTP setup was not accepted")
    idp.set_user_mfa_preference(AccessToken=access_token,
                                SoftwareTokenMfaSettings={"Enabled": True, "PreferredMfa": True})
    return True


def reset(idp, pool_id: str, username: str) -> None:
    """管理员视角删掉某人登记的验证器（测试栈上配合「重设密码」用：之后登录不会再要一把脚本不知道的码，
    「强制」档下改成要求重新绑定、由 answer_mfa 当场绑）。和 BFF 的「重置两步验证」同一个 API。

    不能只关偏好（admin_set_user_mfa_preference Enabled=False）：「强制」档下验证器还登记着，Cognito 照样要旧码。
    本来就没登记 → ResourceNotFoundException，已经是想要的状态。要 botocore 1.43.82 及以上（2026-08 加的 API）。
    """
    try:
        idp.admin_delete_software_token(UserPoolId=pool_id, Username=username)
    except Exception as e:  # botocore ClientError
        if (getattr(e, "response", None) or {}).get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise
