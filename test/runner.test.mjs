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
const TEST_JS = "const { add } = require('./math');\nif (add(2, 3) !== 5) { console.error('AssertionError: expected 5, received ' + add(2, 3)); process.exit(1); }\nconsole.log('ok');\n";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-run-'));
  fs.writeFileSync(path.join(dir, 'math.js'), MATH_BUGGY);
  fs.writeFileSync(path.join(dir, 'test.js'), TEST_JS);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return { dir, g };
}

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
      return { text: typeof next === 'function' ? next(text) : next, model: 'deepseek-test' };
    },
  };
}

function scriptedUI(choices = [], inputs = []) {
  const printed = [];
  return {
    printed,
    print: (t) => printed.push(t),
    status: () => {},
    choose: async () => choices.shift(),
    input: async () => inputs.shift(),
    confirm: async () => true,
  };
}

const patch = (from, to) => `PATCH math.js\n<<<<<<< SEARCH\nfunction add(a, b) {\n  return ${from};\n}\n=======\nfunction add(a, b) {\n  return ${to};\n}\n>>>>>>> REPLACE`;
const tool = (name, args = {}) => '```tool\n' + JSON.stringify({ tool: name, args }) + '\n```';
const PLAN = 'PLAN\n<<<<<<< CONTENT\n1. Fix add() in math.js\n>>>>>>> END\nNOTES\n<<<<<<< CONTENT\nmath.js has the bug.\n>>>>>>> END';

function setup(env = {}) {
  const { dir, g } = repo();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-ws-'));
  const cfg = loadConfig({ BRIDGE_ROOT: dir, BRIDGE_WORKSPACE: ws, BRIDGE_TEST_CMD: 'node test.js', BRIDGE_STEP_DELAY_MS: '0', BRIDGE_AUTONOMY: 'L3', ...env });
  return { dir, g, cfg, store: new Store(ws) };
}

test('full task: explore, plan, red, fix, green, review', async () => {
  const { dir, g, cfg, store } = setup();
  const brain = scriptedBrain([
    tool('fs_list'),
    tool('fs_read', { path: 'math.js' }),
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a * b'),
    tool('step_done', { step: 1, summary: 'fix add' }),
    patch('a \\* b', 'a + b'), // SEARCH not found -> rejected
    tool('fs_read', { path: 'math.js' }),
    patch('a * b', 'a + b'),
    tool('step_done', { step: 1, summary: 'fix add' }),
    tool('task_done', { summary: 'fixed add' }),
  ]);
  const ui = scriptedUI(['a', 'a']);
  const state = await new Runner({ cfg, store, brain, ui }).start('fix the add function');

  assert.equal(state.phase, 'done');
  assert.equal(brain.newChats, 1);
  assert.match(brain.sent[0], /PHASE 1: EXPLORATION/);
  assert.match(brain.sent[3], /plan is APPROVED/);
  assert.match(brain.sent[6], /Tests FAILED/);
  assert.match(brain.sent[7], /SEARCH not found/);
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /return a \+ b/);
  const log = g('log', '--format=%s');
  assert.match(log, /agent: step 1 — fix add/);
  assert.match(log, /agent: checkpoint 0/);
  assert.match(g('rev-parse', '--abbrev-ref', 'HEAD'), /^agent\/fix-the-add-function-/);
  assert.match(store.doc('PLAN.md'), /Fix add\(\)/);
  assert.equal(g('status', '--porcelain'), '');
});

test('exploration is read-only and edits outside focus are rejected', async () => {
  const { cfg, store } = setup();
  const brain = scriptedBrain([
    patch('a - b', 'a + b'),
    PLAN,
    patch('a - b', 'a + b'),
    tool('halt', { reason: 'test over' }),
  ]);
  const state = await new Runner({ cfg, store, brain, ui: scriptedUI(['a']) }).start('fix add');
  assert.match(brain.sent[1], /not allowed during exploration/);
  assert.match(brain.sent[3], /not in focus/);
  assert.equal(state.phase, 'halted');
});

