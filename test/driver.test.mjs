import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseReply } from '../protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

test('driver sends, waits for streaming to finish, ignores thinking block, locks model', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(here, 'fixtures/fake-chat.html'));
    await page.addScriptTag({ path: path.join(here, '../ext/selectors.js') });
    await page.addScriptTag({ path: path.join(here, '../ext/driver.js') });

    const result = await page.evaluate(async () => {
      const sel = { ...globalThis.VB_DEFAULT_SELECTORS, modelLabel: '#model', newChatButton: '#new' };
      const d = new globalThis.VeniceDriver(sel, { stableMs: 500, pollMs: 100 });
      const first = await d.ask('hello there', { newChat: true, modelPattern: 'deepseek' });
      const second = await d.ask('second message');
      const cands = globalThis.vbSelectorCandidates(document.querySelector('[data-role=assistant] p'));
      return { first, second, received: window.received, test: d.test(), cands };
    });

    assert.deepEqual(result.received, ['hello there', 'second message']);
    assert.match(result.first.model, /DeepSeek/);
    assert.doesNotMatch(result.first.text, /Thinking|fs_list/);
    assert.match(result.first.text, /I will read the file now\./);
    const r = parseReply(result.first.text);
    assert.equal(r.kind, 'tool');
    assert.deepEqual(r.args, { path: '11.js' });
    assert.equal(parseReply(result.second.text).args.path, '14.js');
    assert.equal(result.test.assistantMessage.total, 2);
    assert.ok(result.cands.some((c) => c.selector === 'div[data-role="assistant"]' && c.matches === 2));
  } finally {
    await browser.close();
  }
});

async function withBlockerPage(scenario, selectorsOverride = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(here, 'fixtures/fake-chat-blocker.html'));
  await page.addScriptTag({ path: path.join(here, '../ext/selectors.js') });
  await page.addScriptTag({ path: path.join(here, '../ext/driver.js') });
  const result = await page.evaluate(async ({ scenario, selectorsOverride }) => {
    window.vbScenario = scenario;
    const sel = { ...globalThis.VB_DEFAULT_SELECTORS, ...selectorsOverride };
    const d = new globalThis.VeniceDriver(sel, { stableMs: 300, pollMs: 60, pollJitter: 0, appearTimeoutMs: 8000, maxReplyMs: 8000 });
    try {
      const r = await d.ask('go', { modelPattern: '' });
      return { ok: true, text: r.text };
    } catch (e) {
      return { ok: false, code: e.code || null, message: e.message };
    }
  }, { scenario, selectorsOverride });
  await browser.close();
  return result;
}

test('a CAPTCHA appearing mid-reply fails with code "blocked"', { skip: !chromium && 'playwright not installed' }, async () => {
  const r = await withBlockerPage('blocker');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked');
  assert.match(r.message, /resume/);
});

test('the input disappearing mid-reply fails with code "loggedout"', { skip: !chromium && 'playwright not installed' }, async () => {
  const r = await withBlockerPage('loggedout');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'loggedout');
});

test('a blocker that flickers for one poll is ignored (reply still completes)', { skip: !chromium && 'playwright not installed' }, async () => {
  const r = await withBlockerPage('flicker');
  assert.equal(r.ok, true);
  assert.match(r.text, /one two three/);
});

test('blockerWatch needs two consecutive polls and distinguishes codes', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(here, 'fixtures/fake-chat-blocker.html'));
    await page.addScriptTag({ path: path.join(here, '../ext/selectors.js') });
    await page.addScriptTag({ path: path.join(here, '../ext/driver.js') });
    const out = await page.evaluate(() => {
      const d = new globalThis.VeniceDriver(globalThis.VB_DEFAULT_SELECTORS, { pollJitter: 0 });
      const log = document.getElementById('log');
      log.innerHTML = '<div data-role="assistant">hi</div>'; // a message exists
      const watch = d.blockerWatch();
      const results = { condNone: d.blockerCondition() };
      const m = document.createElement('div');
      m.className = 'captcha-modal';
      document.body.appendChild(m);
      results.cond = d.blockerCondition();
      let firstPollThrew = false;
      try { watch(); } catch { firstPollThrew = true; } // streak 1, must NOT throw
      results.firstPollThrew = firstPollThrew;
      let secondCode = null;
      try { watch(); } catch (e) { secondCode = e.code; } // streak 2, must throw
      results.secondCode = secondCode;
      return results;
    });
    assert.equal(out.condNone, null);
    assert.equal(out.cond, 'blocked');
    assert.equal(out.firstPollThrew, false);
    assert.equal(out.secondCode, 'blocked');
  } finally {
    await browser.close();
  }
});

test('trusted transport is used for input when provided, and the reply still parses', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(here, 'fixtures/fake-chat.html'));
    await page.addScriptTag({ path: path.join(here, '../ext/selectors.js') });
    await page.addScriptTag({ path: path.join(here, '../ext/driver.js') });
    const out = await page.evaluate(async () => {
      const sel = { ...globalThis.VB_DEFAULT_SELECTORS, modelLabel: '#model', newChatButton: '#new' };
      const d = new globalThis.VeniceDriver(sel, { stableMs: 400, pollMs: 80, pollJitter: 0, appearTimeoutMs: 6000, maxReplyMs: 8000 });
      const log = [];
      // A fake transport that fills the box (so holdsText passes) and, on click, triggers the
      // real send button so the form actually submits — mimicking a real trusted click.
      const box = document.getElementById('box');
      const trusted = {
        async click(x, y) { log.push(['click', Math.round(x) >= 0]); document.getElementById('send').click(); },
        async type(text) {
          log.push(['type', text]);
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(box, text);
          box.dispatchEvent(new Event('input', { bubbles: true }));
        },
        async enter() { log.push(['enter']); },
      };
      const r = await d.ask('hello trusted', { modelPattern: '', trusted });
      return { log, received: window.received, text: r.text };
    });
    assert.deepEqual(out.received, ['hello trusted']);
    assert.ok(out.log.some(([op, v]) => op === 'type' && v === 'hello trusted'), JSON.stringify(out.log));
    assert.ok(out.log.some(([op]) => op === 'click')); // submit via trusted click on the send button
  } finally {
    await browser.close();
  }
});

test('when the trusted transport fails, input falls back to the synthetic path', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(here, 'fixtures/fake-chat.html'));
    await page.addScriptTag({ path: path.join(here, '../ext/selectors.js') });
    await page.addScriptTag({ path: path.join(here, '../ext/driver.js') });
    const out = await page.evaluate(async () => {
      const sel = { ...globalThis.VB_DEFAULT_SELECTORS, modelLabel: '#model', newChatButton: '#new' };
      const d = new globalThis.VeniceDriver(sel, { stableMs: 400, pollMs: 80, pollJitter: 0 });
      // Transport that never fills the box and throws on click -> driver must fall back.
      const trusted = {
        async click() { throw new Error('cdp click failed'); },
        async type() { /* does nothing: box stays empty */ },
        async enter() { throw new Error('cdp enter failed'); },
      };
      const r = await d.ask('fallback works', { modelPattern: '', trusted });
      return { received: window.received, text: r.text };
    });
    // Despite the broken transport, the synthetic path put the text in and sent it.
    assert.deepEqual(out.received, ['fallback works']);
    assert.match(out.text, /I will read the file now\./);
  } finally {
    await browser.close();
  }
});
