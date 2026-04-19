// File format parsers. Each returns { title, author?, coverBlob?, text }.
// The caller then tokenizes `text` into words and may enrich with online lookup.

(function () {
  async function readFileAsArrayBuffer(file) {
    return await file.arrayBuffer();
  }

  async function readFileAsText(file) {
    return await file.text();
  }

  // Aggressively clean filename stems. Real book names are frequently buried
  // under numbering, parenthesized authors/years/series, version suffixes, and
  // release-group tags — strip them all so the remaining text has a chance of
  // matching an online catalog.
  function parseFilename(filename) {
    let name = filename.replace(/\.[^.]+$/, '');

    // Strip bracketed/parenthesized content entirely — typically author, year, series, edition.
    name = name.replace(/\([^)]*\)/g, ' ');
    name = name.replace(/\[[^\]]*\]/g, ' ');
    name = name.replace(/\{[^}]*\}/g, ' ');

    // Strip version and file-size markers. (Standalone years are deliberately
    // kept — they may be the title itself, e.g. "1984".)
    name = name.replace(/\bv\d+(?:\.\d+)?\b/gi, ' ');
    name = name.replace(/\b\d+(?:\.\d+)?\s*(?:kb|mb|gb)\b/gi, ' ');

    // Strip common ebook-release tags even when unbracketed.
    name = name.replace(/\b(?:retail|ebook|epub|pdf|azw3|mobi|unabridged|uncorrected|proof)\b/gi, ' ');

    // Strip leading numbering like "01. Title" or "1 - Title".
    name = name.replace(/^[\s\-_.]*\d+[\s._\-]+/, ' ');

    // Underscores → spaces.
    name = name.replace(/_/g, ' ');

    // If the name still uses dots between words (no spaces), treat them as separators.
    if (!/\s/.test(name) && /\.[A-Za-z]/.test(name)) {
      name = name.replace(/\./g, ' ');
    }

    // Split camelCase / PascalCase and letter/digit boundaries so things like
    // "HarryPotter1_JKRowling" become "Harry Potter 1 JK Rowling".
    name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
    name = name.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    name = name.replace(/([a-zA-Z])(\d)/g, '$1 $2');
    name = name.replace(/(\d)([a-zA-Z])/g, '$1 $2');

    name = name.replace(/\s+/g, ' ').trim();

    let title = name || 'Untitled';
    let author = '';

    // Pattern: "Author YEAR Title" — common in academic PDFs like
    // "ALLEN_2014_Middle_Egyptian...". We accept if the prefix looks like a
    // short author name (1–3 words, not starting with an article) and the
    // trailing chunk is long enough to plausibly be a title.
    const yearSplit = name.match(/^(.{2,}?)\s+((?:18|19|20)\d{2})\s+(.+)$/);
    if (yearSplit) {
      const pre = yearSplit[1].trim().replace(/[,]+$/, '');
      const post = yearSplit[3].trim();
      const preWords = pre.split(/\s+/).filter(Boolean);
      const startsWithArticle = /^(?:the|a|an|my|this|that|his|her|its|it)\b/i.test(pre);
      if (preWords.length <= 3 && post.length > 10 && !startsWithArticle) {
        return { title: post, author: prettifyAuthor(pre) };
      }
    }

    const byMatch = name.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
      title = byMatch[1].trim();
      author = byMatch[2].trim();
    } else {
      const parts = name.split(/\s+[-–—]\s+/);
      if (parts.length >= 2) {
        title = parts[0].trim();
        author = parts.slice(1).join(' - ').trim();
      }
    }
    return { title, author };
  }

  // Convert ALL-CAPS surnames (common in academic filenames) to Title Case.
  function prettifyAuthor(s) {
    return s
      .split(/\s+/)
      .map((w) => (w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w))
      .join(' ');
  }

  // Heuristic: does this PDF metadata value look like a file-system artifact
  // rather than a real title/author? Word-to-PDF exports routinely leave the
  // source filename here; many drivers leave the creator application name;
  // corporate PDFs often have the company as "Author".
  function looksLikePdfArtifact(s) {
    if (!s) return true;
    const t = s.trim();
    if (t.length < 3) return true;
    if (/\.(doc|docx|pdf|odt|rtf|txt|html?|xml|tex|wpd|indd|pages|epub)$/i.test(t)) return true;
    if (/^(microsoft\s+word|adobe\s+(acrobat|indesign|pdf|distiller)|pdfcreator|openoffice|libreoffice|latex|pdflatex)/i.test(t)) return true;
    if (/^(untitled|document\d*|new\s+document)$/i.test(t)) return true;
    // lowercase-only slug with underscores/dashes is almost always a filename
    if (/^[a-z0-9._\-]+$/.test(t) && t.length < 40) return true;
    return false;
  }

  function guessTitleFromFilename(filename) {
    return parseFilename(filename).title;
  }

  function stripHtml(html) {
    // Remove script/style/svg blocks first.
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // Use DOMParser for robust extraction.
    try {
      const doc = new DOMParser().parseFromString(cleaned, 'text/html');
      // Preserve paragraph-ish breaks by injecting newlines for block elements.
      const blockSelector = 'p, div, br, h1, h2, h3, h4, h5, h6, li, tr, section, article, blockquote';
      doc.querySelectorAll(blockSelector).forEach((el) => {
        el.appendChild(doc.createTextNode('\n'));
      });
      return (doc.body ? doc.body.textContent : doc.textContent) || '';
    } catch (e) {
      return cleaned.replace(/<[^>]+>/g, ' ');
    }
  }

  function normalizeText(text) {
    return text
      .replace(/\u00AD/g, '')        // soft hyphens
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00A0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------- Plain text / markdown ----------
  async function parseText(file) {
    const text = await readFileAsText(file);
    const fn = parseFilename(file.name);
    return { title: fn.title, author: fn.author, text: normalizeText(text) };
  }

  // ---------- HTML ----------
  async function parseHTML(file) {
    const raw = await readFileAsText(file);
    const fn = parseFilename(file.name);
    // <title> in the document is usually a better title than the filename.
    let title = fn.title;
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1].trim()) title = m[1].replace(/\s+/g, ' ').trim();
    return { title, author: fn.author, text: normalizeText(stripHtml(raw)) };
  }

  // ---------- EPUB ----------
  async function parseEPUB(file) {
    if (typeof JSZip === 'undefined') throw new Error('EPUB support not loaded');
    const buf = await readFileAsArrayBuffer(file);
    const zip = await JSZip.loadAsync(buf);

    // Locate the OPF file via META-INF/container.xml.
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Invalid EPUB: missing container.xml');
    const containerXml = await containerFile.async('string');
    const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const rootfileEl = containerDoc.querySelector('rootfile');
    if (!rootfileEl) throw new Error('Invalid EPUB: no rootfile');
    const opfPath = rootfileEl.getAttribute('full-path');
    if (!opfPath) throw new Error('Invalid EPUB: rootfile has no path');

    const opfFile = zip.file(opfPath);
    if (!opfFile) throw new Error('Invalid EPUB: OPF not found');
    const opfXml = await opfFile.async('string');
    const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

    // Title and author from Dublin Core metadata. Using localName is namespace-agnostic.
    const fnParsed = parseFilename(file.name);
    let title = fnParsed.title;
    let author = fnParsed.author;
    const metadataEl = opfDoc.querySelector('metadata');
    if (metadataEl) {
      const creators = [];
      let metaTitle = '';
      for (const child of Array.from(metadataEl.children)) {
        const local = child.localName;
        const txt = (child.textContent || '').trim();
        if (!txt) continue;
        if (local === 'title' && !metaTitle) metaTitle = txt;
        else if (local === 'creator') creators.push(txt);
      }
      if (metaTitle) title = metaTitle;
      if (creators.length) author = creators.join(', ');
    }

    // Build manifest id -> href map (also keep id lookup for cover resolution).
    const manifest = {};
    const manifestById = {};
    opfDoc.querySelectorAll('manifest > item').forEach((item) => {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type') || '';
      const properties = item.getAttribute('properties') || '';
      if (id && href) {
        const entry = { id, href, mediaType, properties };
        manifest[id] = entry;
        manifestById[id] = entry;
      }
    });

    // Reading order from spine.
    const spineItems = [];
    opfDoc.querySelectorAll('spine > itemref').forEach((ref) => {
      const idref = ref.getAttribute('idref');
      if (idref && manifest[idref]) spineItems.push(manifest[idref]);
    });

    // Resolve paths relative to the OPF location.
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const chunks = [];
    for (const item of spineItems) {
      if (!/xhtml|xml|html/i.test(item.mediaType)) continue;
      const path = normalizePath(opfDir + item.href);
      const f = zip.file(path);
      if (!f) continue;
      const html = await f.async('string');
      chunks.push(stripHtml(html));
    }

    // Fallback: if spine gave nothing, grab every HTML-ish file.
    if (!chunks.length) {
      const files = Object.keys(zip.files).filter((n) => /\.x?html?$/i.test(n));
      for (const name of files) {
        const html = await zip.file(name).async('string');
        chunks.push(stripHtml(html));
      }
    }

    // Locate the cover image: EPUB 3 uses properties="cover-image" on a manifest
    // item; EPUB 2 uses <meta name="cover" content="<id>">. Fallback: first image.
    let coverHref = null;
    let coverMediaType = '';
    const propCover = Array.from(opfDoc.querySelectorAll('manifest > item'))
      .find((it) => (it.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
    if (propCover) {
      coverHref = propCover.getAttribute('href');
      coverMediaType = propCover.getAttribute('media-type') || '';
    }
    if (!coverHref) {
      const metaCover = opfDoc.querySelector('metadata > meta[name="cover"]');
      if (metaCover) {
        const id = metaCover.getAttribute('content');
        if (id && manifestById[id]) {
          coverHref = manifestById[id].href;
          coverMediaType = manifestById[id].mediaType;
        }
      }
    }
    if (!coverHref) {
      const firstImg = Array.from(opfDoc.querySelectorAll('manifest > item'))
        .find((it) => (it.getAttribute('media-type') || '').startsWith('image/'));
      if (firstImg) {
        coverHref = firstImg.getAttribute('href');
        coverMediaType = firstImg.getAttribute('media-type') || '';
      }
    }

    let coverBlob = null;
    if (coverHref) {
      const coverPath = normalizePath(opfDir + coverHref);
      const coverFile = zip.file(coverPath);
      if (coverFile) {
        try {
          coverBlob = await coverFile.async('blob');
          if (coverMediaType && coverBlob && coverBlob.type !== coverMediaType) {
            coverBlob = coverBlob.slice(0, coverBlob.size, coverMediaType);
          }
        } catch (_) { /* ignore cover failure */ }
      }
    }

    return { title, author, coverBlob, text: normalizeText(chunks.join('\n\n')) };
  }

  function normalizePath(path) {
    const parts = [];
    path.split('/').forEach((seg) => {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    });
    return parts.join('/');
  }

  // ---------- PDF ----------
  async function parsePDF(file) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF support not loaded');
    const buf = await readFileAsArrayBuffer(file);
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      // Group text items by their vertical position to preserve line breaks.
      let lastY = null;
      let line = [];
      const lines = [];
      for (const item of content.items) {
        if (!item.str) continue;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          lines.push(line.join(''));
          line = [];
        }
        line.push(item.str);
        if (item.hasEOL) {
          lines.push(line.join(''));
          line = [];
          lastY = null;
          continue;
        }
        lastY = y;
      }
      if (line.length) lines.push(line.join(''));
      pages.push(lines.join('\n'));
    }

    // Try to get title/author from PDF metadata, falling back to filename parsing.
    // Most PDFs exported from Word/InDesign have garbage in these fields (the
    // source filename, the export program, the company name). Filter those out
    // before trusting them — a bad title here poisons the online lookup below.
    const fnParsed = parseFilename(file.name);
    let title = fnParsed.title;
    let author = fnParsed.author;
    try {
      const meta = await pdf.getMetadata();
      if (meta && meta.info) {
        const metaTitle = (meta.info.Title || '').trim();
        const metaAuthor = (meta.info.Author || '').trim();
        if (metaTitle && !looksLikePdfArtifact(metaTitle)) {
          title = metaTitle;
          // Only trust the author field when the title was also usable —
          // if the title is junk, the whole info dict is probably garbage
          // (e.g. Author="Micron" on a PDF exported by a Micron employee).
          if (metaAuthor && !looksLikePdfArtifact(metaAuthor)) author = metaAuthor;
        }
      }
    } catch (_) { /* ignore */ }

    // Render the first page to a canvas as a fallback cover.
    let coverBlob = null;
    try {
      coverBlob = await renderFirstPageAsCover(pdf);
    } catch (_) { /* ignore */ }

    return { title, author, coverBlob, text: normalizeText(pages.join('\n\n')) };
  }

  async function renderFirstPageAsCover(pdf) {
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = 240;
    const scale = Math.min(2, targetWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  // ---------- Dispatcher ----------
  async function parseFile(file) {
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();

    if (name.endsWith('.epub') || type === 'application/epub+zip') return parseEPUB(file);
    if (name.endsWith('.pdf') || type === 'application/pdf') return parsePDF(file);
    if (name.endsWith('.html') || name.endsWith('.htm') || type === 'text/html') return parseHTML(file);
    if (name.endsWith('.txt') || name.endsWith('.md') || type.startsWith('text/')) return parseText(file);

    // Fall back to treating it as text.
    return parseText(file);
  }

  // Tokenize parsed text into an array of words suitable for RSVP.
  // Long words with internal hyphens are split so they don't blow past the screen width.
  function tokenize(text) {
    const tokens = [];
    // Split on whitespace, keeping punctuation attached to words.
    const raw = text.split(/\s+/);
    for (let word of raw) {
      if (!word) continue;
      // Split overly long tokens at hyphens or slashes.
      while (word.length > 18) {
        const breakAt = Math.max(
          word.lastIndexOf('-', 15),
          word.lastIndexOf('/', 15),
          word.lastIndexOf('\u2014', 15)
        );
        if (breakAt > 4) {
          tokens.push(word.slice(0, breakAt + 1));
          word = word.slice(breakAt + 1);
        } else {
          tokens.push(word.slice(0, 15) + '-');
          word = word.slice(15);
        }
      }
      tokens.push(word);
    }
    return tokens;
  }

  // Last-resort metadata recovery: scan the opening text of the book for a
  // title and author. Covers three common patterns:
  //   1. Project Gutenberg header: "The Project Gutenberg eBook of X, by Y"
  //   2. Field-style header: "Title: X\nAuthor: Y"
  //   3. Generic prose: "X by Y" where Y is a short run of capitalised words
  function extractTitleAuthorFromText(text) {
    if (!text) return null;
    const head = text.slice(0, 1500);

    // 1. Project Gutenberg.
    const pg = head.match(
      /Project Gutenberg (?:eBook|ebook|EBook|Etext|EText|E-text) of\s+([^,\n\r]{3,200}?)(?:,\s+|\s+)by\s+([^,\n\r.]{3,100}?)(?:[.,\r\n]|$)/i
    );
    if (pg) {
      return { title: pg[1].trim(), author: pg[2].trim() };
    }

    // 2. Labelled header lines (common in text-only ebooks).
    const titleLine = head.match(/(?:^|[\n\r])\s*Title\s*:\s*([^\n\r]{2,200})/i);
    const authorLine = head.match(/(?:^|[\n\r])\s*Author\s*:\s*([^\n\r]{2,120})/i);
    if (titleLine && authorLine) {
      return { title: titleLine[1].trim(), author: authorLine[1].trim() };
    }

    // 2b. Typeset title-page layout where each element sits on its own line:
    //
    //       Poker without
    //       Cards
    //       A Consciousness Thriller
    //       by
    //       Ben Mack
    //       Copyright 2004...
    //
    //     Running line-by-line lets the author capture terminate at the line
    //     break, which keeps trailing "Copyright" / "All Rights Reserved" /
    //     publisher text out of it — the flattened regex below is greedy and
    //     would otherwise swallow them.
    const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length - 1; i++) {
      // Accept "by" alone on the line or trailing another word (e.g.
      // "A Consciousness Thriller by") — both are common when a PDF reflows
      // the title page.
      const byMatch = lines[i].match(/^(?:(.+?)\s+)?(?:by|By|BY)[.,]?\s*$/);
      if (!byMatch) continue;
      const nameMatch = lines[i + 1].match(
        /^([A-Z][A-Za-z.\-']+(?:\s+[A-Z][A-Za-z.\-']*){0,4})\s*[,.]?\s*$/
      );
      if (!nameMatch) continue;
      const author = nameMatch[1].trim();
      const titleParts = lines.slice(0, i);
      if (byMatch[1]) titleParts.push(byMatch[1]);
      const title = cleanExtractedTitle(titleParts.join(' '));
      if (title.length >= 3 && author.length >= 3 &&
          !/^(copyright|©|all rights reserved|published)/i.test(title)) {
        return { title, author };
      }
    }

    // 3. Generic "Title ... by Author" in the opening prose. Normalise the
    //    whitespace first because PDF extraction often preserves every \n.
    const flat = head.replace(/\s+/g, ' ').trim();
    const by = flat.match(
      /^(.{3,250}?)\s+(?:by|By|BY)\s+([A-Z][A-Za-z.\-']+(?:\s+[A-Z][A-Za-z.\-']*){0,4})/
    );
    if (by) {
      let title = cleanExtractedTitle(by[1]);
      let author = by[2].trim().replace(/[.,:;]+$/, '').trim();
      if (!/^(copyright|©|all rights reserved|published)/i.test(title) &&
          title.length >= 3 && author.length >= 3) {
        return { title, author };
      }
    }

    // 4. Author printed with an academic/professional degree or honorific —
    //    very common on title pages that don't use the word "by".
    //    Examples: "Hervey Cleckley, M.D.", "Dr. Carl Sagan", "Jane Smith, Ph.D."
    const degreePattern =
      /([A-Z][a-z'\-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z'\-]+){1,3})\s*,?\s+(?:M\.?\s?D\.?|Ph\.?\s?D\.?|M\.?\s?A\.?|B\.?\s?A\.?|D\.?\s?D\.?\s?S\.?|J\.?\s?D\.?|LL\.?\s?D\.?|Sc\.?\s?D\.?|Esq\.?)\b/;
    const deg = flat.match(degreePattern);
    if (deg) {
      const author = deg[1].trim();
      const authorStart = flat.indexOf(deg[0]);
      if (authorStart > 3) {
        const title = cleanExtractedTitle(flat.slice(0, authorStart));
        if (title.length >= 3) return { title, author };
      }
    }

    return null;
  }

  // Tidy up a raw title chunk pulled from the first page of a book:
  //   - collapse "The Mask of Sanity THE MASK OF SANITY" → "The Mask of Sanity"
  //   - cut at the first natural break (tilde, em-dash) if the remainder looks
  //     like a subtitle we don't need in the search query
  //   - strip trailing punctuation and cap length so the string is usable as
  //     a catalog search term
  function cleanExtractedTitle(raw) {
    let title = raw.replace(/\s+/g, ' ').trim();
    const words = title.split(' ');
    for (let n = Math.floor(words.length / 2); n >= 2; n--) {
      const left = words.slice(0, n).map((w) => w.toLowerCase());
      const right = words.slice(n, n * 2).map((w) => w.toLowerCase());
      if (left.every((w, i) => w === right[i])) {
        title = words.slice(0, n).join(' ');
        break;
      }
    }
    const breakIdx = title.search(/[~\u2014\u2013]/);
    if (breakIdx > 3 && breakIdx < 100) title = title.slice(0, breakIdx).trim();
    title = title.replace(/[.,:;~\-\u2013\u2014]+$/, '').trim();
    if (title.length > 120) title = title.slice(0, 120).trim();
    return title;
  }

  window.FlashReaderParsers = { parseFile, tokenize, parseFilename, extractTitleAuthorFromText };
})();
