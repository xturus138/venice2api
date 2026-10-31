import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseReply, MAX_EDITS_PER_REPLY } from '../protocol.mjs';
import { applySearchReplace } from '../patches.mjs';
import { Tools, ToolError } from '../tools.mjs';
import { loadConfig } from '../config.mjs';

// Deterministic PRNG so a failure is reproducible from the printed seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, n) => Math.floor(r() * n);

const KIND = new Set(['tool', 'edits', 'plan', 'error']);

// ---------- parseReply never throws and always returns a well-formed shape ----------

test('fuzz: parseReply tolerates arbitrary noise without throwing', () => {
  // A charset loaded with the characters most likely to confuse the parser.
  const chars = [...'{}[]"\'`:,=<>PATCHWRITEPLANNOTESREADCONTEND tool args \n\t\\/0123456789abc. *#~^'];
  for (let seed = 1; seed <= 4000; seed++) {
    const r = rng(seed);
    const len = int(r, 400);
    let s = '';
    for (let i = 0; i < len; i++) s += pick(r, chars);
    // Sprinkle in real markers so the parser's heavy paths get exercised.
    if (r() < 0.4) s = s.replace('P', '<<<<<<< SEARCH\n');
    if (r() < 0.4) s += '\n>>>>>>> REPLACE';
    if (r() < 0.3) s = `{"tool":${s.slice(0, 20)}`;
    let res;
    try {
      res = parseReply(s);
    } catch (e) {
      assert.fail(`parseReply threw on seed ${seed}: ${e.stack}\ninput=${JSON.stringify(s)}`);
    }
    assert.ok(res && KIND.has(res.kind), `bad kind on seed ${seed}: ${JSON.stringify(res)}`);
    if (res.kind === 'tool') {
      assert.equal(typeof res.tool, 'string');
      assert.ok(res.args && typeof res.args === 'object' && !Array.isArray(res.args));
    } else if (res.kind === 'edits') {
      assert.ok(Array.isArray(res.edits) && res.edits.length >= 1 && res.edits.length <= MAX_EDITS_PER_REPLY);
      for (const e of res.edits) {
        assert.ok(e.type === 'patch' || e.type === 'write');
        assert.equal(typeof e.path, 'string');
        if (e.type === 'patch') assert.equal(typeof e.search, 'string');
        else assert.equal(typeof e.content, 'string');
      }
    } else if (res.kind === 'plan') {
      assert.equal(typeof res.plan, 'string');
      assert.equal(typeof res.notes, 'string');
    } else {
      assert.equal(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
    }
  }
});

test('fuzz: a well-formed tool call always parses back to that tool', () => {
  const tools = ['fs_read', 'fs_list', 'grep_search', 'git_read', 'step_done', 'task_done', 'focus_set'];
  const fences = ['```tool', '```json', '```', 'tool', ''];
  for (let seed = 1; seed <= 1500; seed++) {
    const r = rng(seed);
    const toolName = pick(r, tools);
    const args = {};
    if (r() < 0.6) args.path = pick(r, ['src/a.js', 'a/b/c.txt', '__init__.py']);
    if (r() < 0.4) args.start = int(r, 500);
    const json = JSON.stringify({ tool: toolName, args });
    const fence = pick(r, fences);
    const lead = r() < 0.5 ? 'Let me do this.\n' : '';
    const junk = r() < 0.3 ? '\nCopy code\n' : '\n';
    const reply = fence ? `${lead}${fence}${junk}${json}\n\`\`\`` : `${lead}${json}`;
    const res = parseReply(reply);
    assert.equal(res.kind, 'tool', `seed ${seed}: ${JSON.stringify(reply)} -> ${JSON.stringify(res)}`);
    assert.equal(res.tool, toolName);
  }
});

// ---------- applySearchReplace is a correct, total function ----------

function randomFile(r) {
  const n = 1 + int(r, 40);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const kind = int(r, 5);
    if (kind === 0) lines.push('');
    else if (kind === 1) lines.push('  '.repeat(int(r, 3)) + pick(r, ['return x;', 'const a = 1;', '}', '{', 'if (y) {']));
    else lines.push(pick(r, ['alpha', 'beta', 'gamma', 'delta', 'x', 'y']) + ' ' + int(r, 100));
  }
  return lines.join('\n') + (r() < 0.7 ? '\n' : '');
}

