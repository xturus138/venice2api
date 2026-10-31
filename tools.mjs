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
// Banned: run code / write files / read a reference file (the -newer family and
// -files0-from leak a file's existence or mtime from outside the project).
const FIND_BANNED = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from|(a|c)?newer\w*)$/;

// Per-command rules for shell_safe. Any token that the command could read or write as a
// filesystem path must be resolved inside the project, or be a known non-path value.
//   positionalsArePaths  every non-flag arg is a path (ls, cat, mkdir, mv, cp)
//   write                those paths may be created/overwritten
//   pathValueFlags       flags whose value IS a path (resolve it), e.g. cp --target-directory
//   valueFlags           flags whose value is NOT a path (skip it), e.g. grep -m, rg --glob
//   grep                 first bare positional is the PATTERN unless a pattern-flag cancels it
//   find                 leading positionals are start dirs; the rest is an expression
const SHELL_SPEC = {
  ls: { positionalsArePaths: true },
  cat: { positionalsArePaths: true },
  mkdir: { positionalsArePaths: true, write: true },
  mv: { positionalsArePaths: true, write: true, pathValueFlags: ['-t', '--target-directory'] },
  cp: { positionalsArePaths: true, write: true, pathValueFlags: ['-t', '--target-directory'] },
  find: { find: true },
  grep: {
    grep: true,
    patternCancelFlags: ['-e', '--regexp', '-f', '--file'],
    pathValueFlags: ['-f', '--file'],
    valueFlags: ['-e', '--regexp', '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context', '-d', '--directories', '--color', '--colour', '-D', '--devices'],
  },
  rg: {
    grep: true,
    patternCancelFlags: ['-e', '--regexp', '-f', '--file'],
    pathValueFlags: ['-f', '--file'],
    valueFlags: ['-e', '--regexp', '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--color', '--colors', '-M', '--max-columns', '--sort', '--sortr', '-E', '--encoding'],
  },
};

// git pathspecs that keep secret files out of git grep results (defense in depth;
// the NUL-delimited post-filter in grep_search is authoritative).
const SECRET_EXCLUDES = ['.env', '.env.*', '.npmrc', '.netrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.toml']
  .flatMap((g) => [`:(exclude,glob)${g}`, `:(exclude,glob)**/${g}`]);

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

// Walk an argument list, separating flags from positionals and pulling out the
// tokens that are paths. Returns { positionals, pathArgs, patternCancelled }.
function classifyArgs(args, spec) {
  const positionals = [];
  const pathArgs = [];
  let patternCancelled = false;
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDashDash) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      afterDashDash = true;
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      if (spec.patternCancelFlags?.includes(name)) patternCancelled = true;
      if (spec.pathValueFlags?.includes(name)) {
        const v = inline !== null ? inline : args[++i];
        if (v !== undefined) pathArgs.push(v);
      } else if (spec.valueFlags?.includes(name) && inline === null) {
        i++; // this flag's value is not a path; skip it
      }
      continue;
    }
    positionals.push(a); // bare arg, or a single "-" (stdin)
  }
  return { positionals, pathArgs, patternCancelled };
}

// find's start directories are the leading positionals, before the expression begins.
function findStartDirs(args) {
  const dirs = [];
  for (const a of args) {
    if (a.startsWith('-') || a === '(' || a === ')' || a === '!' || a === ',') break;
    dirs.push(a);
  }
  return dirs.length ? dirs : ['.'];
}

