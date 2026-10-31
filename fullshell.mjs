// Full shell tools (bash / powershell / cmd), enabled only with BRIDGE_SHELL=full.
//
// This is NOT a sandbox. The command runs with the user's own privileges and can read or
// write anything the user can. What this module adds is hygiene around that:
//   - secret-looking env vars are stripped (unless explicitly kept),
//   - output is redacted (best effort) before it is sent to the web chat,
//   - risky-looking commands are flagged so the runner can always ask first,
//   - the whole process tree is killed on timeout / Stop.
import { spawn, spawnSync } from 'node:child_process';

const SECRET_ENV_RE = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL/i;

// Env passed to child processes: drop secret-looking names unless listed in `keep`.
export function scrubEnv(env = process.env, keep = []) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k) && !keep.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---------- output redaction (best effort, not a guarantee) ----------

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED]'],
  // NAME=value / NAME: value where the name looks secret. Keep the name, mask the value.
  [/((?:[A-Za-z0-9_.-]*)(?:api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi, '$1[REDACTED]'],
];

export function redactSecrets(text) {
  let out = String(text);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

// ---------- risk flags (a speed bump that forces a confirmation, not a boundary) ----------

const RISKS = [
  [/\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]|\brm\s+--recursive|\brm\s+-[a-zA-Z]*f/, 'menghapus file (rm -r/-f)'],
  [/\bRemove-Item\b[^\n]*-Recurse|\brmdir\s+\/s|\bdel\s+\/[sfq]|\brd\s+\/s|\bformat\s+[a-z]:/i, 'menghapus file/format (Windows)'],
  [/\b(?:sudo|doas)\b|(?:^|[;&|]\s*)su\s/, 'hak istimewa (sudo/su)'],
  [/\bgit\s+(?:push|reset\s+--hard|clean\b|rebase|filter-branch|branch\s+-D|checkout\s+--|stash\s+drop)/, 'mengubah/menghapus riwayat git atau push'],
  [/\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, 'mengunduh lalu langsung menjalankan skrip'],
  [/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i, 'mengunduh lalu langsung menjalankan skrip'],
  [/\bcurl\b[^\n]*(?:\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b)/i, 'mengirim data keluar (curl)'],
  [/\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*-(?:Body|InFile|Method\s+(?:Post|Put|Patch|Delete))\b/i, 'mengirim data keluar (PowerShell)'],
  [/\b(?:scp|sftp|rsync|nc|ncat|netcat)\b/, 'transfer jaringan (scp/rsync/nc)'],
  [/\b(?:mkfs|shred|fdisk|diskpart)\b|\bdd\s+[^\n]*\bof=/, 'operasi disk'],
  [/\bchmod\s+-R|\bchown\s+-R|\bSet-ExecutionPolicy\b|\breg\s+(?:add|delete)\b/i, 'mengubah izin/registry'],
  // Touching secret-looking files. The path denylist does not apply inside a shell.
  [/(?:^|[\s'"\/=])\.env(?:\.[\w.-]+)?(?=$|[\s'";|&)])|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.(?:pem|p12|pfx|jks)\b|\.npmrc\b|\.netrc\b|\.aws\b|\.ssh\b|\.gnupg\b|\bcredentials(?:\.json)?\b/i, 'menyentuh file yang tampak rahasia'],
];

// Returns a list of Indonesian reasons (empty = nothing flagged).
export function riskReasons(command) {
  const reasons = [];
  for (const [re, why] of RISKS) if (re.test(command) && !reasons.includes(why)) reasons.push(why);
  return reasons;
}

// ---------- shell detection ----------

const SHELLS = {
  bash: { candidates: [{ cmd: 'bash', args: ['-c'], probe: ['--version'] }] },
  powershell: {
    candidates: [
      { cmd: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], probe: ['-NoLogo', '-NoProfile', '-Command', 'exit 0'] },
      { cmd: 'powershell', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], probe: ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], windowsOnly: true },
    ],
  },
  cmd: { candidates: [{ cmd: 'cmd.exe', args: ['/d', '/s', '/c'], probe: ['/d', '/c', 'exit 0'], windowsOnly: true }] },
};

function defaultProbe(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 4000, windowsHide: true });
  return !r.error && r.status === 0;
}

