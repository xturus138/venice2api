import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Tools, ToolError, trimFailures } from '../tools.mjs';
import { loadConfig } from '../config.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tools-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'const a = 1;\nfunction hello() {\n  return "hi";\n}\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-outside-'));
  fs.writeFileSync(path.join(outside, 'x.txt'), 'outside');
  fs.symlinkSync(outside, path.join(dir, 'link'));
  const cfg = loadConfig({ BRIDGE_ROOT: dir, BRIDGE_WORKSPACE: path.join(dir, '..', 'ws-' + path.basename(dir)) });
  return { dir, tools: new Tools(cfg) };
}

test('path jail', () => {
  const { tools } = setup();
  assert.throws(() => tools.resolve('../etc/passwd'), ToolError);
  assert.throws(() => tools.resolve('/etc/passwd'), ToolError);
  assert.throws(() => tools.resolve('link/x.txt'), /symlink/);
  assert.throws(() => tools.resolve('.git/config'), ToolError);
  assert.throws(() => tools.resolve('.env'), /secrets/);
  assert.equal(tools.resolve('src/../src/a.js').rel, 'src/a.js');
});

test('fs_read numbers lines and supports ranges', async () => {
  const { tools } = setup();
  const out = await tools.fs_read({ path: 'src/a.js', start: 2, end: 3 });
  assert.match(out, /lines 2-3 of 5/);
  assert.match(out, /2\| function hello\(\) \{/);
  assert.match(out, /more below, call fs_read with start=4/);
});

test('fs_list skips .git and lists files', async () => {
  const { tools } = setup();
  const out = await tools.fs_list({});
  assert.match(out, /src\/a\.js/);
  assert.doesNotMatch(out, /\.git\//);
});

test('grep_search finds untracked files and hides secrets', async () => {
  const { tools } = setup();
  assert.match(await tools.grep_search({ pattern: 'hello' }), /src\/a\.js:2:/);
  assert.equal(await tools.grep_search({ pattern: 'SECRET' }), '(no matches)');
});

test('shell checks', () => {
  const { tools } = setup();
  assert.equal(tools.checkShell({ cmd: 'rm', args: ['-rf', '.'] }).allowed, false);
  assert.throws(() => tools.checkShell({ cmd: 'find', args: ['.', '-delete'] }), /not allowed/);
  assert.throws(() => tools.checkShell({ cmd: 'git', args: ['push'] }), /read-only/);
  assert.throws(() => tools.checkShell({ cmd: 'mv', args: ['src/a.js', '../a.js'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'cat', args: ['.env'] }), /secrets/);
  assert.throws(() => tools.checkShell({ cmd: '/bin/sh', args: [] }), /bare program/);
  const ok = tools.checkShell({ cmd: 'ls', args: ['-la', 'src'] });
  assert.equal(ok.allowed, true);
  assert.equal(tools.checkShell({ cmd: 'npm', args: ['test'] }).runsCode, true);
});

test('trimFailures keeps the failure lines', () => {
  const out = trimFailures('ok 1\nok 2\nnoise\nAssertionError: expected 1 to equal 2\n  at foo (a.js:1)\nmore\nmore2\nunrelated\nunrelated2\n');
  assert.match(out, /AssertionError/);
  assert.doesNotMatch(out, /ok 1/);
});

test('shell path jail is flag-aware (no secret or out-of-root leaks)', () => {
  const { tools } = setup();
  // blocked
  assert.throws(() => tools.checkShell({ cmd: 'grep', args: ['-r', 'SECRET', '.env'] }), /secrets/);
  assert.throws(() => tools.checkShell({ cmd: 'rg', args: ['SECRET', '/'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'grep', args: ['-r', 'x', '/etc/passwd'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'cp', args: ['--target-directory=/tmp', 'src/a.js'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'cp', args: ['-t', '/tmp', 'src/a.js'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'grep', args: ['-e', 'SECRET', '/etc'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'find', args: ['/', '-name', 'x'] }), /outside/);
  assert.throws(() => tools.checkShell({ cmd: 'git', args: ['show', 'HEAD:.env'] }), /secrets/);
  assert.throws(() => tools.checkShell({ cmd: 'git', args: ['diff', '--no-index', '/etc/hostname', 'src/a.js'] }), /no-index/);
  // allowed: pattern/glob/type values are not treated as paths
  for (const a of [
    ['grep', ['-rn', 'hello', 'src/a.js']],
    ['find', ['.', '-name', '*.js']],
    ['find', ['-name', '*.js']],
    ['rg', ['-n', '--glob', '*.js', '-t', 'js', 'hello', 'src']],
    ['grep', ['-e', 'hello', 'src/a.js']],
    ['cat', ['-n', 'src/a.js']],
  ]) assert.doesNotThrow(() => tools.checkShell({ cmd: a[0], args: a[1] }), a.join(' '));
});

test('git_read blocks --no-index and secret pathspecs but allows normal shows', async () => {
  const { tools } = setup();
  await assert.rejects(tools.git_read({ cmd: 'show', args: ['HEAD:.env'] }), /secrets/);
  await assert.rejects(tools.git_read({ cmd: 'diff', args: ['--no-index', '/etc/hostname', 'src/a.js'] }), /no-index/);
});

test('secret files: refused by default, masked keys when opted in, never for key files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sec-'));
  fs.writeFileSync(path.join(dir, '.env'), 'export API_KEY=sk-xyz\n# note\nDB=postgres://u:p@h/db\n');
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'PRIVATE KEY\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const off = new Tools(loadConfig({ BRIDGE_ROOT: dir }));
  const on = new Tools(loadConfig({ BRIDGE_ROOT: dir, BRIDGE_ENV_KEYS: '1' }));
  await assert.rejects(off.fs_read({ path: '.env' }), /never sent/);
  const masked = await on.fs_read({ path: '.env' });
  assert.match(masked, /API_KEY=\*\*\*/);
  assert.match(masked, /DB=\*\*\*/);
  assert.doesNotMatch(masked, /sk-xyz|postgres/);
  assert.match(masked, /# note/); // comments kept
  await assert.rejects(on.fs_read({ path: 'id_rsa' }), /refusing/); // never for key files
});

test('find expression cannot read a reference file', () => {
  const { tools } = setup();
  assert.throws(() => tools.checkShell({ cmd: 'find', args: ['.', '-newer', '/etc/passwd'] }), /not allowed/);
  assert.throws(() => tools.checkShell({ cmd: 'find', args: ['.', '-files0-from', '/etc/x'] }), /not allowed/);
});
