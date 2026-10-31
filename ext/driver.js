// DOM driver for the chat page. No chrome.* APIs here, so it can be tested on a plain page.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Randomize a delay within ms*(1 ± factor), never below floor. factor 0 = no jitter.
  function jittered(ms, factor, floor = 0) {
    if (!factor || ms <= 0) return ms;
    return Math.max(floor, ms + (Math.random() * 2 - 1) * ms * factor);
  }

  class CancelledError extends Error {}

  // A web-UI obstacle the user must clear by hand. code is one of blocked|limit|loggedout.
  class BlockerError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class VeniceDriver {
    constructor(selectors, opts = {}) {
      this.sel = selectors;
      this.stableMs = opts.stableMs ?? 3000;
      this.appearTimeoutMs = opts.appearTimeoutMs ?? 120000;
      this.maxReplyMs = opts.maxReplyMs ?? 9 * 60 * 1000;
      this.pollMs = opts.pollMs ?? 400;
      this.pollJitter = opts.pollJitter ?? 0.25; // 0 = deterministic (tests)
      this.cancelled = false;
      this.trusted = null; // real-input transport, set per ask()
    }

    nextPoll() {
      return jittered(this.pollMs, this.pollJitter, 100);
    }

    qa(selector, root = document) {
      if (!selector) return [];
      try {
        return [...root.querySelectorAll(selector)];
      } catch {
        return [];
      }
    }

    visible(el) {
      return !!el && el.isConnected && el.getClientRects().length > 0;
    }

    firstVisible(selector) {
      return this.qa(selector).find((e) => this.visible(e)) || null;
    }

    check() {
      if (this.cancelled) throw new CancelledError('dibatalkan');
    }

    // onPoll runs once per iteration and may throw (used for blocker detection).
    async waitFor(fn, timeoutMs, onPoll) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        this.check();
        if (onPoll) onPoll();
        const v = fn();
        if (v) return v;
        await sleep(this.nextPoll());
      }
      return null;
    }

    // Single-poll read of a web-UI obstacle, or null. Cheap (a few querySelectors).
    blockerCondition() {
      const captchaIframe = this.qa('iframe').some(
        (f) => this.visible(f) && /challenges\.cloudflare|captcha/i.test(f.getAttribute('src') || ''),
      );
      if (captchaIframe || this.firstVisible(this.sel.blockerSelector)) return 'blocked';
      if (this.firstVisible(this.sel.limitSelector)) return 'limit';
      // Logout: the input is gone but a reply is still on screen. If there are no messages
      // (e.g. a fresh chat just cleared), do not treat it as logout.
      if (!this.firstVisible(this.sel.input) && this.messages().length > 0) return 'loggedout';
      return null;
    }

    // Returns a watcher that throws a BlockerError only after the SAME condition is seen on
    // two consecutive polls, to avoid reacting to a transient flicker.
    blockerWatch() {
      let last = null;
      let streak = 0;
      const messages = {
        blocked: 'Venice menampilkan CAPTCHA atau verifikasi. Selesaikan manual di tab ini, lalu jalankan "resume".',
        limit: 'Venice menampilkan batas penggunaan atau ajakan upgrade. Tangani manual di tab ini, lalu jalankan "resume".',
        loggedout: 'Sesi Venice tampaknya logout (kotak input hilang). Login lagi di tab ini, lalu jalankan "resume".',
      };
      return () => {
        const c = this.blockerCondition();
        if (c && c === last) streak += 1;
        else streak = c ? 1 : 0;
        last = c;
        if (c && streak >= 2) throw new BlockerError(c, messages[c]);
      };
    }

    messages() {
      return this.qa(this.sel.assistantMessage);
    }

    isGenerating() {
      return !!this.firstVisible(this.sel.stopButton);
    }

    // Text of a reply with the excluded parts (e.g. the thinking block) removed by
    // POSITION, not by string replace — so text that merely repeats in the answer stays.
    extract(el) {
      if (!el) return '';
      const excluded = this.qa(this.sel.excludeInMessage, el);
      if (!excluded.length) return (el.innerText ?? el.textContent ?? '').trim();
      // Clone, drop the excluded subtrees, then read innerText off-screen so code-block
      // newlines are preserved (textContent would collapse them and break SEARCH/REPLACE).
      const clone = el.cloneNode(true);
      // Match the whole selector against the clone (not split on commas, which would
      // break :is()/:not() groups), then drop the matched subtrees.
      for (const x of this.qa(this.sel.excludeInMessage, clone)) x.remove();
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap;';
      holder.appendChild(clone);
      document.body.appendChild(holder);
      try {
        return (clone.innerText ?? clone.textContent ?? '').trim();
      } finally {
        holder.remove();
      }
    }

    lastReplyText() {
      const m = this.messages();
      return this.extract(m[m.length - 1]);
    }

    inputValue(el) {
      return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : (el.innerText ?? el.textContent ?? '');
    }

    holdsText(el, text) {
      const expect = text.replace(/\r\n/g, '\n').trimEnd();
      return this.inputValue(el).replace(/\r\n/g, '\n').trimEnd() === expect;
    }

    clearInput(el) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand && document.execCommand('delete');
    }

    // Primary path: real key events via the debugger (this.trusted). Falls back to the
    // synthetic path when trusted input is off, attach failed, or the editor stayed empty.
    async setInput(el, text) {
      el.focus();
      if (this.trusted) {
        try {
          this.clearInput(el);
          const r = el.getBoundingClientRect();
          await this.trusted.click(r.left + r.width / 2, r.top + r.height / 2);
          await this.trusted.type(text);
          if (this.holdsText(el, text)) return;
        } catch {
          /* fall through to synthetic for the whole field */
        }
      }
      this.setInputSynthetic(el, text);
    }

    // Fill the message box with synthetic events and VERIFY it holds the text. Rich editors
    // (ProseMirror, Lexical) ignore naive writes, which otherwise sends an empty prompt.
    setInputSynthetic(el, text) {
      el.focus();
      const holds = () => this.holdsText(el, text);

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (!holds()) throw new Error('kotak input tidak terisi dengan benar');
        return;
      }

      // contenteditable: execCommand('insertText') is the one path rich editors reliably
      // accept. Clear first, insert, then fall back to a paste event, and verify.
      this.clearInput(el);
      document.execCommand && document.execCommand('insertText', false, text);
      if (!holds()) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch { /* DataTransfer unavailable */ }
      }
      if (!holds()) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      if (!holds()) throw new Error('editor tidak menerima teks (cek selector "input"; editor rich text mungkin menolak penulisan otomatis)');
    }

    async submit(el) {
      const btn = await this.waitFor(() => {
        const b = this.firstVisible(this.sel.sendButton);
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, 5000);
      if (this.trusted) {
        try {
          if (btn) {
            const r = btn.getBoundingClientRect();
            await this.trusted.click(r.left + r.width / 2, r.top + r.height / 2);
          } else {
            el.focus();
            await this.trusted.enter();
          }
          return;
        } catch {
          /* fall through to synthetic */
        }
      }
      if (btn) {
        btn.click();
        return;
      }
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    async newChat() {
      const btn = this.firstVisible(this.sel.newChatButton);
      if (!btn) throw new Error('tombol chat baru tidak ditemukan (selector "newChatButton")');
      btn.click();
      await this.waitFor(() => this.messages().length === 0 && this.firstVisible(this.sel.input), 15000);
      await sleep(800);
    }

    async ensureModel(pattern) {
      if (!pattern) return { ok: true, model: '' };
      const re = new RegExp(pattern, 'i');
      const read = () => (this.firstVisible(this.sel.modelLabel)?.innerText || '').trim();
      let label = read();
      if (!this.firstVisible(this.sel.modelLabel)) return { ok: false, reason: 'label model tidak ditemukan (selector "modelLabel")' };
      if (re.test(label)) return { ok: true, model: label };

      this.firstVisible(this.sel.modelLabel).click();
      const option = await this.waitFor(
        () => this.qa(this.sel.modelOption).find((o) => this.visible(o) && re.test(o.innerText || '')),
        5000,
      );
      if (!option) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: false, reason: `model aktif "${label}" tidak cocok /${pattern}/i dan tidak ada pilihan yang cocok di picker` };
      }
      option.click();
      await sleep(1000);
      label = read();
      return re.test(label) ? { ok: true, model: label } : { ok: false, reason: `setelah memilih, model masih "${label}"` };
    }

    // Send one message and wait for the complete reply. `trusted` is the real-input transport
    // (type/click/enter via the debugger) or null for the synthetic path.
    async ask(text, { newChat = false, modelPattern = '', trusted = null } = {}) {
      this.cancelled = false;
      this.trusted = trusted;
      if (newChat) await this.newChat();
      const model = await this.ensureModel(modelPattern);
      if (!model.ok) throw new Error(`kunci model gagal: ${model.reason}`);
      if (this.isGenerating()) throw new Error('model masih menjawab pesan sebelumnya');

      const input = this.firstVisible(this.sel.input);
      if (!input) throw new Error('kotak input tidak ditemukan (selector "input")');
      const before = this.messages().length;
      await this.setInput(input, text); // throws if the box did not actually take the text
      await sleep(250);
      await this.submit(input);

      // Watch for a blocker while waiting for the reply to appear: a CAPTCHA, a limit modal,
      // or a logout is the usual reason nothing shows up, and it should fail clearly (with a
      // code) rather than time out blaming the assistantMessage selector.
      const watch = this.blockerWatch();
      const appeared = await this.waitFor(() => this.messages().length > before, this.appearTimeoutMs, watch);
      if (!appeared) throw new Error('balasan tidak muncul dalam batas waktu (model mungkin lama, atau selector "assistantMessage" salah)');

      return this.awaitComplete(model.model, watch);
    }

    // Wait for the reply to finish. The stop button alone is fragile: if its selector is
    // wrong, isGenerating() is always false and a half-written reply looks done. So we also
    // require the text to stop changing, and we remember whether we EVER saw generation.
    async awaitComplete(model, watch = this.blockerWatch()) {
      const start = Date.now();
      let last = '';
      let stableSince = Date.now();
      let everGenerated = false;
      while (true) {
        this.check();
        watch(); // throws a BlockerError if a blocker holds across two polls
        const generating = this.isGenerating();
        if (generating) everGenerated = true;
        const t = this.lastReplyText();
        if (t !== last) {
          last = t;
          stableSince = Date.now();
        }
        const stableFor = Date.now() - stableSince;
        // If the stop button never showed, we cannot trust it — demand a longer quiet period.
        const need = everGenerated ? this.stableMs : this.stableMs * 3;
        if (t && !generating && stableFor >= need) {
          return { text: t, model, sawStopButton: everGenerated };
        }
        if (Date.now() - start > this.maxReplyMs) throw new Error('balasan tidak selesai dalam batas waktu');
        await sleep(this.nextPoll());
      }
    }

    // Match counts per selector, for calibration.
    test() {
      const out = {};
      for (const [key, sel] of Object.entries(this.sel)) {
        const all = this.qa(sel);
        out[key] = { total: all.length, visible: all.filter((e) => this.visible(e)).length };
      }
      out.lastReplyPreview = this.lastReplyText().slice(0, 120);
      return out;
    }
  }

  // Build candidate selectors for a clicked element and its ancestors (calibration helper).
  function candidates(el, depth = 6) {
    const looksHashed = (s) => /\d{3,}|^css-|^sc-|^_|__[a-z0-9]{5,}$|^[a-z]{1,3}-[a-z0-9]{6,}$/i.test(s);
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
    const out = [];
    for (let node = el, d = 0; node && node.nodeType === 1 && d < depth; node = node.parentElement, d++) {
      const tag = node.tagName.toLowerCase();
      const list = [];
      if (node.id && !looksHashed(node.id)) list.push(`#${esc(node.id)}`);
      for (const attr of node.getAttributeNames()) {
        if (/^data-(?!v-|reactid)/.test(attr) || attr === 'role' || attr === 'aria-label' || attr === 'type') {
          const v = node.getAttribute(attr);
          if (v && v.length < 60 && !looksHashed(v)) list.push(`${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`);
        }
      }
      const classes = [...node.classList].filter((c) => !looksHashed(c) && !c.includes(':')).slice(0, 2);
      if (classes.length) list.push(`${tag}.${classes.map(esc).join('.')}`);
      for (const s of list) {
        let n = 0;
        try {
          n = document.querySelectorAll(s).length;
        } catch {
          continue;
        }
        out.push({ selector: s, matches: n, depth: d });
      }
    }
    return out;
  }

  globalThis.VeniceDriver = VeniceDriver;
  globalThis.VeniceDriver.CancelledError = CancelledError;
  globalThis.VeniceDriver.BlockerError = BlockerError;
  globalThis.vbSelectorCandidates = candidates;
})();