// -> { bash?: {cmd,args}, powershell?: {cmd,args}, cmd?: {cmd,args} }
export function detectShells({ platform = process.platform, probe = defaultProbe } = {}) {
  const found = {};
  for (const [name, def] of Object.entries(SHELLS)) {
    for (const c of def.candidates) {
      if (c.windowsOnly && platform !== 'win32') continue;
      if (probe(c.cmd, c.probe)) {
        found[name] = { cmd: c.cmd, args: c.args };
        break;
      }
    }
  }
  return found;
}

// ---------- process-tree kill ----------

export function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // the child leads its own process group
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n... [${text.length - max} karakter dipotong] ...\n${text.slice(-(max - head))}`;
}

// ---------- runner ----------

export class FullShell {
  constructor({ cwd, cfg, shells = null }) {
    this.cwd = cwd;
    this.cfg = cfg;
    this._shells = shells; // injectable for tests; otherwise detected lazily
    this.active = null;
    this.spawned = new Set();
  }

  get shells() {
    if (!this._shells) this._shells = detectShells();
    return this._shells;
  }

  available() {
    return Object.keys(this.shells);
  }

  env() {
    return {
      ...scrubEnv(process.env, this.cfg.shellKeepEnv || []),
      // Never wait on an interactive prompt or pager: there is no terminal to answer it.
      GIT_TERMINAL_PROMPT: '0',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      TERM: 'dumb',
      NO_COLOR: '1',
    };
  }

  clampTimeout(seconds) {
    const def = this.cfg.shellTimeoutMs;
    const ms = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Number(seconds) * 1000 : def;
    return Math.min(ms, this.cfg.shellMaxTimeoutMs);
  }

  // Kill the command that is running right now (used by Stop).
  abort() {
    this.active?.abort();
  }

  // Kill anything still alive from earlier calls (background processes the model started).
  killAll() {
    for (const child of this.spawned) killTree(child);
    this.spawned.clear();
  }

  /** @returns {Promise<{code:number|null, output:string, timedOut:boolean, aborted:boolean}>} */
  run(shellName, command, { timeoutMs } = {}) {
    const spec = this.shells[shellName];
    if (!spec) return Promise.resolve({ code: -1, output: `${shellName} is not available on this machine.`, timedOut: false, aborted: false });
    const limit = timeoutMs ?? this.cfg.shellTimeoutMs;

    return new Promise((resolve) => {
      let child;
      let timedOut = false;
      let aborted = false;
      try {
        child = spawn(spec.cmd, [...spec.args, command], {
          cwd: this.cwd,
          env: this.env(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32', // own process group, so killTree gets the lot
          windowsHide: true,
        });
      } catch (err) {
        return resolve({ code: -1, output: `could not start ${shellName}: ${err.message}`, timedOut: false, aborted: false });
      }
      // Handle for abort(): marks the result as user-stopped, then kills the process tree.
      const handle = {
        abort: () => {
          aborted = true;
          killTree(child);
        },
      };
      this.active = handle;
      this.spawned.add(child);

      let out = '';
      let done = false;
      const add = (d) => {
        out += d;
        if (out.length > 1_000_000) out = out.slice(-500_000); // keep the tail, bound memory
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);

      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (this.active === handle) this.active = null;
        resolve({ code, output: out, timedOut, aborted });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, limit);
      let graceTimer = null;

      child.on('error', (err) => {
        out += `\n${err.message}`;
        finish(-1);
      });
      // A backgrounded grandchild can hold the pipes open long after the shell exited.
      // Resolve shortly after exit instead of waiting for the pipes to close.
      child.on('exit', (code, signal) => {
        graceTimer = setTimeout(() => finish(code ?? (signal ? -1 : 0)), 300);
      });
      child.on('close', (code, signal) => finish(code ?? (signal ? -1 : 0)));
    });
  }

  // Format a result for the model: redact first, then truncate.
  format(res, max = this.cfg.shellOutputMaxChars) {
    const head = res.timedOut ? 'exit: timeout (killed)' : res.aborted ? 'exit: stopped by user' : `exit ${res.code}`;
    const body = truncateMiddle(redactSecrets(res.output.replace(/\r\n/g, '\n')).trim(), max);
    return `${head}\n${body || '(no output)'}`;
  }
}
