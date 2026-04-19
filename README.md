# Flash Reader

A browser-based speed reader that displays one word at a time using RSVP
(Rapid Serial Visual Presentation), with the Optimal Recognition Point
highlighted in red so the eye can fixate on it without saccading.

**[Live demo ➜ https://reader.rudji.com](https://reader.rudji.com)**
*(Password-protected — contact the owner for credentials.)*

## Features

- **Client-side file import** — EPUB, PDF, TXT, HTML, Markdown. Nothing
  leaves the browser.
- **RSVP reader** — adjustable 100–1200 wpm with punctuation- and
  length-aware pacing, keyboard shortcuts, tap-to-toggle play.
- **Whole-book text preview** — scrollable column to the right of the
  flashing word, click any word to jump to it, `content-visibility`
  chunking keeps even 100K-word books responsive.
- **Background book cover** — shown faded to the left of the reading
  area; pulled from EPUB metadata, rendered from the first PDF page, or
  fetched from Open Library / Google Books as a fallback.
- **Library management** — progress auto-saved to IndexedDB, resumes
  exactly where you left off after closing the browser.
- **Fuzzy search bar** — filter books by title or author, with typo
  tolerance via Damerau-Levenshtein.
- **Metadata resolution chain** — EPUB/PDF embedded metadata → filename
  parsing (handles camelCase, academic `AUTHOR_YEAR_Title.pdf`, etc.)
  → Open Library lookup → Google Books lookup → first-page text
  extraction (`Title … by Author`, `Title … Author, M.D.`, Project
  Gutenberg headers).
- **Reading-time stats** — elapsed session time, remaining time at
  current WPM, total book time; tracked only while the tab is
  foregrounded with the reader open.
- **Four themes** — classic dark / light, plus soft pastel dark / light
  variants. Honors `prefers-color-scheme` on first load.
- **Responsive** — works on phones and tablets.
- **Optional Gradio wrapper** — `gradio_app.py` serves the SPA behind
  basic-auth and publishes a public `*.gradio.live` tunnel.

## Quick start

### Run as a static page

Open `index.html` in any modern browser. That's it — there is no build
step. For features that require HTTP (IndexedDB in some contexts,
external CDN fetches), serve the folder:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

### Run behind Gradio with a public URL + password

```bash
pip install -r requirements.txt
READER_PASSWORD=your-password python gradio_app.py
```

On launch Gradio prints a local URL and a public `*.gradio.live` URL;
both require the login (default username `reader`, override with
`READER_USER`).

Environment variables:

| Variable          | Default      | Purpose                                 |
|-------------------|--------------|-----------------------------------------|
| `READER_PASSWORD` | *(required)* | Password for the login gate.            |
| `READER_USER`     | `reader`     | Username for the login gate.            |
| `HOST`            | `0.0.0.0`    | Bind address.                           |
| `PORT`            | `7860`       | Bind port.                              |
| `SHARE`           | `1`          | Set to `0` to skip the public tunnel.   |

If the public tunnel fails to create, `fix_tunnel.py` and
`diag_tunnel.py` can help diagnose it (missing frpc binary, firewall
blocking the outbound, etc.).

## Keyboard shortcuts

### Library
- `/` — focus the search field
- `Esc` (in search) — clear and blur

### Reader
- `Space` / `k` — play / pause
- `←` / `→` — seek ±10 words (hold `Shift` for ±50)
- `↑` / `↓` — bump WPM by ±10
- `Esc` — back to library

## File layout

```
index.html        SPA entry point
styles.css        All CSS (four themes, responsive)
app.js            View wiring, upload flow, enrichment, search
parsers.js        EPUB / PDF / TXT / HTML parsers + metadata extraction
reader.js         RSVP engine + text-preview renderer
db.js             IndexedDB wrapper
logo.svg          Favicon / header logo
gradio_app.py     Optional Gradio launcher (auth + public tunnel)
requirements.txt  Python deps for gradio_app.py
fix_tunnel.py     Diagnostic: repair Gradio's frpc binary
diag_tunnel.py    Diagnostic: check the share-link pipeline end-to-end
```

## Dependencies

- **JSZip** (CDN) — EPUB is a zip; used for reading the archive.
- **PDF.js** (CDN) — PDF parsing and first-page rendering.
- **Open Library API** — title/author/cover lookup, no key required.
- **Google Books API** — same role as OL, usually better for non-English
  and recent titles; no key required at normal usage.

Everything else is vanilla JavaScript; no build step, no framework, no
bundler.

## License

BSD 2-clause. See [LICENSE](LICENSE).
