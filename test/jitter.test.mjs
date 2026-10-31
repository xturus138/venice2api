import test from 'node:test';
import assert from 'node:assert/strict';
import { jittered, loadConfig } from '../config.mjs';

test('jitter factor 0 is deterministic', () => {
  for (let i = 0; i < 50; i++) assert.equal(jittered(1500, 0), 1500);
});

test('jitter factor >0 stays within ms*(1 ± factor), floor respected', () => {
  for (let i = 0; i < 2000; i++) {
    const v = jittered(1000, 0.35);
    assert.ok(v >= 650 && v <= 1350, `out of range: ${v}`);
  }
  // floor: a small base with big factor never goes below the floor
  for (let i = 0; i < 500; i++) assert.ok(jittered(120, 0.9, 100) >= 100);
});

test('jitter of zero/negative base is unchanged', () => {
  assert.equal(jittered(0, 0.5), 0);
});

test('config clamps BRIDGE_DELAY_JITTER to 0..0.9', () => {
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp' }).delayJitter, 0.35);
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_DELAY_JITTER: '5' }).delayJitter, 0.9);
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_DELAY_JITTER: '-1' }).delayJitter, 0);
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_DELAY_JITTER: '0' }).delayJitter, 0);
});