test('three different failures block the step and roll back', async () => {
  const { dir, g, cfg, store } = setup();
  const brain = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a * b'),
    tool('step_done', { step: 1 }),
    patch('a * b', 'a / b'),
    tool('step_done', { step: 1 }),
    patch('a / b', 'a % b'),
    tool('step_done', { step: 1 }),
    tool('task_done', { summary: 'gave up' }),
  ]);
  const state = await new Runner({ cfg, store, brain, ui: scriptedUI(['a', 'a']) }).start('fix add');
  assert.deepEqual(state.blockedSteps, [1]);
  assert.match(brain.sent[8], /BLOCKED/);
  assert.equal(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), MATH_BUGGY);
  assert.doesNotMatch(g('log', '--format=%s'), /step 1/);
});

test('stop mid-task, then resume in a new chat after rolling back half-done work', async () => {
  const { dir, cfg, store } = setup();
  let runner;
  const brain1 = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a * b'),
    () => {
      runner.stop('test stop');
      return tool('fs_list');
    },
  ]);
  runner = new Runner({ cfg, store, brain: brain1, ui: scriptedUI(['a']) });
  const paused = await runner.start('fix add');
  assert.equal(paused.paused, true);
  assert.equal(paused.phase, 'executing');
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \* b/);

  const brain2 = scriptedBrain([
    tool('fs_read', { path: 'math.js' }),
    patch('a - b', 'a + b'),
    tool('step_done', { step: 1 }),
    tool('task_done', { summary: 'done' }),
  ]);
  const ui2 = scriptedUI(['a']);
  const done = await new Runner({ cfg, store, brain: brain2, ui: ui2 }).resume();
  assert.equal(done.phase, 'done');
  assert.equal(brain2.newChats, 1);
  assert.match(brain2.sent[0], /RESUMING/);
  assert.ok(ui2.printed.some((t) => /Rollback ke checkpoint terakhir/.test(t)));
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/);
});

test('review flags weakened tests', async () => {
  const { dir, cfg, store } = setup({ BRIDGE_TEST_CMD: '' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), "test('x', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n");
  const brain = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['tests/a.test.js'] }),
    "PATCH tests/a.test.js\n<<<<<<< SEARCH\ntest('x', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n=======\ntest.skip('x', () => {\n>>>>>>> REPLACE",
    tool('step_done', { step: 1 }),
    tool('task_done', { summary: 'x' }),
  ]);
  const ui = scriptedUI(['a', 'a']);
  await new Runner({ cfg, store, brain, ui }).start('weaken');
  assert.ok(ui.printed.some((t) => /assertion dihapus/.test(t)), ui.printed.join('\n'));
  assert.ok(ui.printed.some((t) => /di-skip/.test(t)));
});

test('same error three times forces a re-read before the next patch', async () => {
  const { cfg, store } = setup();
  const brain = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', '(a - b)'),
    tool('step_done', { step: 1 }),
    patch('\\(a - b\\)', 'x'), // not found, harmless
    patch('(a - b)', '((a - b))'),
    tool('step_done', { step: 1 }),
    patch('((a - b))', '(((a - b)))'),
    tool('step_done', { step: 1 }),
    patch('(((a - b)))', 'a + b'), // rejected: must re-read
    tool('fs_read', { path: 'math.js' }),
    patch('(((a - b)))', 'a + b'),
    tool('step_done', { step: 1 }),
    tool('task_done', { summary: 'ok' }),
  ]);
  const state = await new Runner({ cfg, store, brain, ui: scriptedUI(['a', 'a']) }).start('fix add');
  assert.match(brain.sent[9], /MUST fs_read/);
  assert.match(brain.sent[10], /fs_read the relevant file before the next PATCH/);
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.blockedSteps, []);
});

test('step_done ignores an inflated step number from the model', async () => {
  const { g, cfg, store } = setup();
  const brain = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a + b'),
    tool('step_done', { step: 9, summary: 'fix' }), // model claims step 9
    tool('task_done', { summary: 'done' }),
  ]);
  const state = await new Runner({ cfg, store, brain, ui: scriptedUI(['a', 'a']) }).start('fix add');
  assert.equal(state.phase, 'done');
  assert.equal(state.planStep, 2); // advanced by one, not to 10
  assert.match(brain.sent[4], /you wrote step 9; the current step is 1/);
  assert.match(g('log', '--format=%s'), /agent: step 1 — fix/);
});

