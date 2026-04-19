"""Shared book-added audit log.

Used by both ``gradio_app.py`` (Gradio-wrapped deployment) and ``serve.py``
(plain FastAPI without Gradio). Call :func:`install_log_routes` on any
FastAPI app to attach ``POST /api/log/book-added`` and ``GET /api/log/ping``.

Log format: JSONL, one event per line, to ``books.log`` in this directory
(override with the ``READER_LOG_PATH`` env var).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from fastapi import FastAPI, Request


BASE = Path(__file__).parent
LOG_PATH = Path(os.environ.get("READER_LOG_PATH") or (BASE / "books.log"))

# Writes come in on Uvicorn's threadpool (one thread per concurrent request),
# so concurrent book adds from many users would otherwise interleave bytes
# in the file. Single-process server means an in-process Lock is enough.
_LOG_LOCK = threading.Lock()


UsernameResolver = Callable[[Request], Optional[str]]


def client_ip(request: Request) -> str:
    # Reverse proxies and tunnels (gradio.live, nginx, cloudflare, ...) put
    # the real peer in X-Forwarded-For; request.client.host is the proxy's
    # loopback in that case.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "-"


def _append_log_line(entry: dict) -> None:
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _LOG_LOCK:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)


def install_log_routes(
    app: FastAPI,
    resolve_username: UsernameResolver | None = None,
) -> None:
    """Attach the book-log routes to ``app``.

    ``resolve_username`` returns the authenticated user for a request, or
    None if it can't be determined. Each deployment resolves auth
    differently (Gradio session cookie vs. HTTP Basic header, ...), so we
    accept it as a strategy callback.
    """

    async def _book_added(request: Request) -> dict:
        print(
            f"[flash-reader] book-added hit from {client_ip(request)}",
            file=sys.stderr,
            flush=True,
        )
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        def _s(key: str, limit: int = 500) -> str:
            v = payload.get(key)
            return str(v)[:limit] if v is not None else ""

        try:
            word_count: int | None = int(payload.get("wordCount"))
        except (TypeError, ValueError):
            word_count = None

        user = (resolve_username(request) if resolve_username else None) or "-"

        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": "book_added",
            "user": user,
            "ip": client_ip(request),
            "user_agent": request.headers.get("user-agent", "-"),
            "title": _s("title"),
            "author": _s("author"),
            "word_count": word_count,
        }
        try:
            # Bounce the blocking file write off the event loop.
            await asyncio.to_thread(_append_log_line, entry)
        except Exception:
            traceback.print_exc()
            return {"ok": False, "error": "write failed"}
        return {"ok": True}

    async def _ping(request: Request) -> dict:
        user = (resolve_username(request) if resolve_username else None) or "-"
        return {"ok": True, "log_path": str(LOG_PATH), "user": user}

    app.add_api_route("/api/log/book-added", _book_added, methods=["POST"])
    app.add_api_route("/api/log/ping", _ping, methods=["GET"])
    print(
        f"[flash-reader] book-log route installed → {LOG_PATH}",
        file=sys.stderr,
        flush=True,
    )
