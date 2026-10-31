import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Runner } from '../runner.mjs';
import { Store } from '../state.mjs';
import { loadConfig } from '../config.mjs';

const MATH_BUGGY = '// math\nfunction add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n';
const TEST_JS =
  "const { add } = require('./math');\nif (add(2, 3) !== 5) { console.error('AssertionError: expected 5'); process.exit(1); }\nconsole.log('ok');\n";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-crash-'));
  fs.writeFileSync(path.join(dir, 'math.js'), MATH_BUGGY);
  fs.writeFileSync(path.join(dir, 'test.js'), TEST_JS);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-cws-'));
  const cfg = loadConfig({ BRIDGE_ROOT: dir, BRIDGE_WORKSPACE: ws, BRIDGE_TEST_CMD: 'node test.js', BRIDGE_STEP_DELAY_MS: '0', BRIDGE_AUTONOMY: 'L3' });
  return { dir, g, ws, cfg };
}

const WS_FILES = ['state.json', 'PLAN.md', 'NOTES.md', 'focus.json'];
const snapshot = (ws) => WS_FILES.map((f) => [f, fs.existsSync(path.join(ws, f)) ? fs.readFileSync(path.join(ws, f)) : null]);
function restore(ws, snap) {
  for (const [f, buf] of snap) {
    const p = path.join(ws, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

class CrashError extends Error {}
function scriptedBrain(replies) {
  const sent = [];
  return {
    sent,
    newChats: 0,
    async send(text, opts) {
      sent.push(text);
      if (opts.newChat) this.newChats++;
      const next = replies.shift();
      if (next === undefined) throw new Error('script exhausted');
      return { text: typeof next === 'function' ? next(text) : next, model: 'm' };
    },
  };
}
const ui = () => ({ printed: [], print(t) { this.printed.push(t); }, status() {}, choose: async () => 'a', input: async () => '', confirm: async () => true });

const patch = (from, to) => `PATCH math.js\n<<<<<<< SEARCH\nfunction add(a, b) {\n  return ${from};\n}\n=======\nfunction add(a, b) {\n  return ${to};\n}\n>>>>>>> REPLACE`;
const tool = (name, args = {}) => '```tool\n' + JSON.stringify({ tool: name, args }) + '\n```';
const PLAN = 'PLAN\n<<<<<<< CONTENT\n1. Fix add()\n>>>>>>> END\nNOTES\n<<<<<<< CONTENT\nmath.js\n>>>>>>> END';

// Crash after a patch is applied to the working tree but BEFORE the step is committed.
test('crash with a half-applied step: resume rolls back the dirty tree and redoes it', async () => {
  const { dir, g, ws, cfg } = setup();
  const store = new Store(ws);
  let snap;
  const brain1 = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a + b'),
    () => {
      snap = snapshot(ws); // disk as the OS would have it at the crash instant
      throw new CrashError('kill -9');
    },
  ]);
  await assert.rejects(new Runner({ cfg, store, brain: brain1, ui: ui() }).start('fix add'), CrashError);
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/); // tree is dirty with the edit
  restore(ws, snap); // the crash's own writes (the halt save) are gone; only earlier flushes survived

  const headBefore = g('rev-parse', 'HEAD');
  const brain2 = scriptedBrain([patch('a - b', 'a + b'), tool('step_done', { step: 1 }), tool('task_done', { summary: 'done' })]);
  const u2 = ui();
  const done = await new Runner({ cfg, store, brain: brain2, ui: u2 }).resume();
  assert.equal(done.phase, 'done');
  assert.match(brain2.sent[0], /RESUMING/);
  assert.ok(u2.printed.some((t) => /Rollback|tidak sama dengan checkpoint/.test(t)), 'should report a rollback');
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/);
  assert.notEqual(g('rev-parse', 'HEAD'), headBefore); // the fix was committed on resume
  assert.equal(g('status', '--porcelain'), '');
});

