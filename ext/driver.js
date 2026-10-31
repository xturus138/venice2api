// DOM driver for the chat page. No chrome.* APIs here, so it can be tested on a plain page.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class CancelledError extends Error {}

  class VeniceDriver {
    constructor(selectors, opts = {}) {
      this.sel = selectors;
      this.stableMs = opts.stableMs ?? 3000;
      this.appearTimeoutMs = opts.appearTimeoutMs ?? 120000;
      this.maxReplyMs = opts.maxReplyMs ?? 9 * 60 * 1000;
      this.pollMs = opts.pollMs ?? 400;
      this.cancelled = false;
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

    async waitFor(fn, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        this.check();
        const v = fn();
        if (v) return v;
        await sleep(this.pollMs);
      }
      return null;
    }

    messages() {
      return this.qa(this.sel.assistantMessage);
    }

    isGenerating() {
      return !!this.firstVisible(this.sel.stopButton);
    }

    // Text of a reply without the excluded parts (e.g. the thinking block).
    extract(el) {
      if (!el) return '';
      let text = el.innerText ?? el.textContent ?? '';
      for (const x of this.qa(this.sel.excludeInMessage, el)) {
        const t = x.innerText ?? x.textContent ?? '';
        if (t) text = text.replace(t, '');
      }
      return text.trim();
    }

    lastReplyText() {
      const m = this.messages();
      return this.extract(m[m.length - 1]);
    }

    setInput(el, text) {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      // contenteditable editors (ProseMirror, Lexical, ...)
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }

    async submit(el) {
      const btn = await this.waitFor(() => {
        const b = this.firstVisible(this.sel.sendButton);
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, 5000);
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

    // Send one message and wait for the complete reply.
    async ask(text, { newChat = false, modelPattern = '' } = {}) {
      this.cancelled = false;
      if (newChat) await this.newChat();
      const model = await this.ensureModel(modelPattern);
      if (!model.ok) throw new Error(`kunci model gagal: ${model.reason}`);
      if (this.isGenerating()) throw new Error('model masih menjawab pesan sebelumnya');

      const input = this.firstVisible(this.sel.input);
      if (!input) throw new Error('kotak input tidak ditemukan (selector "input")');
      const before = this.messages().length;
      this.setInput(input, text);
      await sleep(250);
      await this.submit(input);

      const appeared = await this.waitFor(() => this.messages().length > before, this.appearTimeoutMs);
      if (!appeared) throw new Error('balasan tidak muncul (cek selector "assistantMessage")');

      const start = Date.now();
      let last = '';
      let stableSince = Date.now();
      while (true) {
        this.check();
        const t = this.lastReplyText();
        if (t !== last) {
          last = t;
          stableSince = Date.now();
        }
        if (t && !this.isGenerating() && Date.now() - stableSince >= this.stableMs) {
          return { text: t, model: model.model };
        }
        if (Date.now() - start > this.maxReplyMs) throw new Error('balasan tidak selesai dalam batas waktu');
        await sleep(this.pollMs);
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
  globalThis.vbSelectorCandidates = candidates;
})();
