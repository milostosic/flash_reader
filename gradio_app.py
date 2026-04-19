"""
Flash Reader — Gradio launcher.

Wraps the existing static SPA (index.html + js/css) in a Gradio Blocks page so
we get two things Gradio provides for free:

  1. ``share=True``  — a public ``*.gradio.live`` tunnel URL.
  2. ``auth=(...)``  — HTTP Basic–style login gate.

The SPA itself is unchanged; we just read every local file, inline them into
one HTML blob, and hand that blob to an ``<iframe srcdoc="...">`` so Gradio's
own styles can't interfere with the app's layout.

Run:

    pip install -r requirements.txt
    READER_PASSWORD=your-password python gradio_app.py

Environment variables:
    READER_USER      — login username (default: "reader")
    READER_PASSWORD  — login password (required)
    HOST             — bind host        (default: "0.0.0.0")
    PORT             — bind port        (default: 7860)
"""

from __future__ import annotations

import base64
import html as html_lib
import os
from pathlib import Path

import gradio as gr


BASE = Path(__file__).parent


def _read(name: str) -> str:
    return (BASE / name).read_text(encoding="utf-8")


def build_inline_html() -> str:
    """Produce a single self-contained HTML document with all local assets inlined.

    We use plain str.replace rather than re.sub because the JS/CSS payloads
    contain backslash escapes (e.g. ``\\d``) which re's replacement string
    parser would interpret as backreferences and reject.
    """
    html = _read("index.html")
    styles = _read("styles.css")
    logo_svg = _read("logo.svg")

    html = html.replace(
        '<link rel="stylesheet" href="styles.css" />',
        f"<style>\n{styles}\n</style>",
    )

    for name in ("db.js", "parsers.js", "reader.js", "app.js"):
        content = _read(name)
        tag = f'<script src="{name}"></script>'
        if tag not in html:
            raise RuntimeError(
                f"Could not find '{tag}' in index.html; inlining would skip {name}."
            )
        html = html.replace(tag, f"<script>\n{content}\n</script>")

    # Favicon + header logo: swap file references for a data URL so the
    # iframe has nothing external to resolve.
    logo_data_url = (
        "data:image/svg+xml;base64,"
        + base64.b64encode(logo_svg.encode("utf-8")).decode("ascii")
    )
    html = html.replace('href="logo.svg"', f'href="{logo_data_url}"')
    html = html.replace('src="logo.svg"', f'src="{logo_data_url}"')

    return html


STRIP_CSS = """
    footer, .show-api, .built-with, .feedback,
    .api-docs-label, .status-tracker { display: none !important; }
    html, body, gradio-app { margin: 0 !important; padding: 0 !important; overflow: hidden; }
    .gradio-container {
        padding: 0 !important;
        margin: 0 !important;
        max-width: none !important;
        width: 100vw !important;
        height: 100vh !important;
        background: transparent !important;
    }
    .gradio-container > *, .contain, .main, .wrap, .app, .panel, .form {
        padding: 0 !important;
        margin: 0 !important;
        gap: 0 !important;
        border: 0 !important;
        background: transparent !important;
    }
    #flash-reader-frame { width: 100vw; height: 100vh; }
"""


def build_gradio_app() -> gr.Blocks:
    inlined = build_inline_html()
    # html.escape(..., quote=True) escapes &, <, >, ", ' — enough to safely put
    # the document inside an iframe srcdoc attribute.
    srcdoc = html_lib.escape(inlined, quote=True)

    frame_html = (
        '<iframe id="flash-reader-frame" '
        f'srcdoc="{srcdoc}" '
        'style="width:100%;height:100vh;border:0;display:block;background:transparent" '
        'allow="clipboard-read; clipboard-write; fullscreen" '
        'sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-forms">'
        "</iframe>"
    )

    with gr.Blocks(title="Flash Reader", analytics_enabled=False) as demo:
        gr.HTML(frame_html)

    return demo


def main() -> None:
    user = os.environ.get("READER_USER", "reader")
    password = os.environ.get("READER_PASSWORD")
    if not password:
        raise SystemExit(
            "READER_PASSWORD is required.\n"
            "    Windows (PowerShell):  $env:READER_PASSWORD='secret'; python gradio_app.py\n"
            "    Windows (cmd):         set READER_PASSWORD=secret && python gradio_app.py\n"
            "    Unix:                  READER_PASSWORD=secret python gradio_app.py"
        )

    share_env = os.environ.get("SHARE", "1").lower()
    share = share_env not in ("0", "false", "no")

    demo = build_gradio_app()

    # Gradio 6 moved `theme` and `css` from the Blocks constructor to launch(),
    # and dropped `show_api`. Older versions accept them on Blocks but not in
    # launch. Try-then-fallback so the same script works on 4.x/5.x and 6.x.
    launch_kwargs = dict(
        server_name=os.environ.get("HOST", "0.0.0.0"),
        server_port=int(os.environ.get("PORT", "7860")),
        share=share,
        auth=(user, password),
    )
    try:
        demo.launch(theme=gr.themes.Base(), css=STRIP_CSS, **launch_kwargs)
    except TypeError:
        # Pre-6.0 Gradio: theme/css belong on the Blocks itself. Rebuild with
        # them applied and launch without those kwargs.
        demo = _rebuild_with_theme_css()
        demo.launch(**launch_kwargs)


def _rebuild_with_theme_css() -> gr.Blocks:
    """Fallback constructor for Gradio versions that still accept theme/css here."""
    inlined = build_inline_html()
    srcdoc = html_lib.escape(inlined, quote=True)
    frame_html = (
        '<iframe id="flash-reader-frame" '
        f'srcdoc="{srcdoc}" '
        'style="width:100%;height:100vh;border:0;display:block;background:transparent" '
        'allow="clipboard-read; clipboard-write; fullscreen" '
        'sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-forms">'
        "</iframe>"
    )
    with gr.Blocks(
        theme=gr.themes.Base(),
        css=STRIP_CSS,
        title="Flash Reader",
        analytics_enabled=False,
    ) as demo:
        gr.HTML(frame_html)
    return demo


if __name__ == "__main__":
    main()
