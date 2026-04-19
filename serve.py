"""Flash Reader — standalone FastAPI launcher (no Gradio).

Serves ``index.html`` + JS/CSS/SVG assets from this directory and exposes
the book-added audit log route. HTTP Basic auth is optional: set
``READER_PASSWORD`` to enable it; leave it unset to run open.

Run::

    pip install -r requirements.txt
    python serve.py                          # no auth
    READER_PASSWORD=secret python serve.py   # with auth

Environment variables:
    READER_USER      — login username  (default: "reader")
    READER_PASSWORD  — login password  (optional; no auth if unset)
    HOST             — bind host       (default: "127.0.0.1")
    PORT             — bind port       (default: 7860)
    READER_LOG_PATH  — log file path   (default: ./books.log)
"""

from __future__ import annotations

import base64
import os
import secrets
import sys
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from book_log import install_log_routes


BASE = Path(__file__).parent


class BasicAuthMiddleware:
    """ASGI middleware enforcing HTTP Basic on every request.

    Kept as a raw ASGI middleware (not a FastAPI dependency) so static
    files served via ``StaticFiles`` are covered uniformly.
    """

    def __init__(self, app, username: str, password: str) -> None:
        self.app = app
        self._user = username.encode("utf-8")
        self._pass = password.encode("utf-8")
        self._challenge = b'Basic realm="Flash Reader", charset="UTF-8"'

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or self._authorized(scope):
            await self.app(scope, receive, send)
            return
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"www-authenticate", self._challenge),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"Unauthorized"})

    def _authorized(self, scope) -> bool:
        for name, value in scope.get("headers") or []:
            if name != b"authorization" or not value.startswith(b"Basic "):
                continue
            try:
                decoded = base64.b64decode(value[6:])
            except Exception:
                return False
            user, _, password = decoded.partition(b":")
            return secrets.compare_digest(user, self._user) and secrets.compare_digest(
                password, self._pass
            )
        return False


def _basic_auth_username(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(auth[6:]).decode("utf-8")
    except Exception:
        return None
    username, _, _ = decoded.partition(":")
    return username or None


def build_app() -> FastAPI:
    app = FastAPI(title="Flash Reader", docs_url=None, redoc_url=None)

    # Install API routes BEFORE the static mount so /api/log/* wins. Static
    # mount at "/" is a catch-all and would otherwise swallow everything.
    install_log_routes(app, resolve_username=_basic_auth_username)

    # html=True makes GET "/" serve index.html; otherwise everything under
    # this directory is reachable by name.
    app.mount("/", StaticFiles(directory=BASE, html=True), name="static")
    return app


def main() -> None:
    user = os.environ.get("READER_USER", "reader")
    password = os.environ.get("READER_PASSWORD")

    app = build_app()
    if password:
        app.add_middleware(BasicAuthMiddleware, username=user, password=password)
    else:
        print(
            "[flash-reader] running without auth — set READER_PASSWORD to enable.",
            file=sys.stderr,
            flush=True,
        )

    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "7860")),
        log_level="info",
    )


if __name__ == "__main__":
    main()
