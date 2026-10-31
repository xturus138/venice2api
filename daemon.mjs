#!/usr/bin/env node
// Entry point: WebSocket server for the browser extension + terminal UI + runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.mjs';
import { Store } from './state.mjs';
import { Runner } from './runner.mjs';
import { Git } from './git.mjs';
import { catalog } from './prompts.mjs';

const ALLOWED_ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;

export function loadToken(workspace) {
  const file = path.join(workspace, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

// The extension side of the conversation, over WebSocket.
export class WsBrain {
  constructor({ port, token, extOrigin, replyTimeoutMs, onStop, onLog = () => {} }) {
    this.port = port;
    this.token = token;
    this.extOrigin = extOrigin;
    this.replyTimeoutMs = replyTimeoutMs;
    this.onStop = onStop;
    this.onLog = onLog;
    this.client = null;
    this.tabReady = false;
    this.pending = new Map();
    this.seq = 0;
    this.waiters = [];
    this.stopped = false;
    this.stopReason = '';
  }

  listen() {
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
      maxPayload: 8 * 1024 * 1024,
      // The token travels in the WebSocket subprotocol, not the URL, so it stays out of
      // request-URL access logs. Legacy ?token= is still accepted for older builds.
      handleProtocols: (protocols) => (protocols.has('venice-bridge') ? 'venice-bridge' : false),
      verifyClient: ({ origin, req }, cb) => {
        const url = new URL(req.url, 'http://localhost');
        const offered = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
        const tok = offered.find((p) => p !== 'venice-bridge') || url.searchParams.get('token') || '';
        const okOrigin = this.extOrigin ? origin === this.extOrigin : ALLOWED_ORIGIN.test(origin || '');
        const okToken = tok.length === this.token.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(this.token));
        if (!okOrigin || !okToken) {
          this.onLog(`koneksi ditolak (origin=${origin || '-'}, token ${okToken ? 'ok' : 'salah'})`);
          return cb(false, 403, 'Forbidden');
        }
        cb(true);
      },
    });
    this.wss.on('connection', (ws) => this.attach(ws));
    this.ping = setInterval(() => this.client?.send(JSON.stringify({ type: 'ping' })), 20000);
    return new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
  }

  attach(ws) {
    if (this.client && this.client !== ws) this.client.close(4000, 'replaced');
    this.client = ws;
    this.tabReady = false;
    this.onLog('extension terhubung');
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'hello' || msg.type === 'tab') {
        this.tabReady = !!msg.tabReady;
        if (this.tabReady) this.flushWaiters();
        // Tab closed or reloaded: no reply is coming for anything in flight.
        else this.rejectPending('tab Venice ditutup atau dimuat ulang saat menunggu balasan');
      } else if (msg.type === 'stop') {
        this.onStop?.('tombol Stop di panel');
      } else if (msg.type === 'reply') {
        // id 0 is the content script's pagehide signal: the tab is going away, so fail
        // whatever is in flight rather than wait for the socket close to notice.
        if (msg.id === 0) return this.rejectPending(`extension: ${msg.error || 'tab ditutup'}`);
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve({ text: msg.text || '', model: msg.model });
        else {
          const e = new Error(msg.error || 'gagal');
          if (msg.code) e.code = msg.code; // blocked | limit | loggedout, so the runner can halt cleanly
          p.reject(e);
        }
      }
    });
    ws.on('close', () => {
      if (this.client !== ws) return;
      this.client = null;
      this.tabReady = false;
      this.onLog('extension terputus');
      this.rejectPending('extension terputus saat menunggu balasan');
    });
  }

  rejectPending(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
    const w = this.waiters;
    this.waiters = [];
    w.forEach((x) => x.reject(new Error(reason)));
  }

  flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((x) => x.resolve());
  }

  // Resolves when a tab is ready; rejects if the run is cancelled while we wait.
  waitReady() {
    if (this.stopped) return Promise.reject(new Error(this.stopReason || 'dihentikan'));
    if (this.client && this.tabReady) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  status(text) {
    this.client?.send(JSON.stringify({ type: 'status', text }));
  }

  async send(text, { newChat = false, modelPattern = '' } = {}) {
    await this.waitReady();
    if (this.stopped) throw new Error(this.stopReason || 'dihentikan');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`tidak ada balasan dalam ${Math.round(this.replyTimeoutMs / 1000)} detik`));
      }, this.replyTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client.send(JSON.stringify({ type: 'send', id, text, newChat, modelPattern }));
    });
  }

  cancel(reason) {
    this.stopped = true;
    this.stopReason = reason;
    this.client?.send(JSON.stringify({ type: 'cancel' }));
    this.rejectPending(reason);
  }

  close() {
    clearInterval(this.ping);
    this.wss?.close();
    for (const c of this.wss?.clients ?? []) c.terminate();
  }
}

