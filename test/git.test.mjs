import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Git } from '../git.mjs';

function repo({ withCommit = true, identity = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (identity) {
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
  }
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  if (withCommit) {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  }
  return { dir, git: new Git(dir) };
}

test('isRepo / hasCommits / currentBranch reflect reality', async () => {
  const { git } = repo();
  assert.equal(await git.isRepo(), true);
  assert.equal(await git.hasCommits(), true);
  assert.equal(await git.currentBranch(), 'main');
  const empty = repo({ withCommit: false });
  assert.equal(await empty.git.hasCommits(), false);
});

test('checkpoint commits everything and returns the new HEAD sha', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  const sha = await git.checkpoint('agent: test');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await git.head(), sha);
  assert.equal(await git.isDirty(), false); // everything committed
  assert.match(execFileSync('git', ['log', '--format=%s', '-1'], { cwd: dir, encoding: 'utf8' }), /agent: test/);
});

test('checkpoint works even when git identity is unset (falls back to a default author)', async () => {
  const { dir, git } = repo({ withCommit: false, identity: false });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  const sha = await git.checkpoint('agent: first');
  assert.match(sha, /^[0-9a-f]{40}$/);
  const author = execFileSync('git', ['log', '--format=%ae', '-1'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.ok(author.length > 0);
});

test('rollback discards later commits and untracked files, back to a checkpoint', async () => {
  const { dir, git } = repo();
  const base = await git.head();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'junk\n');
  await git.checkpoint('agent: step');
  fs.writeFileSync(path.join(dir, 'more-untracked.txt'), 'junk2\n');
  await git.rollback(base);
  assert.equal(await git.head(), base);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(fs.existsSync(path.join(dir, 'untracked.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'more-untracked.txt')), false);
  assert.equal(await git.isDirty(), false);
});

test('isTracked distinguishes committed files from new ones', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'fresh.txt'), 'x\n');
  assert.equal(await git.isTracked('a.txt'), true);
  assert.equal(await git.isTracked('fresh.txt'), false);
});

test('checkpoint is resilient to a pre-commit hook that would reject (uses --no-verify)', async () => {
  const { dir, git } = repo();
  const hookDir = path.join(dir, '.git', 'hooks');
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const sha = await git.checkpoint('agent: despite hook');
  assert.match(sha, /^[0-9a-f]{40}$/); // the failing hook did not block the checkpoint
});
