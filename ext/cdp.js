// Chrome DevTools Protocol input helpers.
//
// The plan builders are PURE (no chrome.*), so they are unit-testable in node. CdpSession
// drives a debugger-like transport that is injected, so its attach/detach/watchdog/fallback
// logic is testable with a fake. The real chrome.debugger wrapper lives in background.js.
//
// Loaded as a classic script (globalThis) in the service worker via importScripts, and
// imported for its side effect in node tests (then read off globalThis.VeniceCDP).
(() => {
  const TYPE_THRESHOLD = 2000; // chars typed key-by-key; the rest goes in one insertText

  // Randomize ms within ±factor, never below floor. factor 0 = exact (deterministic tests).
  function jittered(ms, factor, floor = 0, rng = Math.random) {
    if (!factor || ms <= 0) return ms;
    return Math.max(floor, ms + (rng() * 2 - 1) * ms * factor);
  }

  function virtualKeyCode(ch) {
    // Derived from the character code; letters map to their uppercase code (the Windows VK
    // convention), digits to their ASCII code. The `text` field is what actually inserts the
    // character, so punctuation VK is best-effort.
    return ch.toUpperCase().charCodeAt(0);
  }

  function keyCommandsForChar(ch) {
    // dispatchKeyEvent does not type a newline correctly; insertText does.
    if (ch === '\n' || ch === '\r') return [{ method: 'Input.insertText', params: { text: '\n' } }];
    const vk = virtualKeyCode(ch);
    const base = { text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    return [
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...base } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } },
    ];
  }

  // Type the first `threshold` chars key-by-key; insert any remainder in one command.
  function buildTypingPlan(text, { threshold = TYPE_THRESHOLD } = {}) {
    const plan = [];
    const typed = [...String(text)];
    for (let i = 0; i < Math.min(typed.length, threshold); i++) plan.push(...keyCommandsForChar(typed[i]));
    const rest = typed.slice(threshold).join('');
    if (rest) plan.push({ method: 'Input.insertText', params: { text: rest } });
    return plan;
  }

  function buildClickPlan(x, y) {
    const at = { x, y, button: 'left', clickCount: 1 };
    return [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, buttons: 0 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...at, buttons: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...at, buttons: 0 } },
    ];
  }

  function buildEnterPlan() {
    const k = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter' };
    return [
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...k } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'char', ...k } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...k } },
    ];
  }

  const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

  // Owns one debugger attachment to a single tab. dbg is { attach(tabId,ver), detach(tabId),
  // sendCommand(tabId,method,params) } returning promises.
  class CdpSession {
    constructor({ dbg, typeDelayMs = 35, typeJitter = 0.5, watchdogMs = 30000, sleep = sleepReal, now = Date.now, rng = Math.random } = {}) {
      this.dbg = dbg;
      this.typeDelayMs = typeDelayMs;
      this.typeJitter = typeJitter;
      this.watchdogMs = watchdogMs;
      this.sleep = sleep;
      this.now = now;
      this.rng = rng;
      this.tabId = null;
      this.lastCmdAt = 0;
    }

    get attached() {
      return this.tabId != null;
    }

    // Returns true if attached, false if the debugger is unavailable (caller should fall back
    // to synthetic input rather than failing the job).
    async attach(tabId) {
      if (this.tabId === tabId) return true;
      if (this.tabId != null) await this.detach('reattach');
      try {
        await this.dbg.attach(tabId, '1.3');
      } catch (e) {
        this.lastError = String((e && e.message) || e);
        return false;
      }
      this.tabId = tabId;
      this.lastCmdAt = this.now();
      return true;
    }

    async detach(_reason) {
      const tab = this.tabId;
      if (tab == null) return;
      this.tabId = null;
      try {
        await this.dbg.detach(tab);
      } catch {
        /* already gone */
      }
    }

    // The debugger was detached by something else (tab closed, DevTools opened). Just forget
    // it; never surface this as a user error.
    handleExternalDetach(tabId) {
      if (tabId == null || tabId === this.tabId) this.tabId = null;
    }

    // Called on a timer; drops an attachment that has sat idle too long so it never blocks
    // the user's DevTools.
    checkWatchdog(nowMs = this.now()) {
      if (this.tabId != null && nowMs - this.lastCmdAt > this.watchdogMs) {
        this.detach('watchdog');
        return true;
      }
      return false;
    }

    async _send(cmd) {
      if (this.tabId == null) throw new Error('debugger tidak terpasang');
      this.lastCmdAt = this.now();
      await this.dbg.sendCommand(this.tabId, cmd.method, cmd.params || {});
    }

    async _runPlan(plan, { delayAfterKeyUp = false } = {}) {
      for (let i = 0; i < plan.length; i++) {
        const cmd = plan[i];
        try {
          await this._send(cmd);
        } catch (e) {
          // Report how far we got so the caller can finish via the synthetic path.
          return { ok: false, done: i, error: String((e && e.message) || e) };
        }
        if (delayAfterKeyUp && cmd.method === 'Input.dispatchKeyEvent' && cmd.params.type === 'keyUp') {
          await this.sleep(jittered(this.typeDelayMs, this.typeJitter, 8, this.rng));
        }
      }
      return { ok: true, done: plan.length };
    }

    async type(text) {
      return this._runPlan(buildTypingPlan(text), { delayAfterKeyUp: true });
    }

    async click(x, y) {
      return this._runPlan(buildClickPlan(x, y));
    }

    async enter() {
      return this._runPlan(buildEnterPlan());
    }
  }

  globalThis.VeniceCDP = { buildTypingPlan, buildClickPlan, buildEnterPlan, jittered, virtualKeyCode, CdpSession, TYPE_THRESHOLD };
})();