export class TerminalUI {
  constructor(brain) {
    this.brain = brain;
    // Queue lines ourselves so answers typed (or piped) early are not lost.
    this.lines = [];
    this.waiting = null;
    this.closed = false;
    this.rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
    this.rl.on('line', (l) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w.resolve(l);
      } else this.lines.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.waiting?.reject(new Error('input terminal ditutup'));
    });
  }
  print(text) {
    console.log(text);
  }
  status(text) {
    this.brain?.status(text);
  }
  question(q) {
    process.stdout.write(`${q}\n> `);
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.reject(new Error('input terminal ditutup'));
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }
  async input(q) {
    return (await this.question(q)).trim();
  }
  async choose(q, choices) {
    const keys = Object.keys(choices);
    const label = keys.map((k) => `[${k}] ${choices[k]}`).join('  ');
    while (true) {
      const a = (await this.question(`${q} ${label}`)).trim().toLowerCase();
      if (keys.includes(a)) return a;
    }
  }
  async confirm(q) {
    return (await this.choose(q, { y: 'ya', n: 'tidak' })) === 'y';
  }
  close() {
    this.rl.close();
  }
}

const HELP = `venice-bridge — agent coding lokal dengan Venice web sebagai otak

Pemakaian:
  node daemon.mjs run "<deskripsi task>"   mulai task baru
  node daemon.mjs resume                   lanjutkan task yang terputus
  node daemon.mjs status                   tampilkan state.json
  node daemon.mjs abandon [--delete-branch] rollback ke checkpoint 0, kembali ke branch awal, hapus state
  node daemon.mjs token                    tampilkan token untuk extension
  node daemon.mjs catalog                  cetak katalog tool (opsional: tempel di Custom Instructions)

Variabel lingkungan utama:
  BRIDGE_ROOT       folder proyek (WAJIB salinan, bukan asli)
  BRIDGE_TEST_CMD   perintah test, mis. "npm test"
  BRIDGE_AUTONOMY   L1 (default) | L2 | L3
  BRIDGE_MODEL      regex nama model, default "deepseek" (kosongkan untuk tidak dicek)
  BRIDGE_ENV_KEYS   "1" untuk mengizinkan fs_read file .env dengan nilai dimasking (default mati)
  BRIDGE_PORT       default 8765
  BRIDGE_EXT_ORIGIN opsional, mis. chrome-extension://<id> untuk mengunci ke satu extension`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const cfg = loadConfig();
  const store = new Store(cfg.workspace);

  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP);
  if (cmd === 'catalog') return console.log(catalog());
  if (cmd === 'token') return console.log(loadToken(cfg.workspace));
  if (cmd === 'status') return console.log(JSON.stringify(store.load(), null, 2) ?? 'Tidak ada task.');

  if (cmd === 'abandon') {
    const s = store.load();
    if (!s) return console.log('Tidak ada task.');
    if (!cfg.root) throw new Error('Set BRIDGE_ROOT dulu.');
    const git = new Git(cfg.root);
    // A finished task keeps its branch as is; only unfinished work is thrown away.
    if (s.phase !== 'done') {
      if ((await git.currentBranch()) !== s.branch) await git.must(['switch', '-q', s.branch]);
      await git.rollback(s.checkpoints[0].sha);
    }
    const deleteBranch = rest.includes('--delete-branch');
    if (s.baseBranch) {
      await git.must(['switch', '-q', s.baseBranch]);
      if (deleteBranch && s.phase !== 'done') {
        await git.git(['branch', '-D', s.branch]);
        console.log(`Kembali ke ${s.baseBranch}. Branch ${s.branch} dihapus.`);
      } else {
        console.log(`Kembali ke ${s.baseBranch}. Branch ${s.branch} masih ada (perubahan yang belum di-commit sebelum task tersimpan di checkpoint 0 di sana). Hapus dengan: git branch -D ${s.branch}${s.phase === 'done' ? '' : ', atau jalankan abandon --delete-branch'}`);
      }
    }
    store.reset();
    return console.log('State dihapus. File .bak (jika ada) ada di workspace/bak/.');
  }

  if (cmd !== 'run' && cmd !== 'resume') {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  if (!cfg.root) throw new Error('Set BRIDGE_ROOT ke salinan proyekmu dulu.');
  const task = rest.join(' ').trim();
  if (cmd === 'run' && !task) throw new Error('Tulis deskripsi task: node daemon.mjs run "..."');

  const token = loadToken(cfg.workspace);
  let runner;
  const brain = new WsBrain({
    port: cfg.port,
    token,
    extOrigin: process.env.BRIDGE_EXT_ORIGIN || '',
    replyTimeoutMs: cfg.replyTimeoutMs,
    onStop: (why) => runner?.stop(why),
    onLog: (t) => console.log(`[bridge] ${t}`),
  });
  await brain.listen();
  const ui = new TerminalUI(brain);
  runner = new Runner({ cfg, store, brain, ui });

  let sigints = 0;
  process.on('SIGINT', () => {
    if (++sigints > 1) process.exit(130);
    console.log('\nMenghentikan... (Ctrl+C sekali lagi untuk keluar paksa)');
    runner.stop('Ctrl+C');
  });

  console.log(`[bridge] ws://127.0.0.1:${cfg.port} · proyek ${cfg.root} · otonomi ${cfg.autonomy} · test: ${cfg.testCmd || '(tidak ada)'}`);
  if (!brain.client) console.log('[bridge] Menunggu extension. Buka tab Venice di Chrome (token: node daemon.mjs token).');

  try {
    if (cmd === 'run') await runner.start(task);
    else await runner.resume();
  } finally {
    ui.close();
    brain.close();
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.on('unhandledRejection', (err) => {
    console.error(`Unhandled rejection: ${err?.message || err}`);
    process.exit(1);
  });
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
