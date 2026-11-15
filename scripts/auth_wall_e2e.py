"""QuChen AI 登录墙端到端自测（真实 HTTP，桩 Service，不需要模型或 GPU）。

起 serve/server.py 的 Handler（make_handler）在随机端口上，用一个假的账号服务验证：
未登录时页面变登录页、控制接口 401、静态与 /v1 仍放行；登录后页面恢复；开关关闭时全放行。

    python scripts/auth_wall_e2e.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from serve import authgate, server  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {extra}")


class FakeAccount:
    def __init__(self):
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
                if self.path == "/api/auth/login" and body.get("password") == "RightPass1!":
                    return self._send(200, {"access_token": "at", "refresh_token": "rt", "expires_in": 1800,
                                            "user": {"email": body.get("email"), "role": "user"}})
                if self.path == "/api/auth/logout":
                    return self._send(200, {"ok": True})
                return self._send(401, {"code": "bad_credentials", "message": "wrong password"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


class StubService:
    """只有门禁用得到的字段；门禁放行后访问的路径都在测试里避开了需要模型的接口。"""

    api_key = ""
    telemetry_key = ""
    auth_gate_on = True
    host_names = {"127.0.0.1", "localhost"}
    allowed_hosts = []
    cors_origins = []
    trusted_origins = []

    def __init__(self, gate):
        self.gate = gate


def get(base, path, headers=None):
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def post(base, path, payload, headers=None):
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def serve(gate, gate_on=True):
    stub = StubService(gate)
    stub.auth_gate_on = gate_on
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(stub))
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, base


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="quchen-wall-"))
    acct = FakeAccount()
    gate = authgate.Gate("ai", base_url=acct.base, session_file=tmp / "ai.json")
    httpd, base = serve(gate)
    print(f"wall on {base}, account service {acct.base}")

    print("\n[1] 未登录：页面 -> 登录页")
    code, body = get(base, "/")
    check("GET / 200", code == 200, str(code))
    check("返回登录页（含“登录 QuChen 账号”）", "登录 QuChen 账号" in body)
    check("不泄露应用首页", 'id="app"' not in body)
    code, _ = get(base, "/index.html")
    check("GET /index.html 同样是登录页", code == 200 and "登录 QuChen 账号" in _)
    code, _ = get(base, "/monitor.html")
    check("GET /monitor.html 也拦住", code == 200 and "登录 QuChen 账号" in _)

    print("\n[2] 未登录：控制接口 401")
    for path in ("/settings", "/status", "/slots/0", "/config"):
        code, body = get(base, path)
        ok = code == 401 and "auth_required" in body
        check(f"GET {path} -> 401 auth_required", ok, f"{code} {body[:80]}")

    print("\n[3] 未登录：静态资源放行，/v1 不归门禁管")
    code, body = get(base, "/web/app.js")
    check("GET /web/app.js 200", code == 200, str(code))
    handler = server.make_handler(StubService(gate))
    probe = object.__new__(handler)                    # 只借类上的纯函数，不发请求
    check("/v1/models 归 api_key 管，门禁放行", probe._gate_open("/v1/models") is True)
    check("/settings 不归门禁放行名单", probe._gate_open("/settings") is False)

    print("\n[4] 登录页自身的接口开放")
    code, body = get(base, "/api/auth/state")
    check("GET /api/auth/state 200", code == 200, str(code))
    check("why=no_session", '"why": "no_session"' in body, body[:120])
    code, body = get(base, "/auth/login")
    check("GET /auth/login 200 登录页", code == 200 and "登录 QuChen 账号" in body)

    print("\n[5] 密码错误")
    code, body = post(base, "/api/auth/login", {"email": "a@quchen.local", "password": "nope"})
    check("401 bad_credentials", code == 401 and "bad_credentials" in body, f"{code} {body[:100]}")
    code, body = get(base, "/api/auth/state")
    check("仍未登录", '"why": "no_session"' in body, body[:100])

    print("\n[6] 缺字段")
    code, body = post(base, "/api/auth/login", {"email": "a@quchen.local"})
    check("400 提示缺 password", code == 400, f"{code} {body[:100]}")

    print("\n[7] 登录成功，页面恢复")
    code, body = post(base, "/api/auth/login", {"email": "a@quchen.local", "password": "RightPass1!"})
    check("200 ok", code == 200 and '"ok": true' in body, f"{code} {body[:120]}")
    code, body = get(base, "/")
    check("GET / 回到应用首页", code == 200 and "登录 QuChen 账号" not in body, body[:120])
    check("首页确实是 index.html", "<title>" in body and len(body) > 5000, str(len(body)))
    code, body = get(base, "/api/auth/state")
    check("state unlocked", '"unlocked": true' in body, body[:120])

    print("\n[8] 退出后重新拦住")
    code, body = post(base, "/api/auth/logout", {})
    check("logout 200", code == 200, str(code))
    code, body = get(base, "/")
    check("GET / 又是登录页", "登录 QuChen 账号" in body)

    print("\n[9] 关闭开关：全部放行")
    httpd.shutdown()
    gate2 = authgate.Gate("ai", base_url=acct.base, session_file=tmp / "off.json", enabled=False)
    httpd2, base2 = serve(gate2, gate_on=False)
    code, body = get(base2, "/")
    check("GET / 直接应用首页", code == 200 and "登录 QuChen 账号" not in body, str(code))
    off_probe = object.__new__(server.make_handler(StubService(gate2)))
    check("控制接口不再 401（门禁直通）", off_probe._gate_ok() is True)
    httpd2.shutdown()

    acct.close()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