test('fuzz: applySearchReplace never throws and respects its contract', () => {
  for (let seed = 1; seed <= 6000; seed++) {
    const r = rng(seed);
    const file = randomFile(r);
    const lines = file.split('\n');
    const start = int(r, lines.length);
    const span = 1 + int(r, 5);
    const slice = lines.slice(start, start + span);
    const search = slice.join('\n');
    const replace = pick(r, ['REPLACED', 'a\nb', '', 'x\ny\nz']);

    let res;
    try {
      res = applySearchReplace(file, search, replace);
    } catch (e) {
      assert.fail(`threw on seed ${seed}: ${e.stack}\nfile=${JSON.stringify(file)}\nsearch=${JSON.stringify(search)}`);
    }
    assert.equal(typeof res.ok, 'boolean');
    if (res.ok) {
      assert.equal(typeof res.content, 'string');
      // When the exact search string occurs exactly once, the result must be the precise splice.
      const occurrences = file.split(search).length - 1;
      if (search.trim() !== '' && occurrences === 1 && !search.includes('\r')) {
        const idx = file.indexOf(search);
        const expected = file.slice(0, idx) + replace + file.slice(idx + search.length);
        assert.equal(res.content, expected, `seed ${seed}: splice mismatch`);
      }
    } else {
      assert.equal(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
    }
  }
});

test('fuzz: applying the result of a successful patch reproduces the intended file', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const file = randomFile(r);
    const lines = file.split('\n');
    // Build a 3+ line search that we know is unique by anchoring to a random position and
    // widening until it occurs once (or giving up).
    const start = int(r, Math.max(1, lines.length - 3));
    let span = 3;
    let search = lines.slice(start, start + span).join('\n');
    while (file.split(search).length - 1 > 1 && start + span < lines.length) {
      span += 1;
      search = lines.slice(start, start + span).join('\n');
    }
    if (file.split(search).length - 1 !== 1) continue; // not uniquely anchorable; skip
    if (search.trim() === '') continue;
    const replace = 'UNIQUE_MARKER_' + seed;
    const res = applySearchReplace(file, search, replace);
    assert.equal(res.ok, true, `seed ${seed} should apply`);
    assert.ok(res.content.includes('UNIQUE_MARKER_' + seed));
    // The marker appears exactly once and the search text is gone (unless replace re-adds it).
    assert.equal(res.content.split('UNIQUE_MARKER_' + seed).length - 1, 1);
  }
});

// ---------- the path jail holds under fuzzing ----------

function jailFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-fuzz-'));
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'x\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  try {
    fs.symlinkSync(outside, path.join(dir, 'escape'));
  } catch {
    /* symlinks may be unavailable */
  }
  return { tools: new Tools(loadConfig({ BRIDGE_ROOT: dir })), root: fs.realpathSync(dir) };
}

test('fuzz: resolve() never returns a path outside the project (or it throws)', () => {
  const { tools, root } = jailFixture();
  const segs = ['..', '.', 'src', 'deep', 'a.js', 'escape', 'x', '', '.git', '.env', '/etc', '~', 'a b', '....//'];
  for (let seed = 1; seed <= 5000; seed++) {
    const r = rng(seed);
    const n = 1 + int(r, 6);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(pick(r, segs));
    let p = parts.join(pick(r, ['/', '/', '\\', '/./']));
    if (r() < 0.2) p = '/' + p;
    let resolved;
    try {
      resolved = tools.resolve(p, { forWrite: r() < 0.5 });
    } catch (e) {
      assert.ok(e instanceof ToolError, `seed ${seed}: non-ToolError ${e.stack}`);
      continue;
    }
    // If it resolved, the real absolute path must be inside the project root.
    const abs = path.resolve(root, resolved.rel);
    assert.ok(abs === root || abs.startsWith(root + path.sep), `seed ${seed}: escaped with ${JSON.stringify(p)} -> ${resolved.rel}`);
    assert.ok(!resolved.rel.split('/').includes('..'), `seed ${seed}: rel has .. (${resolved.rel})`);
  }
});

test('fuzz: a path-taking shell command with an escaping arg always throws', () => {
  const { tools } = jailFixture();
  const cmds = [
    (p) => ({ cmd: 'cat', args: ['-n', p] }),
    (p) => ({ cmd: 'ls', args: [p] }),
    (p) => ({ cmd: 'cp', args: [p, 'src/b.js'] }),
    (p) => ({ cmd: 'cp', args: ['src/a.js', p] }),
    (p) => ({ cmd: 'mv', args: ['src/a.js', p] }),
    (p) => ({ cmd: 'grep', args: ['-r', 'x', p] }),
    (p) => ({ cmd: 'grep', args: ['-e', 'x', p] }),
    (p) => ({ cmd: 'find', args: [p, '-name', '*.js'] }),
    (p) => ({ cmd: 'cp', args: [`--target-directory=${p}`, 'src/a.js'] }),
  ];
  const escaping = ['/etc/passwd', '/etc', '../../../etc/passwd', '../outside', '/', '/root/.ssh/id_rsa', '../../x', '/tmp/x'];
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const { cmd, args } = pick(r, cmds)(pick(r, escaping));
    assert.throws(() => tools.checkShell({ cmd, args }), ToolError, `seed ${seed}: ${cmd} ${args.join(' ')} did not throw`);
  }
});

test('fuzz: a secret path anywhere in a shell command is refused', () => {
  const { tools } = jailFixture();
  const secrets = ['.env', '.env.local', 'id_rsa', 'server.pem', 'creds.p12', 'secrets.json', 'src/../.env'];
  const cmds = [
    (p) => ({ cmd: 'cat', args: [p] }),
    (p) => ({ cmd: 'grep', args: ['-r', 'x', p] }),
    (p) => ({ cmd: 'cp', args: [p, 'out'] }),
    (p) => ({ cmd: 'git', args: ['show', `HEAD:${p}`] }),
  ];
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const { cmd, args } = pick(r, cmds)(pick(r, secrets));
    assert.throws(() => tools.checkShell({ cmd, args }), ToolError, `seed ${seed}: ${cmd} ${args.join(' ')}`);
  }
});
