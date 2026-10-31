import { execFile } from 'node:child_process';

export function run(cmd, args, { cwd, timeout = 60000, env, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env, maxBuffer }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), killed: !!err?.killed });
    });
  });
}

export class Git {
  constructor(root) {
    this.root = root;
  }

  async git(args, opts = {}) {
    return run('git', args, { cwd: this.root, ...opts });
  }

  async must(args) {
    const r = await this.git(args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} gagal: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  }

  async isRepo() {
    const r = await this.git(['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  async currentBranch() {
    return this.must(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async hasCommits() {
    return (await this.git(['rev-parse', '--verify', 'HEAD'])).code === 0;
  }

  async head() {
    return this.must(['rev-parse', 'HEAD']);
  }

  async isDirty() {
    return (await this.must(['status', '--porcelain'])).length > 0;
  }

  async isTracked(relPath) {
    return (await this.git(['ls-files', '--error-unmatch', '--', relPath])).code === 0;
  }

  async identityEnv() {
    const email = (await this.git(['config', 'user.email'])).stdout.trim();
    const name = (await this.git(['config', 'user.name'])).stdout.trim();
    const env = { ...process.env };
    if (!email) {
      env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'venice-bridge@localhost';
    }
    if (!name) {
      env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'venice-bridge';
    }
    return env;
  }

  // Commit everything as a checkpoint. Hooks are skipped so a formatter hook can't block the agent.
  async checkpoint(message) {
    await this.must(['add', '-A']);
    const env = await this.identityEnv();
    const r = await this.git(['commit', '-q', '--allow-empty', '--no-verify', '-m', message], { env });
    if (r.code !== 0) throw new Error(`commit gagal: ${(r.stderr || r.stdout).trim()}`);
    return this.head();
  }

  // Throw away everything after `sha`, including new untracked files. Ignored files stay.
  async rollback(sha) {
    await this.must(['reset', '-q', '--hard', sha]);
    await this.must(['clean', '-q', '-fd']);
  }
}
