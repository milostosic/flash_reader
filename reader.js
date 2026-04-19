// RSVP reader: displays words one at a time with a red pivot letter.
// Delay per word is adjusted for length and punctuation to improve readability.

(function () {
  const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
  }

  // Optimal Recognition Point (ORP) — where the eye naturally fixates.
  // Classic Spritz-style table.
  function pivotIndex(word) {
    const len = word.length;
    if (len <= 1) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
  }

  function hasSentenceBreak(word) {
    return /[.!?…]["')\]]*$/.test(word);
  }

  function hasClauseBreak(word) {
    return /[,;:\-\u2014]["')\]]*$/.test(word);
  }

  function hasParagraphBreak(word) {
    return word.includes('\n\n');
  }

  class RSVPReader {
    constructor(opts) {
      this.wordBeforeEl = opts.wordBeforeEl;
      this.wordPivotEl = opts.wordPivotEl;
      this.wordAfterEl = opts.wordAfterEl;
      this.progressEl = opts.progressEl;
      this.progressBarFillEl = opts.progressBarFillEl;
      this.previewEl = opts.previewEl;
      this.previewInnerEl = opts.previewInnerEl;
      this.onProgress = opts.onProgress || (() => {});
      this.onEnd = opts.onEnd || (() => {});

      this.words = [];
      this.position = 0;
      this.wpm = 500;
      this.playing = false;
      this._timer = null;

      // Preview renders the entire text as spans cached in an array for O(1) access.
      this._previewBuilt = false;
      this._previewSpans = null;
      this._lastCurrentIdx = -1;

      if (this.previewEl) {
        // Click-to-seek: delegate clicks from the container to word spans.
        // stopPropagation keeps the reader-stage's click-to-play handler from firing.
        this.previewEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = e.target.closest && e.target.closest('.preview-word');
          if (!target) return;
          const idx = parseInt(target.dataset.idx, 10);
          if (Number.isNaN(idx)) return;
          this.seekTo(idx);
        });
      }
    }

    load(words, position, wpm) {
      this.words = words || [];
      this.position = Math.max(0, Math.min(position || 0, Math.max(0, this.words.length - 1)));
      if (wpm) this.wpm = wpm;
      this._previewBuilt = false;
      this._previewSpans = null;
      this._lastCurrentIdx = -1;
      if (this.previewInnerEl) this.previewInnerEl.innerHTML = '';
      if (this.previewEl) this.previewEl.scrollTop = 0;
      this.renderAt(this.position);
    }

    setWpm(wpm) {
      this.wpm = wpm;
      // If currently playing, let the next scheduled tick use the new speed;
      // reschedule immediately for responsiveness.
      if (this.playing) {
        this._clearTimer();
        this._scheduleNext();
      }
    }

    play() {
      if (this.playing) return;
      if (this.position >= this.words.length) return;
      this.playing = true;
      this._tickStart = null;
      this._tickCount = 0;
      this._scheduleNext();
    }

    pause() {
      this.playing = false;
      this._clearTimer();
    }

    toggle() {
      if (this.playing) this.pause();
      else this.play();
    }

    seek(delta) {
      this.position = Math.max(0, Math.min(this.words.length - 1, this.position + delta));
      this.renderAt(this.position);
      this.onProgress(this.position);
    }

    seekTo(idx) {
      this.position = Math.max(0, Math.min(this.words.length - 1, idx));
      this.renderAt(this.position);
      this.onProgress(this.position);
    }

    _clearTimer() {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    }

    _scheduleNext() {
      this._clearTimer();
      if (!this.playing) return;

      const word = this.words[this.position] || '';
      const baseMs = 60000 / Math.max(60, this.wpm);
      let delay = baseMs;

      // Longer words get a small boost (beyond 8 chars).
      if (word.length > 8) delay *= 1 + (word.length - 8) * 0.04;

      // Pauses at punctuation/paragraphs to let the brain catch up.
      if (hasParagraphBreak(word)) delay *= 2.2;
      else if (hasSentenceBreak(word)) delay *= 1.8;
      else if (hasClauseBreak(word)) delay *= 1.35;

      this._timer = setTimeout(() => {
        this.position++;
        if (this.position >= this.words.length) {
          this.playing = false;
          this.position = this.words.length;
          this.renderAt(this.position - 1);
          this.onProgress(this.position);
          this.onEnd();
          return;
        }
        this.renderAt(this.position);
        this.onProgress(this.position);
        this._logEffectiveWpm();
        this._scheduleNext();
      }, delay);
    }

    // Print the effective tick rate every 2 seconds so we can see whether
    // the slider value actually matches what the RSVP loop is producing.
    _logEffectiveWpm() {
      if (this._tickStart == null) {
        this._tickStart = performance.now();
        this._tickCount = 0;
        return;
      }
      this._tickCount++;
      const elapsed = (performance.now() - this._tickStart) / 1000;
      if (elapsed >= 2) {
        const effective = Math.round((this._tickCount / elapsed) * 60);
        // eslint-disable-next-line no-console
        console.log(
          `[rsvp] target=${this.wpm} wpm  effective=${effective} wpm  ` +
          `ticks=${this._tickCount} in ${elapsed.toFixed(2)}s`
        );
        this._tickStart = performance.now();
        this._tickCount = 0;
      }
    }

    renderAt(idx) {
      const total = this.words.length;
      if (!total) {
        this.wordBeforeEl.textContent = '';
        this.wordPivotEl.textContent = '';
        this.wordAfterEl.textContent = '';
        if (this.progressEl) this.progressEl.textContent = '0%';
        if (this.progressBarFillEl) this.progressBarFillEl.style.width = '0%';
        if (this.previewInnerEl) this.previewInnerEl.innerHTML = '';
        return;
      }

      const safeIdx = Math.max(0, Math.min(idx, total - 1));
      const rawWord = this.words[safeIdx];
      // Collapse embedded paragraph marks before display, but keep them for pacing.
      const word = rawWord.replace(/\n+/g, ' ').trim() || rawWord;

      const pIdx = pivotIndex(word);
      this.wordBeforeEl.textContent = word.slice(0, pIdx);
      this.wordPivotEl.textContent = word[pIdx] || '';
      this.wordAfterEl.textContent = word.slice(pIdx + 1);

      const pct = total ? (safeIdx / total) * 100 : 0;
      if (this.progressEl) this.progressEl.textContent = Math.round(pct) + '%';
      if (this.progressBarFillEl) this.progressBarFillEl.style.width = pct.toFixed(2) + '%';

      // Throttle preview updates to ~10 Hz. At 1000 wpm we'd otherwise try to
      // relayout the 300K-node preview DOM 16× per second, which is what the
      // Performance panel was flagging as forced-reflow. Users can't track
      // the preview visually at that speed anyway — 10 Hz is plenty.
      this._pendingPreviewIdx = safeIdx;
      if (this._previewTimeoutId != null) return;
      const now = performance.now();
      const elapsed = now - (this._lastPreviewTime || 0);
      const delay = Math.max(0, 100 - elapsed);
      this._previewTimeoutId = setTimeout(() => {
        this._previewTimeoutId = null;
        this._lastPreviewTime = performance.now();
        this.renderPreview(this._pendingPreviewIdx);
      }, delay);
    }

    renderPreview(safeIdx) {
      if (!this.previewInnerEl || !this.previewEl) return;
      const total = this.words.length;
      if (!total) {
        this.previewInnerEl.innerHTML = '';
        this._previewBuilt = false;
        this._previewSpans = null;
        return;
      }

      // Build the entire text once, but grouped into chunks so Chrome can
      // skip style/layout/paint for off-screen chunks via content-visibility.
      // Only the chunks near the viewport do meaningful rendering work.
      if (!this._previewBuilt) {
        const CHUNK = 100;
        const parts = [];
        let chunkHtml = '';
        for (let i = 0; i < total; i++) {
          const raw = this.words[i];
          const text = raw.replace(/\n+/g, ' ').trim() || raw;
          chunkHtml += '<span class="preview-word" data-idx="' + i + '">' + escapeHtml(text) + '</span> ';
          if ((i + 1) % CHUNK === 0 || i === total - 1) {
            parts.push('<div class="preview-chunk">' + chunkHtml + '</div>');
            chunkHtml = '';
          }
        }
        this.previewInnerEl.innerHTML = parts.join('');
        this._previewSpans = this.previewInnerEl.getElementsByClassName('preview-word');
        this._containerH = this.previewEl.clientHeight;
        this._previewBuilt = true;
        this._lastCurrentIdx = -1;
      }

      const nextEl = this._previewSpans[safeIdx];
      if (!nextEl) return;

      // With content-visibility, we can't rely on pre-cached offsets (chunks
      // off-screen have placeholder sizes). Read offsetTop live; bounded by
      // `contain: layout` on .text-preview, the layout work stays cheap.
      if (this._containerH > 0) {
        const wordTop = nextEl.offsetTop;
        const wordH = nextEl.offsetHeight;
        this.previewEl.scrollTop = wordTop - this._containerH / 2 + wordH / 2;
      }

      // Highlight toggle — paint-only with the current style, no invalidation.
      if (this._lastCurrentIdx >= 0 && this._lastCurrentIdx !== safeIdx) {
        const prev = this._previewSpans[this._lastCurrentIdx];
        if (prev) prev.classList.remove('current');
      }
      if (this._lastCurrentIdx !== safeIdx) nextEl.classList.add('current');
      this._lastCurrentIdx = safeIdx;
    }

    // Called when the viewport changes so the cached container height stays
    // correct. With content-visibility chunking we no longer pre-measure
    // every span; the hot path reads offsetTop live on only the current word.
    remeasurePreview() {
      requestAnimationFrame(() => {
        if (this.previewEl) this._containerH = this.previewEl.clientHeight;
      });
    }
  }

  window.FlashReaderRSVP = RSVPReader;
})();
