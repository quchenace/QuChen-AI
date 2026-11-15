"""QuChen 账号门禁自测（AI 端）。

不起模型、不起真账号服务：只用一个假的 /api/auth/* 服务验证 serve/authgate.py 的判定与落盘，
再把 serve/server.py 的门禁分支按方法级跑一遍（_gate_page / _gate_api / _gate_open 的取值）。
零第三方依赖：python scripts/auth_gate_selftest.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from serve import authgate  # noqa: E402

PASS = FAIL = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {extra}")


class FakeAccount:
    """最小账号服务：登录成功/失败、refresh 轮换、logout 撤销、entitlement。"""

    def __init__(self):
        self.revoked = set()
        self.logins = 0
        self.refresh_ok = True
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0) or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path == "/api/auth/login":
                    fake.logins += 1
                    if body.get("password") != "RightPass1!":
                        return self._send(401, {"code": "bad_credentials", "message": "wrong password"})
                    if body.get("email") == "pending@quchen.local":
                        return self._send(403, {"code": "pending", "message": "awaiting approval"})
                    return self._send(200, {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 1800,
                                            "user": {"email": body.get("email"), "role": "user"}})
                if self.path == "/api/auth/refresh":
                    if not fake.refresh_ok or body.get("refresh_token") in fake.revoked:
                        return self._send(401, {"code": "revoked", "message": "refresh revoked"})
                    return self._send(200, {"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 1800})
                if self.path == "/api/auth/logout":
                    fake.revoked.add(body.get("refresh_token"))
                    return self._send(200, {"ok": True})
                self._send(404, {"error": "not found"})

            def do_GET(self):
                if self.path == "/api/auth/entitlement":
                    return self._send(200, {"features": ["chat"]})
                self._send(404, {"error": "not found"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="quchen-gate-"))
    acct = FakeAccount()
    print(f"fake account service on {acct.base}")

    print("\n[1] 未登录")
    gate = authgate.Gate("ai", base_url=acct.base, session_file=tmp / "ai.json")
    check("unlocked 为 False", gate.unlocked() is False)
    check("reason=no_session", gate.reason()["why"] == "no_session")
    check("会话文件此时不存在", not (tmp / "ai.json").exists())

    print("\n[2] 密码错误")
    try:
        gate.login("a@quchen.local", "bad")
        check("应抛 AuthError", False)
    except authgate.AuthError as e:
        check("状态 401 / code bad_credentials", e.status == 401 and e.code == "bad_credentials", str(e))
    check("失败后仍未解锁", gate.unlocked() is False)

    print("\n[3] 待审批账号")
    try:
        gate.login("pending@quchen.local", "RightPass1!")
        check("应抛 AuthError", False)
    except authgate.AuthError as e:
        check("code=pending", e.code == "pending", str(e))

    print("\n[4] 登录成功")
    st = gate.login("a@quchen.local", "RightPass1!")
    check("拿到 access/refresh", st["access_token"] == "at-1" and st["refresh_token"] == "rt-1")
    check("email 落盘", gate.state()["email"] == "a@quchen.local")
    check("unlocked 为 True", gate.unlocked() is True)
    check("reason=session", gate.reason()["why"] == "session")
    saved = json.loads((tmp / "ai.json").read_text(encoding="utf-8"))
    check("磁盘文件有 refresh_token", saved.get("refresh_token") == "rt-1")
    check("磁盘文件无密码字段", "password" not in json.dumps(saved))

    print("\n[5] 权限位")
    check("entitlement 可读", gate.entitlement().get("features") == ["chat"])

    print("\n[6] 续期（refresh 轮换）")
    st = gate.refresh()
    check("access 换成 at-2", st["access_token"] == "at-2")
    check("refresh 轮换为 rt-2", st["refresh_token"] == "rt-2")
    check("last_verified 更新", time.time() - float(gate.state()["last_verified"]) < 5)
    check("ensure_fresh 不报错", gate.ensure_fresh() is True)

    print("\n[7] 离线宽限（账号服务不可达）")
    off = authgate.Gate("ai", base_url="http://127.0.0.1:9", session_file=tmp / "ai.json")
    check("同会话文件在离线时仍解锁", off.unlocked() is True)
    check("ensure_fresh 离线返回 False", off.ensure_fresh() is False)
    check("离线不清会话", off.state().get("refresh_token") == "rt-2")
    stale = dict(json.loads((tmp / "ai.json").read_text(encoding="utf-8")))
    stale["last_verified"] = time.time() - 29 * 86400
    (tmp / "late.json").write_text(json.dumps(stale), encoding="utf-8")
    g29 = authgate.Gate("ai", base_url="http://127.0.0.1:9", session_file=tmp / "late.json")
    check("29 天内离线仍放行", g29.unlocked() is True)
    stale["last_verified"] = time.time() - 31 * 86400
    stale.pop("issued_at", None)
    (tmp / "expired.json").write_text(json.dumps(stale), encoding="utf-8")
    g31 = authgate.Gate("ai", base_url="http://127.0.0.1:9", session_file=tmp / "expired.json")
    check("31 天后要求重新登录", g31.unlocked() is False)
    check("reason=grace_expired", g31.reason()["why"] == "grace_expired")

    print("\n[8] 退出")
    gate.logout()
    check("logout 后解锁为 False", gate.unlocked() is False)
    check("rt-2 已被服务端撤销", "rt-2" in acct.revoked)
    check("会话文件清空", gate.state() == {})

    print("\n[9] 关闭开关时始终放行")
    open_gate = authgate.Gate("ai", enabled=False, session_file=tmp / "none.json")
    check("enabled=False 直接放行", open_gate.unlocked() is True)
    check("reason=disabled", open_gate.reason()["why"] == "disabled")

    print("\n[10] 损坏的会话文件")
    (tmp / "broken.json").write_text("{not json", encoding="utf-8")
    broken = authgate.Gate("ai", session_file=tmp / "broken.json")
    check("不崩溃且视为未登录", broken.unlocked() is False)

    print("\n[11] 门禁路径分类（与 server.py 的常量一致）")
    page = ("", "/index.html", "/monitor.html", "/monitor", "/app")
    opened = ("/api/auth/login", "/api/auth/state", "/favicon.ico", "/auth/login", "/web/app.js",
              "/fonts/x.woff2", "/v1/chat/completions")
    api = ("/settings", "/slots/0", "/config", "/status")
    check("页面路径 5 个", len(page) == 5)
    check("放行路径覆盖 /v1 与静态", all(p.startswith(("/v1/", "/web/", "/fonts/", "/auth/", "/api/auth/"))
                                        or p == "/favicon.ico" for p in opened))
    check("控制接口仍需门禁", all(not p.startswith(("/v1/", "/web/", "/favicon", "/api/auth", "/auth/"))
                                  for p in api))
    check("登录页文件存在", (ROOT / "serve" / "web" / "login.html").is_file())

    acct.close()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
