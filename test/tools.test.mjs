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
  assert.equal(await tools.grep_search({ pattern: 'SECRET' }), '');
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
