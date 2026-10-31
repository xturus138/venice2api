import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WsBrain } from '../daemon.mjs';

const TOKEN = 'a'.repeat(48);
const ORIGIN = 'chrome-extension://abcdefghijklmnop';

function open(port, { token = TOKEN, origin = ORIGIN } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { origin });
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
}

test('rejects wrong origin and wrong token; relays send/reply and stop', async () => {
  const port = 18765 + Math.floor(Math.random() * 1000);
  let stopped = null;
  const brain = new WsBrain({ port, token: TOKEN, replyTimeoutMs: 5000, onStop: (w) => (stopped = w) });
  await brain.listen();
  try {
    assert.equal((await open(port, { origin: 'https://evil.example' })).ok, false);
    assert.equal((await open(port, { token: 'b'.repeat(48) })).ok, false);
    assert.equal((await open(port, { token: 'short' })).ok, false);

    const { ok, ws } = await open(port);
    assert.equal(ok, true);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'send') ws.send(JSON.stringify({ type: 'reply', id: msg.id, ok: true, text: `echo:${msg.text}:${msg.modelPattern}`, model: 'DeepSeek' }));
    });
    ws.send(JSON.stringify({ type: 'hello', tabReady: true }));
    const r = await brain.send('hi', { modelPattern: 'deepseek' });
    assert.deepEqual(r, { text: 'echo:hi:deepseek', model: 'DeepSeek' });

    ws.send(JSON.stringify({ type: 'stop' }));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(stopped, 'tombol Stop di panel');
    ws.close();
  } finally {
    brain.close();
  }
});

test('token via subprotocol works and is kept out of the URL', async () => {
  const port = 17000 + Math.floor(Math.random() * 1000);
  const brain = new WsBrain({ port, token: TOKEN, replyTimeoutMs: 5000 });
  await brain.listen();
  try {
    const sub = (protocols) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols, { origin: ORIGIN });
      ws.on('open', () => resolve({ ok: true, ws }));
      ws.on('error', () => resolve({ ok: false }));
    });
    const good = await sub(['venice-bridge', TOKEN]);
    assert.equal(good.ok, true);
    good.ws?.close();
    assert.equal((await sub(['venice-bridge', 'b'.repeat(48)])).ok, false);
  } finally {
    brain.close();
  }
});

test('cancel before any extension connects rejects a pending send (no hang)', async () => {
  const port = 17500 + Math.floor(Math.random() * 1000);
  const brain = new WsBrain({ port, token: TOKEN, replyTimeoutMs: 600000 });
  await brain.listen();
  try {
    const p = brain.send('hi');
    brain.cancel('Ctrl+C');
    await assert.rejects(p, /Ctrl\+C/);
  } finally {
    brain.close();
  }
});

test('tab closing while waiting rejects the pending reply (no hang)', async () => {
  const port = 17800 + Math.floor(Math.random() * 1000);
  const brain = new WsBrain({ port, token: TOKEN, replyTimeoutMs: 600000 });
  await brain.listen();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, ['venice-bridge', TOKEN], { origin: ORIGIN });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', tabReady: true }));
    await new Promise((r) => setTimeout(r, 80));
    const p = brain.send('hi');
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify({ type: 'tab', tabReady: false }));
    await assert.rejects(p, /ditutup|dimuat ulang/);
    ws.close();
  } finally {
    brain.close();
  }
});
