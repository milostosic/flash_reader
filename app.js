// Application wiring: library <-> reader views, upload flow, progress persistence.

(function () {
  const DB = window.FlashReaderDB;
  const { parseFile, tokenize, extractTitleAuthorFromText } = window.FlashReaderParsers;
  const RSVPReader = window.FlashReaderRSVP;

  const els = {
    libraryView: document.getElementById('library-view'),
    readerView: document.getElementById('reader-view'),
    fileInput: document.getElementById('file-input'),
    uploadStatus: document.getElementById('upload-status'),
    bookList: document.getElementById('book-list'),
    emptyState: document.getElementById('empty-state'),
    noMatches: document.getElementById('no-matches'),
    bookSearch: document.getElementById('book-search'),
    dropOverlay: document.getElementById('drop-overlay'),
    bookItemTpl: document.getElementById('book-item-template'),

    backBtn: document.getElementById('back-btn'),
    readerTitle: document.getElementById('reader-title'),
    readerProgress: document.getElementById('reader-progress'),
    progressBarFill: document.getElementById('progress-bar-fill'),
    statRead: document.getElementById('stat-read'),
    statLeft: document.getElementById('stat-left'),
    statTotal: document.getElementById('stat-total'),
    statWpm: document.getElementById('stat-wpm'),
    wordBefore: document.getElementById('word-before'),
    wordPivot: document.getElementById('word-pivot'),
    wordAfter: document.getElementById('word-after'),
    textPreview: document.getElementById('text-preview'),
    textPreviewInner: document.getElementById('text-preview-inner'),
    coverSide: document.getElementById('cover-side'),
    coverSideImg: document.getElementById('cover-side-img'),
    playBtn: document.getElementById('play-btn'),
    rewindBtn: document.getElementById('rewind-btn'),
    forwardBtn: document.getElementById('forward-btn'),
    wpmSlider: document.getElementById('wpm-slider'),
    wpmValue: document.getElementById('wpm-value'),
  };

  const rsvp = new RSVPReader({
    wordBeforeEl: els.wordBefore,
    wordPivotEl: els.wordPivot,
    wordAfterEl: els.wordAfter,
    progressEl: els.readerProgress,
    progressBarFillEl: els.progressBarFill,
    previewEl: els.textPreview,
    previewInnerEl: els.textPreviewInner,
    onProgress: (pos) => scheduleSave(pos),
    onEnd: () => setPlayIcon(false),
  });

  let currentBookId = null;

  // Reading-time tracking. Time accumulates only while the reader view is
  // visible and the tab is foregrounded, regardless of RSVP play state.
  let readingMs = 0;
  let readingSessionStart = null;
  let readingTickInterval = null;

  function startReadingTimer() {
    if (readingSessionStart != null) return;
    readingSessionStart = Date.now();
    if (readingTickInterval) clearInterval(readingTickInterval);
    readingTickInterval = setInterval(tickReading, 1000);
    updateReadingStats();
  }
  function pauseReadingTimer() {
    if (readingSessionStart != null) {
      readingMs += Date.now() - readingSessionStart;
      readingSessionStart = null;
    }
    if (readingTickInterval) {
      clearInterval(readingTickInterval);
      readingTickInterval = null;
    }
    updateReadingStats();
  }
  function tickReading() {
    if (readingSessionStart == null) return;
    const now = Date.now();
    readingMs += now - readingSessionStart;
    readingSessionStart = now;
    updateReadingStats();
    scheduleSave(rsvp.position);
  }
  function currentReadingMs() {
    return readingSessionStart != null
      ? readingMs + (Date.now() - readingSessionStart)
      : readingMs;
  }

  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return totalSec + 's';
    const totalMin = Math.round(totalSec / 60);
    if (totalMin < 60) return totalMin + 'm';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  function updateReadingStats() {
    const wpm = Math.max(1, Number(els.wpmSlider.value) || 500);
    els.statWpm.textContent = wpm;
    const total = rsvp.words.length;
    if (!total || !currentBookId) {
      els.statRead.textContent = formatDuration(currentReadingMs());
      els.statLeft.textContent = '—';
      els.statTotal.textContent = '—';
      return;
    }
    const pos = Math.min(rsvp.position, total);
    const totalMs = (total / wpm) * 60000;
    const leftMs = Math.max(0, ((total - pos) / wpm) * 60000);
    els.statRead.textContent = formatDuration(currentReadingMs());
    els.statLeft.textContent = formatDuration(leftMs);
    els.statTotal.textContent = formatDuration(totalMs);
  }

  // ---------- Views ----------
  function showLibrary() {
    rsvp.pause();
    pauseReadingTimer();
    flushSave();
    els.libraryView.classList.add('active');
    els.readerView.classList.remove('active');
    setReaderCover(null);
    currentBookId = null;
    readingMs = 0;
    renderLibrary();
  }

  function showReader() {
    els.libraryView.classList.remove('active');
    els.readerView.classList.add('active');
  }

  // ---------- Cover helpers ----------
  // IndexedDB in opaque-origin contexts (e.g. the Gradio iframe) rejects
  // Blob values with "BlobURLs are not yet supported". Store the raw bytes
  // + mime type instead and reconstruct a Blob when we need an object URL.
  function coverAsBlob(stored) {
    if (!stored) return null;
    if (stored instanceof Blob) return stored;
    if (stored.buffer instanceof ArrayBuffer) {
      return new Blob([stored.buffer], { type: stored.type || 'image/jpeg' });
    }
    return null;
  }
  async function coverToStored(blob) {
    if (!blob) return null;
    if (!(blob instanceof Blob)) return blob; // already in stored form
    return { buffer: await blob.arrayBuffer(), type: blob.type || 'image/jpeg' };
  }

  // ---------- Library ----------
  let coverUrlCache = [];
  function releaseCoverUrls() {
    for (const url of coverUrlCache) URL.revokeObjectURL(url);
    coverUrlCache = [];
  }
  function coverObjectUrl(stored) {
    const blob = coverAsBlob(stored);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    coverUrlCache.push(url);
    return url;
  }

  // Mapping from book id → rendered <li> element so the search filter can
  // hide/show items without re-rendering the list.
  let renderedBooks = [];

  async function renderLibrary() {
    releaseCoverUrls();
    renderedBooks = [];
    const books = await DB.getAllMeta();
    els.bookList.innerHTML = '';
    if (!books.length) {
      els.emptyState.hidden = false;
      els.noMatches.hidden = true;
      return;
    }
    els.emptyState.hidden = true;

    const frag = document.createDocumentFragment();
    for (const b of books) {
      const node = els.bookItemTpl.content.cloneNode(true);
      const item = node.querySelector('.book-item');
      const mainBtn = node.querySelector('.book-main');
      const deleteBtn = node.querySelector('.book-delete');
      const coverImg = node.querySelector('.book-cover img');
      const coverEl = node.querySelector('.book-cover');

      const coverUrl = b.cover ? coverObjectUrl(b.cover) : null;
      if (coverUrl) {
        coverImg.src = coverUrl;
      } else {
        coverImg.remove();
        coverEl.textContent = (b.title || '?').slice(0, 1).toUpperCase();
        coverEl.classList.add('book-cover-empty');
      }

      node.querySelector('.book-title').textContent = b.title;
      const authorEl = node.querySelector('.book-author');
      if (b.author) authorEl.textContent = b.author;
      else authorEl.remove();
      node.querySelector('.book-wordcount').textContent =
        b.wordCount.toLocaleString() + ' words';

      const pct = b.wordCount ? Math.round((b.position / b.wordCount) * 100) : 0;
      node.querySelector('.book-progress').textContent =
        pct >= 100 ? 'Finished' : pct + '% read';
      node.querySelector('.book-progressbar-fill').style.width = pct + '%';

      const timeleftEl = node.querySelector('.book-timeleft');
      if (b.wordCount) {
        const wpm = Math.max(1, b.wpm || 500);
        const remainingMs = Math.max(0, ((b.wordCount - b.position) / wpm) * 60000);
        if (pct >= 100) timeleftEl.remove();
        else timeleftEl.textContent = '~' + formatDuration(remainingMs) + ' left at ' + wpm + ' wpm';
      } else {
        timeleftEl.remove();
      }

      mainBtn.addEventListener('click', () => openBook(b.id));
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete "' + b.title + '"?')) return;
        await DB.delete(b.id);
        renderLibrary();
      });
      item.dataset.bookId = b.id;
      renderedBooks.push({ book: b, element: item });
      frag.appendChild(node);
    }
    els.bookList.appendChild(frag);

    // Re-apply the current filter so typing in search survives a re-render.
    applyBookFilter(els.bookSearch.value || '');
  }

  // --- Search/filter ---------------------------------------------------------
  // Substring match (diacritic-folded, case-insensitive) on title + author;
  // each query token must match somewhere. If a token doesn't match as a
  // substring, fall back to token-level Damerau-Levenshtein so typos like
  // "harr" or "jkr" still find "Harry Potter" / "Rowling".
  function foldAndLower(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function applyBookFilter(rawQuery) {
    const query = foldAndLower(rawQuery).trim();
    if (!query) {
      for (const r of renderedBooks) r.element.hidden = false;
      els.noMatches.hidden = true;
      return;
    }

    const queryTokens = query.split(/\s+/).filter(Boolean);
    let visibleCount = 0;

    for (const { book, element } of renderedBooks) {
      const haystack = foldAndLower(
        (book.title || '') + ' ' + (book.author || '')
      );
      const haystackTokens = haystack.split(/[^a-z0-9']+/).filter(Boolean);

      const allMatch = queryTokens.every((qt) => {
        if (haystack.includes(qt)) return true;
        // Fuzzy per-token fallback
        for (const ht of haystackTokens) {
          if (Math.abs(ht.length - qt.length) > 2) continue;
          const minLen = Math.min(qt.length, ht.length);
          if (minLen < 4) continue;
          const threshold = minLen >= 6 ? 2 : 1;
          if (damerauLevenshtein(qt, ht) <= threshold) return true;
        }
        return false;
      });

      element.hidden = !allMatch;
      if (allMatch) visibleCount++;
    }

    els.noMatches.hidden = visibleCount > 0;
  }

  els.bookSearch.addEventListener('input', (e) => {
    applyBookFilter(e.target.value);
  });
  els.bookSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      els.bookSearch.value = '';
      applyBookFilter('');
      els.bookSearch.blur();
    }
  });
  // "/" focuses the search input from anywhere in the library view.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    if (!els.libraryView.classList.contains('active')) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    els.bookSearch.focus();
    els.bookSearch.select();
  });

  // ---------- Upload ----------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
      showStatus('Parsing ' + file.name + '…');
      try {
        const parsed = await parseFile(file);
        const words = tokenize(parsed.text);
        if (!words.length) throw new Error('No readable text found');

        let title = (parsed.title || '').trim() || file.name;
        let author = (parsed.author || '').trim();
        let cover = parsed.coverBlob || null;

        // --- DEBUG: dump what the parser produced and what we'll search with
        console.group('[book-debug] ' + file.name);
        console.log('parsed.title :', JSON.stringify(parsed.title));
        console.log('parsed.author:', JSON.stringify(parsed.author));
        console.log('parsed.coverBlob present?', !!parsed.coverBlob, parsed.coverBlob && parsed.coverBlob.size);
        console.log('text length  :', parsed.text ? parsed.text.length : 0);
        console.log('text [first 400 chars]:',
          (parsed.text || '').slice(0, 400).replace(/\s+/g, ' '));
        console.log('initial title/author for lookup:',
          JSON.stringify(title), JSON.stringify(author));

        // Always consult online catalogs — filenames almost never match the
        // real book name exactly. Try Open Library first (better for English
        // titles and older works), then Google Books (better for non-English
        // and contemporary). Accept a hit only when confidence is high enough.
        showStatus('Looking up "' + title + '"…');
        let matched = false;
        const sources = [
          ['OL', () => fetchOpenLibrary(title, author)],
          ['GB', () => fetchGoogleBooks(title, author)],
        ];
        for (const [name, fetchFrom] of sources) {
          let hit = null;
          let err = null;
          try { hit = await fetchFrom(); } catch (e) { err = e; }
          const verdict = hit && hit.title
            ? isConfidentMatch(title, hit.title, author, hit.author)
            : false;
          console.log('[' + name + ']',
            'hit=', hit ? { title: hit.title, author: hit.author, cover: !!hit.cover } : null,
            'err=', err && err.message,
            'confident=', verdict);
          if (verdict) {
            title = hit.title;
            if (hit.author) author = hit.author;
            if (!cover && hit.cover) cover = hit.cover;
            matched = true;
            break;
          }
        }

        // Last resort: the title/author might be printed on the first page of
        // the book itself. Scan the opening text, then re-query online with
        // those fresh candidates. If online *still* doesn't find it, at
        // least display what we pulled from the text directly.
        if (!matched) {
          const fromText = extractTitleAuthorFromText(parsed.text);
          console.log('extractTitleAuthorFromText ->', fromText);
          if (fromText) {
            showStatus('Looking up "' + fromText.title + '"…');
            const retry = [
              ['OL-retry', () => fetchOpenLibrary(fromText.title, fromText.author)],
              ['GB-retry', () => fetchGoogleBooks(fromText.title, fromText.author)],
            ];
            for (const [name, fetchFrom] of retry) {
              let hit = null;
              let err = null;
              try { hit = await fetchFrom(); } catch (e) { err = e; }
              const verdict = hit && hit.title
                ? isConfidentMatch(fromText.title, hit.title, fromText.author, hit.author)
                : false;
              console.log('[' + name + ']',
                'hit=', hit ? { title: hit.title, author: hit.author, cover: !!hit.cover } : null,
                'err=', err && err.message,
                'confident=', verdict);
              if (verdict) {
                title = hit.title;
                if (hit.author) author = hit.author;
                if (!cover && hit.cover) cover = hit.cover;
                matched = true;
                break;
              }
            }
            if (!matched) {
              title = fromText.title;
              author = fromText.author;
            }
          }
        }

        console.log('FINAL → title:', JSON.stringify(title), 'author:', JSON.stringify(author), 'cover:', !!cover);
        console.groupEnd();

        const book = {
          id: makeId(),
          title,
          author,
          cover: await coverToStored(cover),
          words,
          wordCount: words.length,
          position: 0,
          wpm: Number(els.wpmSlider.value) || 500,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await DB.put(book);
        logBookAdded(book);
        showStatus('Added "' + title + '" (' + words.length.toLocaleString() + ' words)');
      } catch (err) {
        console.error(err);
        showStatus('Failed: ' + file.name + ' — ' + (err && err.message ? err.message : err), true);
      }
    }

    setTimeout(hideStatus, 2500);
    renderLibrary();
  }

  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'book', 'vol', 'volume',
    'his', 'her', 'its', 'into', 'that', 'this', 'part',
  ]);
  function significantTokens(s) {
    // Fold diacritics so "rečnik" matches "recnik", "tolstói" matches "tolstoi", etc.
    const folded = String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return new Set(
      folded.split(/[^a-z0-9']+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    );
  }

  // Damerau-Levenshtein: like Levenshtein but counts adjacent transpositions
  // as 1 edit (so "santiy" vs "sanity" = 1, not 2).
  function damerauLevenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
        if (i > 1 && j > 1 &&
            a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
            a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
          dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
        }
      }
    }
    return dp[m][n];
  }

  // Whether two tokens are close enough to treat as the same word. Used to
  // absorb filename typos ("santiy" ↔ "sanity"), letter swaps, and one-char
  // slips. Short tokens (<4 chars) must match exactly — too risky otherwise.
  function tokensSimilar(a, b) {
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 4) return false;
    if (Math.abs(a.length - b.length) > 2) return false;
    const threshold = minLen >= 6 ? 2 : 1;
    return damerauLevenshtein(a, b) <= threshold;
  }

  // Count tokens in `a` that have an exact OR fuzzy counterpart in `b`.
  // Each token in `b` can only be consumed once so "the the" can't match
  // "the mask" twice on the same side.
  function fuzzyTokenOverlap(a, b) {
    const remainingA = [];
    const remainingB = new Set(b);
    let count = 0;
    for (const t of a) {
      if (remainingB.has(t)) {
        remainingB.delete(t);
        count++;
      } else {
        remainingA.push(t);
      }
    }
    for (const t of remainingA) {
      if (remainingB.size === 0) break;
      for (const u of remainingB) {
        if (tokensSimilar(t, u)) {
          remainingB.delete(u);
          count++;
          break;
        }
      }
    }
    return count;
  }

  // Decide if an Open Library result is close enough to our local metadata
  // to trust. Token overlap (with typo tolerance) rather than raw ratio so
  // a single shared token between short titles can't force a bad match.
  function isConfidentMatch(localTitle, olTitle, localAuthor, olAuthor) {
    const ta = significantTokens(localTitle);
    const tb = significantTokens(olTitle);
    if (!ta.size || !tb.size) return false;
    const inter = fuzzyTokenOverlap(ta, tb);

    if (inter >= 2) return true;
    if (inter >= 1 && (ta.size <= 1 || tb.size <= 1)) return true;

    if (inter >= 1 && localAuthor && olAuthor) {
      const aA = significantTokens(localAuthor);
      const aB = significantTokens(olAuthor);
      if (fuzzyTokenOverlap(aA, aB) > 0) return true;
    }
    return false;
  }

  // Query Open Library for a matching book. Tries several query variants
  // (with author, title-only, shortened title) and picks the best hit with
  // a cover image; falls back to a no-cover hit when nothing better exists.
  async function fetchOpenLibrary(title, author) {
    if (!title) return null;

    const variants = [];
    if (author) variants.push({ title, author });
    variants.push({ title });
    // "Author - Title" and "Title - Author" are both common in filenames;
    // try the swapped ordering as a fallback.
    if (author) variants.push({ title: author, author: title });
    const titleTokens = title.split(/\s+/).filter((w) => w.length > 2);
    if (titleTokens.length > 4) {
      const shortTitle = titleTokens.slice(0, 4).join(' ');
      if (author) variants.push({ title: shortTitle, author });
      variants.push({ title: shortTitle });
    }
    // Also try a combined query when we only have a title — OL's "q" param
    // does a broad fuzzy search across all fields.
    variants.push({ q: author ? title + ' ' + author : title });

    let fallback = null;
    for (const v of variants) {
      const params = new URLSearchParams();
      if (v.q) params.set('q', v.q);
      else {
        params.set('title', v.title);
        if (v.author) params.set('author', v.author);
      }
      params.set('limit', '10');
      let res;
      try {
        res = await fetch('https://openlibrary.org/search.json?' + params.toString());
      } catch (_) { continue; }
      if (!res.ok) continue;
      const data = await res.json();
      const docs = (data && data.docs) || [];
      if (!docs.length) continue;

      // Prefer docs with covers; download the first image that's not OL's placeholder.
      for (const doc of docs) {
        if (!doc.cover_i) continue;
        const blob = await fetchOLCover(doc.cover_i);
        if (!blob) continue;
        return {
          title: doc.title || '',
          author: (doc.author_name && doc.author_name[0]) || '',
          cover: blob,
        };
      }
      // Remember the first metadata-only hit as a fallback.
      if (!fallback) {
        fallback = {
          title: docs[0].title || '',
          author: (docs[0].author_name && docs[0].author_name[0]) || '',
          cover: null,
        };
      }
    }

    return fallback;
  }

  async function fetchOLCover(coverId) {
    try {
      const res = await fetch('https://covers.openlibrary.org/b/id/' + coverId + '-M.jpg');
      if (!res.ok) return null;
      const blob = await res.blob();
      // OL returns a tiny placeholder when a cover is actually missing.
      if (blob.size < 500) return null;
      return blob;
    } catch (_) {
      return null;
    }
  }

  // Google Books fallback. Better coverage for non-English titles, recent
  // books, and obscure regional editions. Public endpoint — no API key.
  async function fetchGoogleBooks(title, author) {
    if (!title) return null;
    const variants = [];
    if (author) variants.push('intitle:"' + title + '"+inauthor:"' + author + '"');
    variants.push('intitle:"' + title + '"');
    if (author) variants.push(title + ' ' + author);
    variants.push(title);

    let fallback = null;
    for (const q of variants) {
      const url =
        'https://www.googleapis.com/books/v1/volumes?q=' +
        encodeURIComponent(q) +
        '&maxResults=10&printType=books';
      let res;
      try { res = await fetch(url); } catch (_) { continue; }
      if (!res.ok) continue;
      const data = await res.json();
      const items = (data && data.items) || [];
      if (!items.length) continue;

      for (const item of items) {
        const vi = (item && item.volumeInfo) || {};
        if (!vi.title) continue;
        const thumbRaw = vi.imageLinks &&
          (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail);
        if (thumbRaw) {
          // Force https to avoid mixed-content blocks.
          const thumbUrl = thumbRaw.replace(/^http:/, 'https:');
          const blob = await fetchExternalCover(thumbUrl);
          if (blob) {
            return {
              title: vi.title,
              author: (vi.authors && vi.authors[0]) || '',
              cover: blob,
            };
          }
        }
        if (!fallback) {
          fallback = {
            title: vi.title,
            author: (vi.authors && vi.authors[0]) || '',
            cover: null,
          };
        }
      }
    }
    return fallback;
  }

  async function fetchExternalCover(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size < 500) return null;
      return blob;
    } catch (_) {
      return null;
    }
  }

  // Fire-and-forget audit log. The SPA runs inside a srcdoc iframe whose
  // origin is "null", so relative URLs don't resolve to the Gradio server
  // (baseURI is about:srcdoc) and the request is treated as cross-origin.
  // Fix: build an absolute URL from the parent's origin and send the auth
  // cookie via credentials:'include'. Needs strict_cors=False server-side
  // so the "null" origin is accepted.
  const LOG_BASE = (function () {
    try {
      const ctx = window.parent && window.parent !== window ? window.parent : window;
      const origin = ctx.location.origin;
      return origin && origin !== 'null' ? origin : '';
    } catch (_) {
      return '';
    }
  })();
  console.log('[flash-reader] log base URL =', JSON.stringify(LOG_BASE));

  function logBookAdded(book) {
    if (!LOG_BASE) {
      console.warn('[flash-reader] skipping book-added log: no usable origin');
      return;
    }
    const url = LOG_BASE + '/api/log/book-added';
    const payload = {
      title: book.title,
      author: book.author,
      wordCount: book.wordCount,
    };
    console.log('[flash-reader] POST', url, payload);
    try {
      fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => {
        console.log('[flash-reader] book-added →', r.status);
      }).catch((err) => {
        console.warn('[flash-reader] book-added failed:', err);
      });
    } catch (err) {
      console.warn('[flash-reader] book-added threw:', err);
    }
  }

  function showStatus(msg, isError) {
    els.uploadStatus.hidden = false;
    els.uploadStatus.textContent = msg;
    els.uploadStatus.classList.toggle('error', !!isError);
  }
  function hideStatus() {
    els.uploadStatus.hidden = true;
    els.uploadStatus.classList.remove('error');
  }

  function makeId() {
    return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Reader ----------
  let readerCoverUrl = null;
  function setReaderCover(stored) {
    if (readerCoverUrl) {
      URL.revokeObjectURL(readerCoverUrl);
      readerCoverUrl = null;
    }
    const blob = coverAsBlob(stored);
    if (blob) {
      readerCoverUrl = URL.createObjectURL(blob);
      els.coverSideImg.src = readerCoverUrl;
      els.coverSide.hidden = false;
    } else {
      els.coverSideImg.removeAttribute('src');
      els.coverSide.hidden = true;
    }
  }

  async function openBook(id) {
    const book = await DB.get(id);
    if (!book) return;
    currentBookId = id;
    els.readerTitle.textContent = book.author
      ? book.title + ' — ' + book.author
      : book.title;
    els.wpmSlider.value = book.wpm || 500;
    els.wpmValue.textContent = els.wpmSlider.value;
    readingMs = book.readingMs || 0;
    setReaderCover(book.cover || null);
    // Reveal the view first so the preview container has a real height
    // when renderAt runs inside load().
    showReader();
    rsvp.load(book.words, book.position || 0, Number(els.wpmSlider.value));
    setPlayIcon(false);
    startReadingTimer();
    updateReadingStats();
  }

  // Re-center the preview on resize. Must remeasure first, since text wraps
  // to different lines at a new width and the cached offsets go stale.
  // Debounced because a single drag of the window edge can fire resize at
  // 60 Hz, and each remeasure does a full layout pass on the preview DOM.
  let resizeDebounce = null;
  window.addEventListener('resize', () => {
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      if (els.readerView.classList.contains('active')) {
        rsvp.remeasurePreview();
        rsvp.renderAt(rsvp.position);
      }
    }, 180);
  });

  function setPlayIcon(playing) {
    els.playBtn.innerHTML = playing ? '&#x23F8;' : '&#x25B6;';
    els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // ---------- Progress persistence (throttled) ----------
  let saveTimer = null;
  let pendingPos = null;
  function scheduleSave(pos) {
    pendingPos = pos;
    if (saveTimer) return;
    saveTimer = setTimeout(flushSave, 1000);
  }
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (currentBookId == null) return;
    const pos = pendingPos != null ? pendingPos : rsvp.position;
    const wpm = Number(els.wpmSlider.value) || 500;
    const ms = currentReadingMs();
    pendingPos = null;
    DB.updateProgress(currentBookId, pos, wpm, ms).catch((e) => console.error(e));
  }

  // ---------- Event wiring ----------
  els.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  els.backBtn.addEventListener('click', showLibrary);

  els.playBtn.addEventListener('click', () => {
    rsvp.toggle();
    setPlayIcon(rsvp.playing);
  });

  els.rewindBtn.addEventListener('click', () => rsvp.seek(-10));
  els.forwardBtn.addEventListener('click', () => rsvp.seek(10));

  els.wpmSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    els.wpmValue.textContent = v;
    rsvp.setWpm(v);
    updateReadingStats();
    scheduleSave(rsvp.position);
  });

  // Tap the reader stage to toggle play.
  document.querySelector('.reader-stage').addEventListener('click', () => {
    rsvp.toggle();
    setPlayIcon(rsvp.playing);
  });

  // Keyboard shortcuts in reader.
  document.addEventListener('keydown', (e) => {
    if (!els.readerView.classList.contains('active')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        rsvp.toggle();
        setPlayIcon(rsvp.playing);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        rsvp.seek(e.shiftKey ? -50 : -10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        rsvp.seek(e.shiftKey ? 50 : 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        bumpWpm(10);
        break;
      case 'ArrowDown':
        e.preventDefault();
        bumpWpm(-10);
        break;
      case 'Escape':
        showLibrary();
        break;
    }
  });

  function bumpWpm(delta) {
    const v = Math.max(100, Math.min(1200, Number(els.wpmSlider.value) + delta));
    els.wpmSlider.value = v;
    els.wpmValue.textContent = v;
    rsvp.setWpm(v);
    updateReadingStats();
    scheduleSave(rsvp.position);
  }

  // ---------- Drag & drop ----------
  // Drops are still accepted anywhere in the library view; the side indicator
  // is purely visual feedback. Depth counters can desync across browsers, so
  // we additionally hide the indicator if no dragover fires for a moment.
  let hideTimer = null;
  function showDropIndicator() {
    els.dropOverlay.classList.add('active');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideDropIndicator, 200);
  }
  function hideDropIndicator() {
    els.dropOverlay.classList.remove('active');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }
  function hasFileDrag(e) {
    return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  }

  window.addEventListener('dragover', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    if (els.libraryView.classList.contains('active')) showDropIndicator();
  });
  window.addEventListener('dragleave', (e) => {
    // Only reset when the drag actually leaves the window (relatedTarget is null).
    if (!e.relatedTarget) hideDropIndicator();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    hideDropIndicator();
    if (els.libraryView.classList.contains('active') && e.dataTransfer && e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Save progress and pause the reading timer when the tab loses focus; resume
  // when it becomes visible again, provided the reader view is still open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      rsvp.pause();
      setPlayIcon(false);
      pauseReadingTimer();
      flushSave();
    } else if (document.visibilityState === 'visible') {
      if (els.readerView.classList.contains('active') && currentBookId) {
        startReadingTimer();
      }
    }
  });
  window.addEventListener('pagehide', () => { pauseReadingTimer(); flushSave(); });
  window.addEventListener('beforeunload', () => { pauseReadingTimer(); flushSave(); });

  // ---------- Theme selector ----------
  // Four themes, chosen via a dropdown menu on each `.theme-select` wrapper.
  // The inline script in <head> sets data-theme on initial load (saved pref
  // or system preference). Here we wire up menus + system-follow behavior.
  const THEMES = ['dark', 'light', 'pastel-dark', 'pastel-light'];

  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    return THEMES.indexOf(t) >= 0 ? t : 'dark';
  }
  function applyTheme(theme, persist) {
    if (THEMES.indexOf(theme) < 0) return;
    document.documentElement.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem('theme', theme); } catch (_) {}
    }
    markActiveThemeOption();
  }
  function markActiveThemeOption() {
    const t = currentTheme();
    document.querySelectorAll('.theme-panel [data-theme-value]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeValue === t);
    });
  }

  function closeAllThemePanels(except) {
    document.querySelectorAll('.theme-panel').forEach((panel) => {
      if (panel === except) return;
      panel.hidden = true;
      const toggle = panel.parentElement && panel.parentElement.querySelector('.theme-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.querySelectorAll('.theme-select').forEach((wrap) => {
    const toggle = wrap.querySelector('.theme-toggle');
    const panel = wrap.querySelector('.theme-panel');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = panel.hidden;
      closeAllThemePanels(panel);
      panel.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) markActiveThemeOption();
    });

    panel.querySelectorAll('[data-theme-value]').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        applyTheme(opt.dataset.themeValue, true);
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  });

  document.addEventListener('click', () => closeAllThemePanels(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllThemePanels(null);
  });

  const mql = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem('theme'); } catch (_) {}
      if (THEMES.indexOf(saved) < 0) {
        applyTheme(e.matches ? 'light' : 'dark', false);
      }
    });
  }

  markActiveThemeOption();

  // ---------- Boot ----------
  renderLibrary();
})();
