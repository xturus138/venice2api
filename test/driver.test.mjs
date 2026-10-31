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