test('a blocker halts with the code, keeps state, and resume continues from the same step', async () => {
  const { dir, cfg, store } = setup();
  const blocker = () => { const e = new Error('CAPTCHA muncul'); e.code = 'blocked'; throw e; };
  const brain1 = scriptedBrain([
    PLAN,
    tool('focus_set', { paths: ['math.js'] }),
    blocker, // blocker hits before any step completes
  ]);
  const halted = await new Runner({ cfg, store, brain: brain1, ui: scriptedUI(['a']) }).start('fix add');
  assert.equal(halted.phase, 'halted');
  assert.equal(halted.haltedFrom, 'executing');
  assert.match(halted.haltReason, /\[blocked\]/);
  assert.equal(halted.planStep, 1); // not advanced, not rolled back as a failure
  assert.deepEqual(halted.blockedSteps, []);

  const brain2 = scriptedBrain([
    tool('focus_set', { paths: ['math.js'] }),
    patch('a - b', 'a + b'),
    tool('step_done', { step: 1 }),
    tool('task_done', { summary: 'done' }),
  ]);
  const done = await new Runner({ cfg, store, brain: brain2, ui: scriptedUI(['a']) }).resume();
  assert.equal(done.phase, 'done');
  assert.equal(brain2.newChats, 1);
  assert.match(brain2.sent[0], /RESUMING/);
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /a \+ b/);
});

// ---------- full shell (BRIDGE_SHELL=full) ----------

const bash = (command, extra = {}) => tool('bash', { command, ...extra });
const spyUI = (choices, confirm) => {
  const ui = scriptedUI(choices);
  ui.asked = [];
  ui.confirm = async (q) => {
    ui.asked.push(q);
    return typeof confirm === 'function' ? confirm(q) : confirm;
  };
  return ui;
};
const execute = async (env, replies, ui) => {
  const { dir, g, cfg, store } = setup(env);
  const brain = scriptedBrain([PLAN, ...replies]);
  const runner = new Runner({ cfg, store, brain, ui });
  const state = await runner.start('shell task');
  return { dir, g, brain, runner, state, ui, cfg, store };
};

test('full shell is off by default: bash is refused and not advertised', async () => {
  const { brain, dir } = await execute({}, [bash('echo hi > nope.txt'), tool('halt', { reason: 'end' })], scriptedUI(['a']));
  assert.match(brain.sent[2], /"bash" is not enabled/);
  assert.equal(fs.existsSync(path.join(dir, 'nope.txt')), false);
  assert.doesNotMatch(brain.sent[0], /FULL SHELL/);
});

test('full shell runs a command, returns its output, and is advertised', async () => {
  const ui = spyUI(['a'], true);
  const { brain, dir } = await execute({ BRIDGE_SHELL: 'full' }, [bash('echo hello-from-bash > out.txt; cat out.txt; echo "api_key=SUPERSECRETVALUE"'), tool('halt', { reason: 'end' })], ui);
  assert.match(brain.sent[0], /FULL SHELL/);
  assert.match(brain.sent[2], /exit 0/);
  assert.match(brain.sent[2], /hello-from-bash/);
  assert.doesNotMatch(brain.sent[2], /SUPERSECRETVALUE/); // masked before it reaches the model
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim(), 'hello-from-bash');
});

test('L1 asks before every command, and a refusal means it never runs', async () => {
  const ui = spyUI(['a'], false);
  const { brain, dir } = await execute({ BRIDGE_SHELL: 'full', BRIDGE_AUTONOMY: 'L1' }, [bash('echo x > declined.txt'), tool('halt', { reason: 'end' })], ui);
  assert.ok(ui.asked.some((q) => /Jalankan di bash/.test(q) && /declined\.txt/.test(q)));
  assert.match(brain.sent[2], /user declined/);
  assert.equal(fs.existsSync(path.join(dir, 'declined.txt')), false);
});

