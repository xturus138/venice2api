import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, AUTONOMY_LEVELS } from '../config.mjs';
import { Store } from '../state.mjs';

// ---------- loadConfig ----------

test('loadConfig applies sensible defaults', () => {
  const c = loadConfig({ BRIDGE_ROOT: '/tmp/x' });
  assert.equal(c.autonomy, 'L1');
  assert.equal(c.shellMode, 'safe');
  assert.equal(c.modelPattern, 'deepseek');
  assert.equal(c.maxExploreSteps, 10);
  assert.equal(c.maxExecSteps, 60);
  assert.equal(c.maxFocus, 4);
  assert.deepEqual(c.shellKeepEnv, []);
  assert.ok(path.isAbsolute(c.root));
});

test('loadConfig rejects an invalid autonomy level', () => {
  assert.throws(() => loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_AUTONOMY: 'L9' }), /L1, L2, atau L3/);
  for (const lvl of AUTONOMY_LEVELS) assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_AUTONOMY: lvl.toLowerCase() }).autonomy, lvl);
});

test('shellMode is only "full" for exactly that value', () => {
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_SHELL: 'full' }).shellMode, 'full');
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_SHELL: 'FULL' }).shellMode, 'full');
  for (const v of ['', 'safe', 'yes', 'true', 'bash', 'fullish']) {
    assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_SHELL: v }).shellMode, 'safe', `BRIDGE_SHELL=${v}`);
  }
});

test('shellKeepEnv parses a comma list and drops blanks', () => {
  assert.deepEqual(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_SHELL_KEEP_ENV: 'A, B ,,C,' }).shellKeepEnv, ['A', 'B', 'C']);
});

test('numeric envs fall back to defaults on junk and honor valid values', () => {
  const junk = loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_MAX_STEPS: 'abc', BRIDGE_PORT: '' });
  assert.equal(junk.maxExecSteps, 60);
  assert.equal(junk.port, 8765);
  const good = loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_MAX_STEPS: '25', BRIDGE_PORT: '9000' });
  assert.equal(good.maxExecSteps, 25);
  assert.equal(good.port, 9000);
});

test('revealEnvKeys is off unless explicitly enabled', () => {
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp' }).revealEnvKeys, false);
  for (const v of ['1', 'true', 'yes']) assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_ENV_KEYS: v }).revealEnvKeys, true);
  assert.equal(loadConfig({ BRIDGE_ROOT: '/tmp', BRIDGE_ENV_KEYS: '0' }).revealEnvKeys, false);
});

// ---------- Store ----------

function store() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-store-')));
}

test('load returns null before anything is saved', () => {
  assert.equal(store().load(), null);
});

test('save then load round-trips and stamps updatedAt', () => {
  const s = store();
  s.save({ phase: 'executing', planStep: 2 });
  const got = s.load();
  assert.equal(got.phase, 'executing');
  assert.equal(got.planStep, 2);
  assert.match(got.updatedAt, /^\d{4}-\d\d-\d\dT/);
});

test('focus defaults to empty and survives a round-trip; non-array is ignored', () => {
  const s = store();
  assert.deepEqual(s.focus(), []);
  s.setFocus(['a.js', 'b.js']);
  assert.deepEqual(s.focus(), ['a.js', 'b.js']);
  fs.writeFileSync(s.focusPath, '"not an array"');
  assert.deepEqual(s.focus(), []);
  fs.writeFileSync(s.focusPath, 'not json at all');
  assert.deepEqual(s.focus(), []);
});

test('doc returns "" for a missing file and the content after writeDoc', () => {
  const s = store();
  assert.equal(s.doc('PLAN.md'), '');
  s.writeDoc('PLAN.md', '1. do it\n');
  assert.equal(s.doc('PLAN.md'), '1. do it\n');
});

test('log appends one JSON object per line', () => {
  const s = store();
  s.log({ type: 'a', n: 1 });
  s.log({ type: 'b', n: 2 });
  const lines = fs.readFileSync(s.logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'a');
  assert.equal(JSON.parse(lines[1]).n, 2);
  assert.ok(JSON.parse(lines[0]).ts);
});

test('reset removes task files but keeps the append-only log', () => {
  const s = store();
  s.save({ phase: 'executing' });
  s.writeDoc('PLAN.md', 'x');
  s.setFocus(['a']);
  s.log({ type: 'start' });
  s.reset();
  assert.equal(s.load(), null);
  assert.equal(s.doc('PLAN.md'), '');
  assert.deepEqual(s.focus(), []);
  assert.ok(fs.existsSync(s.logPath), 'log is history and must survive reset');
});