// Reject git arguments that could read files outside the project or leak secrets.
function checkGitArgs(args) {
  for (const a of args) {
    if (a === '--no-index') throw new ToolError('git --no-index is not allowed (it can read files outside the project)');
    if (/^--(output|ext-diff|exec|config)(=|$)/.test(a) || a === '-c') throw new ToolError('that git option is not allowed');
    if (a.startsWith('-')) continue;
    // A pathspec, possibly "<rev>:<path>". Check the path part and the whole token.
    const pathPart = a.includes(':') ? a.slice(a.lastIndexOf(':') + 1) : a;
    if (path.isAbsolute(pathPart) || pathPart.startsWith('..')) throw new ToolError(`git path is outside the project: ${a}`);
    if (isSecretPath(pathPart) || isSecretPath(a)) throw new ToolError(`refusing to read a secrets file via git: ${a}`);
  }
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
  // allowSecret skips ONLY the secret-file check (used by the masked .env reader); every
  // other jail check still applies.
  resolve(p, { forWrite = false, allowSecret = false } = {}) {
    if (typeof p !== 'string' || p.trim() === '') throw new ToolError('path is required');
    const abs = path.resolve(this.root, p.trim());
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`path is outside the project: ${p}`);
    const parts = rel.split(path.sep);
    if (parts.includes('.git')) throw new ToolError('the .git folder is off limits');
    if (!allowSecret && isSecretPath(rel)) {
      const hint = /(^|\/)\.env(\..*)?$/i.test(rel) ? ' — use fs_read (with BRIDGE_ENV_KEYS=1) to see its keys with values masked' : '';
      throw new ToolError(`refusing to touch a secrets file: ${rel}${hint}`);
    }

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
    // Listing only exposes names, never content, so a secret path may be listed.
    const { abs, rel } = this.resolve(p, { allowSecret: true });
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
    // Resolve without the secret check first, so a secret path can be handled deliberately
    // (masked, or refused with a clear message) rather than leaking or confusing the model.
    const { abs, rel } = this.resolve(p, { allowSecret: true });
    if (isSecretPath(rel)) return this.readSecret(abs, rel);
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

  // Secret files are never returned verbatim. For .env-style files, when the user opted in
  // (BRIDGE_ENV_KEYS), show the KEY names with values masked so the agent knows what exists.
  readSecret(abs, rel) {
    if (!fs.existsSync(abs)) throw new ToolError(`not found: ${rel}`);
    const isEnv = /(^|\/)\.env(\..*)?$/i.test(rel);
    if (!isEnv || !this.cfg.revealEnvKeys) {
      const hint = isEnv ? ' Set BRIDGE_ENV_KEYS=1 to see its keys with values masked.' : ' Its contents are never sent to the web chat.';
      throw new ToolError(`refusing to read a secrets file: ${rel}.${hint}`);
    }
    const out = [];
    for (const line of fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) {
        out.push(line);
        continue;
      }
      const m = t.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      out.push(m ? `${m[2]}=***` : '***');
    }
    return `${rel} (values masked; keys only)\n${out.join('\n')}`;
  }

  async grep_search({ pattern, path: p = '.', fixed = false, ignore_case = false } = {}) {
    if (typeof pattern !== 'string' || !pattern) throw new ToolError('pattern is required');
    const { rel } = this.resolve(p);
    // --null makes the output "path\0lineno\0content", so the path parses cleanly even if it
    // contains a colon. The exclude pathspecs keep most secret files out to begin with.
    const args = ['grep', '-n', '-I', '--untracked', '--no-color', '--null'];
    args.push(fixed ? '-F' : '-E');
    if (ignore_case) args.push('-i');
    args.push('-e', pattern, '--', rel, ...SECRET_EXCLUDES);
    const r = await run('git', args, { cwd: this.root, timeout: 30000 });
    if (r.code === 1 && !r.stderr) return '(no matches)';
    if (r.code !== 0) throw new ToolError((r.stderr || 'grep failed').trim());
    const lines = [];
    for (const raw of r.stdout.split('\n')) {
      if (!raw) continue;
      const nul = raw.indexOf('\0');
      const file = nul === -1 ? raw : raw.slice(0, nul);
      if (isSecretPath(file)) continue; // authoritative secret filter
      const line = raw.replace(/\0/g, ':');
      lines.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
    }
    const shown = lines.slice(0, this.cfg.grepMaxLines);
    if (lines.length > shown.length) shown.push(`... ${lines.length - shown.length} more matches; narrow the pattern or path`);
    return shown.length ? shown.join('\n') : '(no matches)';
  }

  async git_read({ cmd = 'status', args = [] } = {}) {
    if (!GIT_READ_CMDS.has(cmd)) throw new ToolError(`git_read cmd must be one of: ${[...GIT_READ_CMDS].join(', ')}`);
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new ToolError('args must be a list of strings');
    checkGitArgs(args);
    let final = args;
    if (cmd === 'log' && args.length === 0) final = ['--oneline', '-n', '20'];
    if (cmd === 'status' && args.length === 0) final = ['--short', '--branch'];
    // Keep secret files out of full diffs/logs/shows even when they are tracked.
    if (['diff', 'log', 'show'].includes(cmd)) {
      if (!final.includes('--')) final = [...final, '--'];
      final = [...final, ...SECRET_EXCLUDES];
    }
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

  // Validate a shell_safe request. Returns { cmd, args, allowed, runsCode } or throws.
  checkShell({ cmd, args = [] } = {}) {
    if (typeof cmd !== 'string' || !cmd) throw new ToolError('cmd is required');
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new ToolError('args must be a list of strings');
    if (cmd.includes('/') || cmd.includes(' ')) throw new ToolError('cmd must be a bare program name; put arguments in args');
    const allowed = SHELL_ALLOWLIST.includes(cmd);
    if (allowed) this.checkAllowedShell(cmd, args);
    return { cmd, args, allowed, runsCode: RUNS_PROJECT_CODE.has(cmd) };
  }

  // Every token a safe command could touch as a path must resolve inside the project.
  checkAllowedShell(cmd, args) {
    if (cmd === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!GIT_SHELL_READ.has(sub)) throw new ToolError('only read-only git subcommands are allowed; commits and rollbacks are handled by the runner');
      checkGitArgs(args);
      return;
    }
    if (cmd === 'find') {
      if (args.some((a) => FIND_BANNED.test(a))) throw new ToolError('find action/file flags are not allowed: -exec/-execdir/-ok, -delete, -fprint*/-fls, -files0-from, and -newer* (which reads a reference file)');
      for (const d of findStartDirs(args)) this.resolve(d);
      return;
    }
    const spec = SHELL_SPEC[cmd];
    if (!spec) return; // allowlisted but runs project code (npm, node, ...); no path args to police here
    const { positionals, pathArgs, patternCancelled } = classifyArgs(args, spec);
    for (const p of pathArgs) this.resolve(p, { forWrite: !!spec.write });
    let paths = positionals.filter((p) => p !== '-');
    if (spec.grep && !patternCancelled) paths = paths.slice(1); // first positional is the search pattern
    for (const p of paths) this.resolve(p, { forWrite: !!spec.write });
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