test('L3 runs ordinary commands unasked but still asks for risky ones', async () => {
  const ui = spyUI(['a'], (q) => !/Berisiko/.test(q)); // approve everything except flagged commands
  const { brain, dir } = await execute(
    { BRIDGE_SHELL: 'full', BRIDGE_AUTONOMY: 'L3' },
    [bash('echo fine > fine.txt'), bash('mkdir victim && rm -rf victim && echo gone > risky.txt'), tool('halt', { reason: 'end' })],
    ui,
  );
  const shellQs = ui.asked.filter((q) => /Jalankan di bash/.test(q));
  assert.equal(shellQs.length, 1, 'only the risky command should ask');
  assert.match(shellQs[0], /Berisiko: menghapus file/);
  assert.equal(fs.existsSync(path.join(dir, 'fine.txt')), true);
  assert.equal(fs.existsSync(path.join(dir, 'risky.txt')), false);
  assert.match(brain.sent[3], /user declined/);
});

test('L3 with full shell must be acknowledged once, otherwise the run does not start', async () => {
  const { cfg, store } = setup({ BRIDGE_SHELL: 'full', BRIDGE_AUTONOMY: 'L3' });
  const ui = spyUI([], false);
  await assert.rejects(new Runner({ cfg, store, brain: scriptedBrain([]), ui }).start('x'), /Dibatalkan/);
  assert.ok(ui.asked.some((q) => /L3 \+ shell penuh/.test(q)));
});

test('a command cannot move the runner git state: commits, branch switches and stashes are undone', async () => {
  const ui = spyUI(['a'], true);
  const { g, brain } = await execute(
    { BRIDGE_SHELL: 'full' },
    [
      bash('git switch -q -c sneaky && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m sneaky'),
      bash('echo dirty >> math.js && git stash -q'),
      tool('halt', { reason: 'end' }),
    ],
    ui,
  );
  assert.match(g('rev-parse', '--abbrev-ref', 'HEAD').trim(), /^agent\/shell-task-/);
  assert.equal(g('log', '--format=%s').includes('sneaky'), false); // the sneaky commit is not on the agent branch
  assert.match(brain.sent[2], /switched back/);
  assert.match(brain.sent[3], /stashed changes; they were restored/);
  assert.match(fs.readFileSync(path.join(g('rev-parse', '--show-toplevel').trim(), 'math.js'), 'utf8'), /dirty/);
});

test('a command that rewinds git history halts the run, and resume restores the checkpoint', async () => {
  const ui = spyUI(['a'], true);
  const { state, dir, g, cfg, store } = await execute({ BRIDGE_SHELL: 'full' }, [bash('echo more >> math.js'), bash('git reset -q --hard HEAD~1')], ui);
  assert.equal(state.phase, 'halted');
  assert.match(state.haltReason, /memundurkan riwayat git/);
  assert.equal(state.haltedFrom, 'executing');

  const checkpoint0 = state.checkpoints[0].sha;
  assert.notEqual(g('rev-parse', 'HEAD').trim(), checkpoint0); // history really was rewound

  const brain2 = scriptedBrain([tool('halt', { reason: 'end' })]);
  const resumed = await new Runner({ cfg, store, brain: brain2, ui }).resume();
  assert.equal(g('rev-parse', 'HEAD').trim(), checkpoint0); // rolled back to the recorded checkpoint
  assert.equal(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), MATH_BUGGY);
  assert.match(brain2.sent[0], /RESUMING/);
  assert.equal(resumed.phase, 'halted'); // the scripted model then halts on purpose
});

test('Stop kills a running full-shell command and pauses the run quickly', async () => {
  const ui = spyUI(['a'], true);
  const { cfg, store } = setup({ BRIDGE_SHELL: 'full' });
  let runner;
  const brain = scriptedBrain([
    PLAN,
    () => {
      setTimeout(() => runner.stop('test stop'), 400);
      return bash('sleep 30');
    },
  ]);
  runner = new Runner({ cfg, store, brain, ui });
  const t0 = Date.now();
  const state = await runner.start('shell task');
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0}ms`);
  assert.equal(state.paused, true);
  assert.equal(state.phase, 'executing');
});

test('the full shell is not available during exploration', async () => {
  const ui = spyUI(['a'], true);
  const { cfg, store } = setup({ BRIDGE_SHELL: 'full' });
  const brain = scriptedBrain([bash('echo no > explore.txt'), PLAN, tool('halt', { reason: 'end' })]);
  await new Runner({ cfg, store, brain, ui }).start('shell task');
  assert.match(brain.sent[1], /not available during exploration/);
  assert.equal(fs.existsSync(path.join(cfg.root, 'explore.txt')), false);
});
