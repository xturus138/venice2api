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
