import test from 'node:test';
import assert from 'node:assert/strict';
import '../ext/cdp.js';

const { buildTypingPlan, buildClickPlan, buildEnterPlan, virtualKeyCode, jittered, CdpSession, TYPE_THRESHOLD } = globalThis.VeniceCDP;

// ---------- pure plan builders ----------

test('buildTypingPlan: keyDown/keyUp per char with correct text and keycodes', () => {
  const plan = buildTypingPlan('aB5.');
  // 4 chars -> 8 key events, no insertText
  assert.equal(plan.length, 8);
  assert.ok(plan.every((c) => c.method === 'Input.dispatchKeyEvent'));
  assert.deepEqual(plan.slice(0, 2).map((c) => c.params.type), ['keyDown', 'keyUp']);
  assert.equal(plan[0].params.text, 'a');
  assert.equal(plan[0].params.windowsVirtualKeyCode, 65); // 'a' -> VK A (65)
  assert.equal(plan[0].params.nativeVirtualKeyCode, 65);
  assert.equal(plan[2].params.windowsVirtualKeyCode, 66); // 'B' -> 66
  assert.equal(plan[4].params.windowsVirtualKeyCode, 53); // '5' -> 53
  assert.equal(plan[4].params.text, '5');
  assert.equal(plan[6].params.text, '.');
});

test('buildTypingPlan: newline becomes insertText, not a key event', () => {
  const plan = buildTypingPlan('a\nb');
  const nl = plan.find((c) => c.method === 'Input.insertText');
  assert.ok(nl);
  assert.equal(nl.params.text, '\n');
  // a (2) + newline insertText (1) + b (2)
  assert.equal(plan.length, 5);
});

test('buildTypingPlan: beyond threshold the remainder is one insertText', () => {
  const text = 'x'.repeat(TYPE_THRESHOLD + 500);
  const plan = buildTypingPlan(text);
  const keyEvents = plan.filter((c) => c.method === 'Input.dispatchKeyEvent');
  const inserts = plan.filter((c) => c.method === 'Input.insertText');
  assert.equal(keyEvents.length, TYPE_THRESHOLD * 2);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params.text.length, 500);
});

test('buildClickPlan: moved, pressed (buttons=1), released', () => {
  const plan = buildClickPlan(10, 20);
  assert.deepEqual(plan.map((c) => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(plan.every((c) => c.method === 'Input.dispatchMouseEvent'));
  assert.equal(plan[1].params.button, 'left');
  assert.equal(plan[1].params.buttons, 1);
  assert.equal(plan[1].params.clickCount, 1);
  assert.equal(plan[2].params.buttons, 0);
  assert.equal(plan[0].params.x, 10);
});

test('buildEnterPlan: keyDown, char, keyUp with \\r and VK 13', () => {
  const plan = buildEnterPlan();
  assert.deepEqual(plan.map((c) => c.params.type), ['keyDown', 'char', 'keyUp']);
  assert.ok(plan.every((c) => c.params.windowsVirtualKeyCode === 13 && c.params.text === '\r'));
});

test('virtualKeyCode maps letters/digits from the character', () => {
  assert.equal(virtualKeyCode('a'), 65);
  assert.equal(virtualKeyCode('Z'), 90);
  assert.equal(virtualKeyCode('0'), 48);
});

test('jittered: factor 0 is exact; a factor stays in range', () => {
  assert.equal(jittered(35, 0), 35);
  for (let i = 0; i < 500; i++) {
    const v = jittered(100, 0.5);
    assert.ok(v >= 50 && v <= 150);
  }
  assert.ok(jittered(10, 0.9, 8) >= 8);
});

// ---------- CdpSession with a fake debugger ----------

function fakeDbg({ failAttach = false, failAt = -1 } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    attach: async () => {
      if (failAttach) throw new Error('Another debugger is already attached');
    },
    detach: async (tabId) => calls.push({ m: 'detach', tabId }),
    sendCommand: async (tabId, method, params) => {
      calls.push({ m: method, type: params?.type });
      if (n++ === failAt) throw new Error('boom');
    },
  };
}

test('attach failure returns false (caller falls back), no throw', async () => {
  const dbg = fakeDbg({ failAttach: true });
  const s = new CdpSession({ dbg, sleep: async () => {} });
  assert.equal(await s.attach(7), false);
  assert.equal(s.attached, false);
  assert.match(s.lastError, /already attached/);
});

test('type runs the whole plan when attached', async () => {
  const dbg = fakeDbg();
  const s = new CdpSession({ dbg, typeJitter: 0, sleep: async () => {} });
  assert.equal(await s.attach(7), true);
  const r = await s.type('hi');
  assert.equal(r.ok, true);
  assert.equal(dbg.calls.filter((c) => c.m === 'Input.dispatchKeyEvent').length, 4);
});

test('a mid-plan CDP error stops and reports how far it got (remainder -> synthetic)', async () => {
  const dbg = fakeDbg({ failAt: 3 });
  const s = new CdpSession({ dbg, typeJitter: 0, sleep: async () => {} });
  await s.attach(7);
  const r = await s.type('abcd'); // 8 key events; fail on the 4th command
  assert.equal(r.ok, false);
  assert.equal(r.done, 3);
  assert.match(r.error, /boom/);
});

test('detach is idempotent and always calls through', async () => {
  const dbg = fakeDbg();
  const s = new CdpSession({ dbg, sleep: async () => {} });
  await s.attach(7);
  await s.detach('x');
  await s.detach('x'); // no-op second time
  assert.equal(dbg.calls.filter((c) => c.m === 'detach').length, 1);
  assert.equal(s.attached, false);
});

test('watchdog detaches an idle attachment', async () => {
  const dbg = fakeDbg();
  let t = 1000;
  const s = new CdpSession({ dbg, watchdogMs: 30000, now: () => t, sleep: async () => {} });
  await s.attach(7);
  assert.equal(s.checkWatchdog(1000 + 10000), false); // 10s idle, fine
  assert.equal(s.checkWatchdog(1000 + 31000), true); // >30s idle -> detach
  assert.equal(s.attached, false);
});

test('external detach is silent and just forgets the tab', async () => {
  const dbg = fakeDbg();
  const s = new CdpSession({ dbg, sleep: async () => {} });
  await s.attach(7);
  s.handleExternalDetach(7);
  assert.equal(s.attached, false);
  // a later command does not call sendCommand on a dead attachment
  const r = await s.type('x');
  assert.equal(r.ok, false);
});