// Crash in the narrow window AFTER git committed a step but BEFORE the state file recorded it.
test('crash between commit and state save: resume discards the orphan commit and redoes the step', async () => {
  const { dir, g, ws, cfg } = setup();
  const store = new Store(ws);
  let snap;
  const brain1 = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a + b'),
    () => {
      snap = snapshot(ws); // snapshot BEFORE the commit: state still says planStep 1, only checkpoint 0
      return tool('step_done', { step: 1 }); // this commits checkpoint 1 and advances the saved state
    },
    () => {
      throw new CrashError('kill -9 right after the commit'); // the advanced state never reaches a durable restore
    },
  ]);
  await assert.rejects(new Runner({ cfg, store, brain: brain1, ui: ui() }).start('fix add'), CrashError);
  const orphan = g('rev-parse', 'HEAD'); // checkpoint 1 is in git...
  restore(ws, snap); // ...but the restored disk state only knows checkpoint 0
  const restored = JSON.parse(fs.readFileSync(path.join(ws, 'state.json'), 'utf8'));
  assert.equal(restored.planStep, 1);
  assert.equal(restored.checkpoints.length, 1);

  const brain2 = scriptedBrain([patch('a - b', 'a + b'), tool('step_done', { step: 1 }), tool('task_done', { summary: 'done' })]);
  const u2 = ui();
  const done = await new Runner({ cfg, store, brain: brain2, ui: u2 }).resume();
  assert.equal(done.phase, 'done');
  // Resume must not have stacked on the orphan. The real proof is the commit graph below:
  // HEAD was rewound to checkpoint 0 and the step rebuilt, so there is exactly ONE step-1
  // checkpoint and the tree is clean. (The rebuilt commit may hash-collide with the orphan
  // when git reproduces it byte-for-byte, so comparing SHAs would be meaningless.)
  void orphan;
  assert.equal(g('status', '--porcelain'), '');
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/);
  const subjects = g('log', '--format=%s');
  assert.equal(subjects.split('\n').filter((l) => /step 1/.test(l)).length, 1, 'exactly one step-1 checkpoint, not two');
});

// Crash during the exploration phase, before any plan existed.
test('crash during exploration: resume continues exploring in a fresh chat', async () => {
  const { ws, cfg } = setup();
  const store = new Store(ws);
  let snap;
  const brain1 = scriptedBrain([
    tool('fs_read', { path: 'math.js' }),
    () => {
      snap = snapshot(ws);
      throw new CrashError('kill');
    },
  ]);
  await assert.rejects(new Runner({ cfg, store, brain: brain1, ui: ui() }).start('fix add'), CrashError);
  restore(ws, snap);
  const s = JSON.parse(fs.readFileSync(path.join(ws, 'state.json'), 'utf8'));
  assert.equal(s.phase, 'exploring');

  const brain2 = scriptedBrain([PLAN, tool('focus_set', { paths: ['math.js'] }), patch('a - b', 'a + b'), tool('step_done', { step: 1 }), tool('task_done', { summary: 'ok' })]);
  const done = await new Runner({ cfg, store, brain: brain2, ui: ui() }).resume();
  assert.equal(done.phase, 'done');
  assert.match(brain2.sent[0], /RESUMING|EXPLOR/i);
});

// The state file is written atomically: a torn write (e.g. power loss mid-write) must never
// leave a half-file that the next run would choke on.
test('state.json is written atomically (no torn file is ever observed)', () => {
  const { ws } = setup();
  const store = new Store(ws);
  const statePath = path.join(ws, 'state.json');
  // Every time a temp file is renamed into place, its content must be complete JSON.
  const realRename = fs.renameSync;
  const observed = [];
  fs.renameSync = (from, to) => {
    if (to === statePath) observed.push(fs.readFileSync(from, 'utf8'));
    return realRename(from, to);
  };
  try {
    for (let i = 0; i < 50; i++) store.save({ phase: 'executing', planStep: i, checkpoints: [{ sha: 'x'.repeat(40) }], blob: 'y'.repeat(i * 10) });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(observed.length, 50);
  for (const txt of observed) assert.doesNotThrow(() => JSON.parse(txt)); // each rename carried whole JSON
  // And the file on disk is valid and current.
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).planStep, 49);
});

// Resume is idempotent: running it twice (e.g. a crash during resume itself) still converges.
test('resume twice in a row converges to done without double-applying', async () => {
  const { dir, g, ws, cfg } = setup();
  const store = new Store(ws);
  let snap;
  const brain1 = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a + b'),
    () => {
      snap = snapshot(ws);
      throw new CrashError('kill');
    },
  ]);
  await assert.rejects(new Runner({ cfg, store, brain: brain1, ui: ui() }).start('fix add'), CrashError);
  restore(ws, snap);

  // First resume crashes again immediately after rolling back.
  const snap2Holder = {};
  const brain2 = scriptedBrain([
    () => {
      snap2Holder.snap = snapshot(ws);
      throw new CrashError('kill during resume');
    },
  ]);
  await assert.rejects(new Runner({ cfg, store, brain: brain2, ui: ui() }).resume(), CrashError);
  restore(ws, snap2Holder.snap);
  assert.equal(g('status', '--porcelain'), '', 'working tree clean after the first resume rolled back');

  // Second resume completes.
  const brain3 = scriptedBrain([patch('a - b', 'a + b'), tool('step_done', { step: 1 }), tool('task_done', { summary: 'done' })]);
  const done = await new Runner({ cfg, store, brain: brain3, ui: ui() }).resume();
  assert.equal(done.phase, 'done');
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/);
  assert.equal(g('log', '--format=%s').split('\n').filter((l) => /step 1/.test(l)).length, 1);
});
