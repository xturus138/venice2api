import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from './git.mjs';

export const READ_ONLY_TOOLS = new Set(['fs_list', 'fs_read', 'grep_search', 'git_read', 'test_run']);

export const SHELL_ALLOWLIST = [
  'git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'pytest', 'go', 'cargo',
  'ls', 'cat', 'grep', 'rg', 'find', 'mkdir', 'mv', 'cp',
];

// These run arbitrary project code (package scripts, tests, build scripts).
// The allowlist does not make them safe; see README "Keamanan".
export const RUNS_PROJECT_CODE = new Set(['npm', 'npx', 'node', 'pnpm', 'yarn', 'pytest', 'go', 'cargo']);

const GIT_READ_CMDS = new Set(['status', 'log', 'diff', 'show', 'branch']);
const GIT_SHELL_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame']);
const FIND_BANNED = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const PATH_ARG_CMDS = new Set(['ls', 'cat', 'find', 'mkdir', 'mv', 'cp']);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target', '.next', 'coverage']);

// Files whose content must never be sent to the web chat.
const SECRET_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
];

export class ToolError extends Error {}

export function isSecretPath(rel) {
  return SECRET_PATTERNS.some((re) => re.test(rel.replace(/\\/g, '/')));
}

function scrubEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} karakter dipotong] ...\n${text.slice(-tail)}`;
}

export class Tools {
  constructor(cfg) {
    if (!cfg.root) throw new Error('BRIDGE_ROOT belum diset.');
    this.cfg = cfg;
    this.root = fs.realpathSync(cfg.root);
  }

  // Resolve a model-supplied path and keep it inside the project.
  resolve(p, { forWrite = false } = {}) {
    if (typeof p !== 'string' || p.trim() === '') throw new ToolError('path is required');
    const abs = path.resolve(this.root, p.trim());
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`path is outside the project: ${p}`);
    const parts = rel.split(path.sep);
    if (parts.includes('.git')) throw new ToolError('the .git folder is off limits');
    if (isSecretPath(rel)) throw new ToolError(`refusing to touch a secrets file: ${rel}`);

    // Follow symlinks on the deepest existing ancestor.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const realRel = path.relative(this.root, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new ToolError(`path escapes the project via a symlink: ${p}`);
    if (forWrite && fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new ToolError('refusing to write through a symlink');
    return { abs, rel: rel.split(path.sep).join('/') || '.' };
  }

  async fs_list({ path: p = '.', depth = 2 } = {}) {
    const { abs, rel } = this.resolve(p);
    if (!fs.existsSync(abs)) throw new ToolError(`not found: ${rel}`);
    const maxDepth = Math.min(Math.max(Number(depth) || 2, 1), 5);
    const out = [];
    const walk = (dir, d, prefix) => {
      if (out.length >= 300) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= 300) {
          out.push('... (dipotong di 300 entri)');
          return;
        }
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const relChild = path.posix.join(prefix, e.name);
        out.push(e.isDirectory() ? `${relChild}/` : relChild);
        if (e.isDirectory() && d < maxDepth) walk(path.join(dir, e.name), d + 1, relChild);
      }
    };
    if (fs.statSync(abs).isDirectory()) walk(abs, 1, rel === '.' ? '' : rel);
    else out.push(rel);
    return out.join('\n') || '(empty)';
  }

  async fs_read({ path: p, start = 1, end } = {}) {
    const { abs, rel } = this.resolve(p);
    if (!fs.existsSync(abs)) throw new ToolError(`not found: ${rel}`);
    if (fs.statSync(abs).isDirectory()) throw new ToolError(`${rel} is a directory; use fs_list`);
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new ToolError(`${rel} looks binary`);
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const total = lines.length;
    const s = Math.max(1, Math.floor(Number(start) || 1));
    let e = end ? Math.floor(Number(end)) : s + this.cfg.readMaxLines - 1;
    e = Math.min(e, total, s + this.cfg.readMaxLines - 1);
    if (s > total) throw new ToolError(`${rel} has only ${total} lines`);
    const width = String(e).length;
    let body = '';
    let shownEnd = s - 1;
    for (let i = s; i <= e; i++) {
      const line = `${String(i).padStart(width)}| ${lines[i - 1]}\n`;
      if (body.length + line.length > this.cfg.readMaxChars) break;
      body += line;
      shownEnd = i;
    }
    const more = shownEnd < total ? ` — more below, call fs_read with start=${shownEnd + 1}` : '';
    return `${rel} (lines ${s}-${shownEnd} of ${total}${more})\n${body}`;
  }

  async grep_search({ pattern, path: p = '.', fixed = false, ignore_case = false } = {}) {
    if (typeof pattern !== 'string' || !pattern) throw new ToolError('pattern is required');
    const { rel } = this.resolve(p);
    const args = ['grep', '-n', '-I', '--untracked', '--no-color'];
    if (fixed) args.push('-F');
    else args.push('-E');
    if (ignore_case) args.push('-i');
    args.push('-e', pattern, '--', rel);
    const r = await run('git', args, { cwd: this.root, timeout: 30000 });
    if (r.code === 1 && !r.stderr) return '(no matches)';
    if (r.code !== 0) throw new ToolError((r.stderr || 'grep failed').trim());
    const lines = r.stdout.split('\n').filter(Boolean).filter((l) => !isSecretPath(l.split(':')[0]));
    const shown = lines.slice(0, this.cfg.grepMaxLines).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
    if (lines.length > shown.length) shown.push(`... ${lines.length - shown.length} more matches; narrow the pattern or path`);
    return shown.join('\n');
  }

  async git_read({ cmd = 'status', args = [] } = {}) {
    if (!GIT_READ_CMDS.has(cmd)) throw new ToolError(`git_read cmd must be one of: ${[...GIT_READ_CMDS].join(', ')}`);
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new ToolError('args must be a list of strings');
    if (args.some((a) => /^--(output|ext-diff|exec)|^-c$|^--config/.test(a))) throw new ToolError('that git option is not allowed');
    let final = args;
    if (cmd === 'log' && args.length === 0) final = ['--oneline', '-n', '20'];
    if (cmd === 'status' && args.length === 0) final = ['--short', '--branch'];
    const r = await run('git', ['--no-pager', cmd, '--no-color', ...final], { cwd: this.root, timeout: 30000 });
    const text = (r.stdout + (r.code !== 0 ? `\n${r.stderr}` : '')).trim();
    return truncate(text || '(empty)', this.cfg.outputMaxChars);
  }

  // Runs the user-configured test command. Trusted (it comes from the user, not the model).
  async test_run() {
    if (!this.cfg.testCmd) return { ok: true, code: 0, output: 'No test command configured (BRIDGE_TEST_CMD). Changes are unverified.', configured: false };
    return new Promise((resolve) => {
      const child = spawn(this.cfg.testCmd, { cwd: this.root, shell: true, env: scrubEnv() });
      let out = '';
      const add = (d) => {
        out += d;
        if (out.length > 2_000_000) out = out.slice(-1_000_000);
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => child.kill('SIGKILL'), this.cfg.testTimeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code: code ?? -1, output: out, configured: true });
      });
    });
  }

  // Validate a shell_safe request. Returns { cmd, args, runsCode } or throws.
  checkShell({ cmd, args = [] } = {}) {
    if (typeof cmd !== 'string' || !cmd) throw new ToolError('cmd is required');
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new ToolError('args must be a list of strings');
    if (cmd.includes('/') || cmd.includes(' ')) throw new ToolError('cmd must be a bare program name; put arguments in args');
    const allowed = SHELL_ALLOWLIST.includes(cmd);
    if (allowed) {
      if (cmd === 'git') {
        const sub = args.find((a) => !a.startsWith('-'));
        if (!GIT_SHELL_READ.has(sub)) throw new ToolError('only read-only git subcommands are allowed; commits and rollbacks are handled by the runner');
        if (args.some((a) => /^--(output|ext-diff|exec)|^-c$/.test(a))) throw new ToolError('that git option is not allowed');
      }
      if (cmd === 'find' && args.some((a) => FIND_BANNED.test(a))) throw new ToolError('find with -exec/-delete/-fprint is not allowed');
      if (PATH_ARG_CMDS.has(cmd)) {
        for (const a of args) if (!a.startsWith('-')) this.resolve(a, { forWrite: cmd === 'mv' || cmd === 'cp' || cmd === 'mkdir' });
      }
    }
    return { cmd, args, allowed, runsCode: RUNS_PROJECT_CODE.has(cmd) };
  }

  async shell({ cmd, args }) {
    const r = await run(cmd, args, { cwd: this.root, timeout: this.cfg.shellTimeoutMs, env: scrubEnv() });
    const text = `exit ${r.code}${r.killed ? ' (timeout)' : ''}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
    return truncate(text.trim(), this.cfg.outputMaxChars);
  }
}

// Keep only the lines that explain a failure (plan §8).
export function trimFailures(output, max = 3000) {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const keyRe = /FAIL|Error|error:|expected|received|Expected|Received|AssertionError|assert|Traceback|panic|^\s+at /;
  const keep = new Set();
  lines.forEach((l, i) => {
    if (keyRe.test(l)) for (let k = i; k <= Math.min(i + 3, lines.length - 1); k++) keep.add(k);
  });
  let picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  if (picked.length === 0) picked = lines.slice(-40);
  return truncate(picked.join('\n').trim(), max);
}
