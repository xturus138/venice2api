import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Git } from './git.mjs';
import { jittered } from './config.mjs';
import { riskReasons } from './fullshell.mjs';
import { Tools, ToolError, READ_ONLY_TOOLS, trimFailures } from './tools.mjs';
import { parseReply } from './protocol.mjs';
import { applySearchReplace, previewPatch } from './patches.mjs';
import * as P from './prompts.mjs';

export class StopError extends Error {}

const EXPLORE_TOOLS = new Set(['fs_list', 'fs_read', 'grep_search', 'git_read', 'halt']);
const TEST_FILE_RE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const MAX_PARSE_FAILS = 3;
const MAX_DISTINCT_FAILURES = 3;
const MAX_TOTAL_FAILURES = 6;
const SAME_ERROR_REREAD = 3;

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function failureHash(output) {
  // Ignore what changes between identical failures: timings, line:col positions, addresses.
  const norm = output
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, 'T')
    .replace(/:\d+(:\d+)?\b/g, ':L')
    .replace(/0x[0-9a-f]+/gi, '0xA');
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * brain: { send(text, { newChat, modelPattern }) -> Promise<{ text }>, cancel?() }
 * ui:    { print(text), status(text), choose(question, choices) -> key, input(question) -> text, confirm(question) -> bool }
 */
export class Runner {
  constructor({ cfg, store, brain, ui }) {
    this.cfg = cfg;
    this.store = store;
    this.brain = brain;
    this.ui = ui;
    this.tools = new Tools(cfg);
    this.git = new Git(this.tools.root);
    this.stopped = false;
    this.needNewChat = false;
    this.pending = null;
    this.state = null;
  }

  stop(reason = 'stopped by user') {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.tools.full.abort(); // kill a full-shell command that is running right now
    this.brain.cancel?.(reason);
  }

  // Which full-shell tools to advertise to the model (none unless BRIDGE_SHELL=full).
  promptOpts() {
    return { shells: this.cfg.shellMode === 'full' ? this.tools.full.available() : [] };
  }

  // Tell the user the full shell is on; in L3 make them acknowledge it once per run.
  async confirmFullShell() {
    if (this.cfg.shellMode !== 'full') return;
    const shells = this.tools.full.available();
    if (!shells.length) {
      this.ui.print('BRIDGE_SHELL=full aktif, tetapi bash/powershell/cmd tidak ditemukan di mesin ini. Shell penuh dimatikan.');
      return;
    }
    this.ui.print(`Shell penuh AKTIF (${shells.join(', ')}). Perintah berjalan dengan hak aksesmu sendiri dan bukan di sandbox.`);
    if (this.cfg.autonomy === 'L3') {
      const ok = await this.ui.confirm(
        'Otonomi L3 + shell penuh: perintah berjalan otomatis tanpa konfirmasi (hanya yang ditandai berisiko yang tetap bertanya). Pakai hanya di container/VM. Lanjut?',
      );
      if (!ok) throw new Error('Dibatalkan: L3 dengan shell penuh tidak disetujui. Pakai BRIDGE_AUTONOMY=L1 atau L2.');
    }
  }

  save() {
    this.store.save(this.state);
  }

  log(event) {
    this.store.log({ phase: this.state?.phase, ...event });
  }

  lastCheckpoint() {
    return this.state.checkpoints[this.state.checkpoints.length - 1].sha;
  }

  // ---------- lifecycle ----------

  async start(task) {
    const existing = this.store.load();
    if (existing && !['done', 'halted'].includes(existing.phase)) {
      throw new Error(`Masih ada task yang belum selesai ("${existing.task}"). Jalankan "resume" atau "abandon" dulu.`);
    }
    if (!(await this.git.isRepo())) throw new Error(`${this.tools.root} bukan repo git. Jalankan "git init" di salinan proyekmu dulu.`);
    await this.confirmFullShell();

    const baseBranch = (await this.git.hasCommits()) ? await this.git.currentBranch() : null;
    const slug = slugify(task);
    const branch = `agent/${slug}-${Date.now().toString(36)}`;
    await this.git.must(['switch', '-q', '-c', branch]);
    const sha0 = await this.git.checkpoint(`agent: checkpoint 0 — ${task.slice(0, 60)}`);

    this.store.reset();
    this.state = {
      version: 1,
      task,
      slug,
      branch,
      baseBranch,
      phase: 'exploring',
      checkpoints: [{ sha: sha0, label: 'checkpoint 0', step: 0 }],
      exploreSteps: 0,
      execSteps: 0,
      planStep: 1,
      failures: { hashes: [], total: 0 },
      mustReread: false,
      blockedSteps: [],
      createdAt: new Date().toISOString(),
    };
    this.save();
    this.log({ type: 'start', task, branch, sha0 });
    this.ui.print(`Branch ${branch} dibuat, checkpoint 0 = ${sha0.slice(0, 8)}.`);

    this.needNewChat = true;
    this.pending = P.exploreStart(task, this.cfg.maxExploreSteps, this.promptOpts());
    return this.loop();
  }

  async resume() {
    const s = this.store.load();
    if (!s) throw new Error('Tidak ada task untuk dilanjutkan.');
    if (s.phase === 'done') throw new Error('Task sudah selesai.');
    await this.confirmFullShell();
    this.state = s;
    this.state.paused = false;

    if ((await this.git.currentBranch()) !== s.branch) await this.git.must(['switch', '-q', s.branch]);
    // Roll back when work is half done OR when HEAD is no longer the last checkpoint
    // (history was rewound, or a crash landed between the commit and the state save).
    if ((await this.git.isDirty()) || (await this.git.head()) !== this.lastCheckpoint()) {
      this.ui.print(`Keadaan git tidak sama dengan checkpoint terakhir (ada perubahan setengah jalan atau riwayat bergeser). Rollback ke checkpoint terakhir ${this.lastCheckpoint().slice(0, 8)}.`);
      await this.git.rollback(this.lastCheckpoint());
    }
    if (s.phase === 'halted') {
      s.phase = s.haltedFrom || 'executing';
      // Give a halted run some room again instead of hitting the same limit at once.
      if (s.phase === 'executing') s.execSteps = Math.min(s.execSteps, Math.max(0, this.cfg.maxExecSteps - 15));
      if (s.phase === 'exploring') s.exploreSteps = Math.min(s.exploreSteps, Math.max(0, this.cfg.maxExploreSteps - 4));
    }
    this.log({ type: 'resume' });
    this.save();

    if (s.phase === 'exploring' || s.phase === 'executing') {
      this.needNewChat = true;
      this.pending = P.resume(s, this.store.doc('PLAN.md'), this.store.doc('NOTES.md'), this.store.focus(), this.promptOpts());
    }
    return this.loop();
  }

  async loop() {
    try {
      while (!this.stopped) {
        this.ui.status(`${this.state.phase} · langkah plan ${this.state.planStep}`);
        switch (this.state.phase) {
          case 'exploring': await this.explore(); break;
          case 'gate': await this.gate(); break;
          case 'executing': await this.execute(); break;
          case 'review': await this.review(); break;
          default: return this.state;
        }
      }
      throw new StopError(this.stopReason);
    } catch (err) {
      if (err instanceof StopError || this.stopped) {
        this.state.paused = true;
        this.state.haltReason = this.stopReason || err.message;
        this.save();
        this.log({ type: 'stopped', reason: this.state.haltReason });
        this.ui.print(`Dihentikan: ${this.state.haltReason}. Lanjutkan nanti dengan "resume".`);
        return this.state;
      }
      // A blocker in the web UI (CAPTCHA, limit modal, logout) is not a code failure and the
      // work so far may be fine. Halt with the code so resume can continue; do not consume a
      // step and do not roll back.
      if (['blocked', 'limit', 'loggedout'].includes(err.code)) {
        this.halt(`[${err.code}] ${err.message}`);
        this.ui.print('Selesaikan penghalang di tab Venice secara manual, lalu jalankan "resume".');
        return this.state;
      }
      this.halt(`error: ${err.message}`);
      throw err;
    } finally {
      this.tools.full.killAll(); // background processes the model started must not outlive the run
      this.ui.status(`selesai: ${this.state.phase}`);
    }
  }

  halt(reason) {
    if (!['halted', 'done'].includes(this.state.phase)) this.state.haltedFrom = this.state.phase;
    this.state.phase = 'halted';
    this.state.haltReason = reason;
    this.save();
    this.log({ type: 'halt', reason });
    this.ui.print(`HALT: ${reason}`);
  }

  // ---------- talking to the brain ----------

  async ask(text) {
    if (this.stopped) throw new StopError(this.stopReason);
    if (this.cfg.stepDelayMs > 0) await sleep(jittered(this.cfg.stepDelayMs, this.cfg.delayJitter));
    if (this.stopped) throw new StopError(this.stopReason);
    this.log({ type: 'send', chars: text.length, newChat: this.needNewChat });
    let reply;
    try {
      reply = await this.brain.send(text, { newChat: this.needNewChat, modelPattern: this.cfg.modelPattern });
    } catch (err) {
      if (this.stopped) throw new StopError(this.stopReason);
      throw err;
    }
    this.needNewChat = false;
    if (this.stopped) throw new StopError(this.stopReason);
    this.log({ type: 'reply', model: reply.model, text: reply.text });
    return reply.text;
  }

  // ---------- phase 1: exploration ----------

  async explore() {
    const s = this.state;
    const max = this.cfg.maxExploreSteps;
    let msg = this.pending ?? P.formatError('Continue.', P.exploreFooter(max - s.exploreSteps));
    this.pending = null;
    let parseFails = 0;
    let finalCall = false;

    while (true) {
      const text = await this.ask(msg);
      s.exploreSteps++;
      this.save();
      const left = max - s.exploreSteps;
      const footer = P.exploreFooter(left);
      const r = parseReply(text);

      if (r.kind === 'plan') {
        this.store.writeDoc('PLAN.md', r.plan.trim() + '\n');
        this.store.writeDoc('NOTES.md', (r.notes || '').trim() + '\n');
        s.phase = 'gate';
        this.save();
        this.log({ type: 'plan' });
        return;
      }
      if (finalCall) return this.halt('batas eksplorasi tercapai dan model tidak mengirim PLAN');

      if (r.kind === 'error') {
        if (++parseFails >= MAX_PARSE_FAILS) return this.halt(`format balasan salah ${MAX_PARSE_FAILS}x berturut-turut`);
        msg = P.formatError(r.error, footer);
      } else if (r.kind === 'edits') {
        parseFails = 0;
        msg = P.formatError('Edits are not allowed during exploration (read-only).', footer);
      } else {
        parseFails = 0;
        if (r.tool === 'halt') return this.halt(`model: ${r.args.reason || 'halt'}`);
        msg = EXPLORE_TOOLS.has(r.tool)
          ? P.result(r.tool, await this.runReadTool(r.tool, r.args), footer)
          : P.formatError(`"${r.tool}" is not available during exploration. Use fs_list, fs_read, grep_search or git_read.`, footer);
      }
      if (left <= 0) finalCall = true;
    }
  }

  async runReadTool(tool, args) {
    try {
      const out = await this.tools[tool](args);
      if (tool === 'fs_read') this.state.mustReread = false;
      this.log({ type: 'tool', tool, args, ok: true });
      return out;
    } catch (err) {
      this.log({ type: 'tool', tool, args, ok: false, error: err.message });
      if (err instanceof ToolError) return `ERROR: ${err.message}`;
      throw err;
    }
  }

  // ---------- gate: human approves the plan ----------

  async gate() {
    const s = this.state;
    this.ui.print(`\n===== PLAN.md =====\n${this.store.doc('PLAN.md')}\n===== NOTES.md =====\n${this.store.doc('NOTES.md')}`);
    const c = await this.ui.choose('Plan ini:', { a: 'approve', r: 'revisi (beri koreksi)', q: 'berhenti' });
    if (c === 'a') {
      s.phase = 'executing';
      s.planStep = 1;
      this.pending = P.executeStart(this.store.doc('PLAN.md'), this.cfg.testCmd);
      this.log({ type: 'gate', decision: 'approve' });
    } else if (c === 'r') {
      const fb = await this.ui.input('Koreksi untuk plan:');
      s.phase = 'exploring';
      s.exploreSteps = Math.max(0, this.cfg.maxExploreSteps - 4);
      this.pending = P.revisePlan(fb);
      this.log({ type: 'gate', decision: 'revise', feedback: fb });
    } else {
      this.log({ type: 'gate', decision: 'quit' });
      return this.halt('plan tidak disetujui');
    }
    this.save();
  }

  // ---------- phase 2: execution ----------

  async execute() {
    const s = this.state;
    const max = this.cfg.maxExecSteps;
    let msg = this.pending ?? P.formatError('Continue.', P.execFooter(s, max));
    this.pending = null;
    let parseFails = 0;

    while (s.execSteps < max) {
      const text = await this.ask(msg);
      s.execSteps++;
      this.save();
      const footer = () => P.execFooter(s, max);
      const r = parseReply(text);

      if (r.kind === 'error') {
        if (++parseFails >= MAX_PARSE_FAILS) return this.halt(`format balasan salah ${MAX_PARSE_FAILS}x berturut-turut`);
        msg = P.formatError(r.error, footer());
        continue;
      }
      parseFails = 0;

      if (r.kind === 'plan') {
        msg = P.formatError('The plan is already approved. Continue executing it.', footer());
      } else if (r.kind === 'edits') {
        msg = P.result('edits', await this.applyEdits(r.edits), footer());
      } else {
        const out = await this.execTool(r.tool, r.args);
        if (out === null) return; // phase changed (task_done / halt)
        msg = typeof out === 'string' ? P.result(r.tool, out, footer()) : P.formatError(out.error, footer());
      }
    }
    this.halt(`batas ${max} langkah eksekusi tercapai`);
  }

  // Returns a string result, { error }, or null when the phase changed.
  async execTool(tool, args) {
    const s = this.state;
    switch (tool) {
      case 'fs_list':
      case 'fs_read':
      case 'grep_search':
      case 'git_read':
        return this.runReadTool(tool, args);
      case 'focus_set':
        return this.setFocus(args.paths);
      case 'test_run': {
        const t = await this.tools.test_run();
        return t.ok ? `PASS\n${trimFailures(t.output, 800)}` : `FAIL (exit ${t.code})\n${trimFailures(t.output, this.cfg.outputMaxChars)}`;
      }
      case 'shell_safe':
        return this.shell(args);
      case 'bash':
      case 'powershell':
      case 'cmd':
        return this.fullShell(tool, args);
      case 'step_done':
        return this.finishStep(args);
      case 'blocked':
        return this.blockStep(args.reason || 'model gave up');
      case 'task_done':
        s.phase = 'review';
        s.doneSummary = args.summary || '';
        this.save();
        this.log({ type: 'task_done', summary: s.doneSummary });
        return null;
      case 'halt':
        this.halt(`model: ${args.reason || 'halt'}`);
        return null;
      default:
        return { error: `Unknown tool "${tool}".` };
    }
  }

  setFocus(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return { error: 'focus_set needs "paths": [ ... ].' };
    if (paths.length > this.cfg.maxFocus) return { error: `At most ${this.cfg.maxFocus} focus files.` };
    try {
      const rels = paths.map((p) => this.tools.resolve(p, { forWrite: true }).rel);
      this.store.setFocus(rels);
      this.log({ type: 'focus', paths: rels });
      return `focus = ${rels.join(', ')}`;
    } catch (err) {
      if (err instanceof ToolError) return { error: err.message };
      throw err;
    }
  }

  async confirmIfL1(question) {
    if (this.cfg.autonomy !== 'L1') return true;
    return this.ui.confirm(question);
  }

  async shell(args) {
    let req;
    try {
      req = this.tools.checkShell(args);
    } catch (err) {
      if (err instanceof ToolError) return { error: err.message };
      throw err;
    }
    const line = [req.cmd, ...req.args].join(' ');
    let ok;
    if (!req.allowed) {
      ok = this.cfg.autonomy === 'L3' ? false : await this.ui.confirm(`Perintah DI LUAR allowlist: ${line}\nJalankan?`);
      if (!ok) return { error: `"${req.cmd}" is not in the allowlist.` };
    } else {
      ok = await this.confirmIfL1(`Jalankan: ${line}?`);
      if (!ok) return { error: 'The user declined this command.' };
    }
    this.log({ type: 'shell', line });
    return this.tools.shell(req);
  }

  // ---------- full shell (BRIDGE_SHELL=full) ----------

  async stashCount() {
    const r = await this.git.git(['rev-list', '--walk-reflogs', '--count', 'refs/stash']);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  // A shell command must not move the runner's git state: checkpoints and rollback depend on it.
  // Returns a note for the model, or null after halting (state is saved, resume still works).
  async guardGit(before) {
    const notes = [];
    const branch = await this.git.currentBranch();
    if (branch !== before.branch) {
      const r = await this.git.git(['switch', '-q', before.branch]);
      if (r.code !== 0) {
        this.halt(`perintah shell memindahkan branch dan tidak bisa dipulihkan: ${(r.stderr || r.stdout).trim()}`);
        return null;
      }
      notes.push(`Your command switched branches; switched back to ${before.branch}.`);
    }
    const head = await this.git.head();
    if (head !== before.sha) {
      const forward = (await this.git.git(['merge-base', '--is-ancestor', before.sha, head])).code === 0;
      if (!forward) {
        this.halt('perintah shell memundurkan riwayat git; lanjutkan dengan "resume" (rollback ke checkpoint terakhir)');
        return null;
      }
      await this.git.must(['reset', '-q', '--soft', before.sha]);
      notes.push(`Your command created commits; HEAD was restored to ${before.sha.slice(0, 8)} and the changes were kept in the working tree. Do not commit: the runner makes checkpoints.`);
    }
    if ((await this.stashCount()) > before.stash) {
      const r = await this.git.git(['stash', 'pop', '-q']);
      notes.push(r.code === 0 ? 'Your command stashed changes; they were restored. Do not use git stash.' : 'Your command stashed changes and they could NOT be restored automatically. Run "git stash pop".');
    }
    return notes.length ? `\n[runner] ${notes.join(' ')}` : '';
  }

  // Returns a result string, { error }, or null when the run was halted.
  async fullShell(tool, args) {
    if (this.cfg.shellMode !== 'full') return { error: `"${tool}" is not enabled. Use shell_safe.` };
    const avail = this.tools.full.available();
    if (!avail.includes(tool)) return { error: `${tool} is not available on this machine. Available: ${avail.join(', ') || 'none'}.` };
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return { error: `${tool} needs "command": "...".` };
    if (command.length > 8000) return { error: 'The command is too long (max 8000 characters). Put it in a script file with WRITE and run that.' };

    const reasons = riskReasons(command);
    // L1/L2 always ask. L3 runs on its own unless the command looks risky.
    if (this.cfg.autonomy !== 'L3' || reasons.length > 0) {
      const warn = reasons.length ? `\n⚠ Berisiko: ${reasons.join('; ')}` : '';
      const ok = await this.ui.confirm(`Jalankan di ${tool}:\n${command}${warn}\nLanjut?`);
      if (!ok) {
        this.log({ type: 'fullshell_declined', shell: tool, command, risks: reasons });
        return { error: 'The user declined this command.' };
      }
    }

    const before = { sha: await this.git.head(), branch: await this.git.currentBranch(), stash: await this.stashCount() };
    this.log({ type: 'fullshell', shell: tool, command, risks: reasons });
    const res = await this.tools.full.run(tool, command, { timeoutMs: this.tools.full.clampTimeout(args.timeout_s) });
    this.log({ type: 'fullshell_result', shell: tool, code: res.code, timedOut: res.timedOut, aborted: res.aborted });

    const note = await this.guardGit(before);
    if (note === null) return null;
    return this.tools.full.format(res) + note;
  }

  async backupIfUntracked(rel, abs) {
    if (!fs.existsSync(abs) || (await this.git.isTracked(rel))) return;
    const dest = path.join(this.store.dir, 'bak', `${rel}.${Date.now()}.bak`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    this.log({ type: 'backup', path: rel, dest });
  }

  async applyEdits(edits) {
    const results = [];
    const focus = this.store.focus();
    for (const e of edits) {
      const res = await this.applyOne(e, focus);
      results.push(`${e.type.toUpperCase()} ${e.path}: ${res}`);
      this.log({ type: 'edit', edit: e.type, path: e.path, result: res });
      if (!res.startsWith('applied') && !res.startsWith('created')) {
        if (edits.length > 1) results.push('Remaining blocks in this reply were skipped.');
        break;
      }
    }
    return results.join('\n');
  }

  async applyOne(e, focus) {
    let target;
    try {
      target = this.tools.resolve(e.path, { forWrite: true });
    } catch (err) {
      if (err instanceof ToolError) return `rejected — ${err.message}`;
      throw err;
    }
    if (!focus.includes(target.rel)) return `rejected — ${target.rel} is not in focus. Call focus_set first (current: ${focus.join(', ') || 'none'}).`;

    if (e.type === 'write') {
      if (fs.existsSync(target.abs)) return 'rejected — file already exists. Use PATCH to edit it.';
      if (!(await this.confirmIfL1(`Buat file baru ${target.rel} (${e.content.split('\n').length} baris)?`))) return 'rejected — the user declined.';
      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, e.content.endsWith('\n') ? e.content : e.content + '\n');
      return 'created';
    }

    if (this.state.mustReread) return 'rejected — the same test error repeated 3 times. fs_read the relevant file before the next PATCH.';
    if (!fs.existsSync(target.abs)) return 'rejected — file does not exist. Use WRITE to create it.';
    const before = fs.readFileSync(target.abs, 'utf8');
    const out = applySearchReplace(before, e.search, e.replace);
    if (!out.ok) return `rejected — ${out.error}`;
    if (!(await this.confirmIfL1(`Terapkan patch?\n${previewPatch(target.rel, e.search, e.replace)}`))) return 'rejected — the user declined.';
    await this.backupIfUntracked(target.rel, target.abs);
    fs.writeFileSync(target.abs, out.content);
    return out.note;
  }

  async finishStep(args) {
    const s = this.state;
    // The plan step is the runner's own counter, never the model's claim, so a stray
    // "step": 5 cannot skip ahead. A mismatch is surfaced in the reply below.
    const step = s.planStep;
    const claimed = Number(args.step);
    const mismatch = Number.isFinite(claimed) && claimed !== step ? ` (you wrote step ${claimed}; the current step is ${step})` : '';
    const summary = String(args.summary || '').slice(0, 72);
    const t = await this.tools.test_run();
    this.log({ type: 'test', step, ok: t.ok, code: t.code });

    if (t.ok) {
      const sha = await this.git.checkpoint(`agent: step ${step}${summary ? ` — ${summary}` : ''}`);
      s.checkpoints.push({ sha, label: `step ${step}`, step });
      s.planStep = step + 1;
      s.failures = { hashes: [], total: 0 };
      s.mustReread = false;
      this.save();
      this.ui.print(`Langkah ${step} hijau → checkpoint ${sha.slice(0, 8)}`);
      const note = t.configured ? 'Tests passed.' : t.output;
      return `${note} Checkpoint committed for step ${step}${mismatch}. Continue with step ${step + 1}, or task_done if the plan is complete.`;
    }

    const trimmed = trimFailures(t.output, this.cfg.outputMaxChars);
    const h = failureHash(trimmed);
    s.failures.hashes.push(h);
    s.failures.total++;
    const same = s.failures.hashes.filter((x) => x === h).length;
    const distinct = new Set(s.failures.hashes).size;
    this.save();

    if (distinct >= MAX_DISTINCT_FAILURES || s.failures.total >= MAX_TOTAL_FAILURES) {
      return this.blockStep(`${distinct} different failures / ${s.failures.total} red runs`);
    }
    let extra = '';
    if (same >= SAME_ERROR_REREAD) {
      s.mustReread = true;
      this.save();
      extra = '\nThis exact error happened 3 times. You MUST fs_read the relevant file before your next PATCH.';
    }
    return `Tests FAILED (exit ${t.code}). Fix the root cause; do not weaken or delete tests.${extra}\n${trimmed}`;
  }

  async blockStep(reason) {
    const s = this.state;
    const step = s.planStep;
    await this.git.rollback(this.lastCheckpoint());
    s.blockedSteps.push(step);
    s.planStep = step + 1;
    s.failures = { hashes: [], total: 0 };
    s.mustReread = false;
    this.save();
    this.log({ type: 'blocked', step, reason });
    this.ui.print(`Langkah ${step} BLOCKED (${reason}) → rollback ke ${this.lastCheckpoint().slice(0, 8)}`);
    return `Step ${step} is BLOCKED (${reason}) and was rolled back to the last checkpoint. Continue with step ${step + 1}, or task_done if nothing is left.`;
  }

  // ---------- phase 3: human review ----------

  async testWarnings(base) {
    const out = await this.git.must(['diff', '--name-status', base]);
    const warnings = [];
    for (const line of out.split('\n').filter(Boolean)) {
      const [status, file] = line.split('\t');
      if (!TEST_FILE_RE.test(file)) continue;
      if (status.startsWith('D')) warnings.push(`file test DIHAPUS: ${file}`);
      else if (status.startsWith('M')) {
        const d = await this.git.must(['diff', base, '--', file]);
        const removed = d.split('\n').filter((l) => /^-(?!--)/.test(l) && /expect|assert|should|\btest\(|\bit\(/.test(l)).length;
        if (removed > 0) warnings.push(`${file}: ${removed} baris assertion dihapus/diubah — cek apakah test dilonggarkan`);
        if (/^\+.*\.(skip|only)\(|^\+.*@pytest\.mark\.skip|^\+.*t\.Skip\(/m.test(d)) warnings.push(`${file}: ada test yang di-skip`);
      }
    }
    return warnings;
  }

  async review() {
    const s = this.state;
    const base = s.checkpoints[0].sha;
    const stat = await this.git.must(['diff', '--stat', base]);
    const diff = await this.git.must(['--no-pager', 'diff', '--no-color', base]);
    const warnings = await this.testWarnings(base);
    this.ui.print(`\n===== REVIEW: ${s.branch} =====\nRingkasan model: ${s.doneSummary || '-'}\n\n${stat || '(tidak ada perubahan)'}\n\n${diff}`);
    if (s.blockedSteps.length) this.ui.print(`Langkah BLOCKED (di-rollback): ${s.blockedSteps.join(', ')}`);
    for (const w of warnings) this.ui.print(`PERINGATAN: ${w}`);

    const c = await this.ui.choose('Diff ini:', { a: 'approve', c: 'minta perbaikan', x: 'tolak (rollback ke checkpoint 0)' });
    if (c === 'a') {
      if (await this.git.isDirty()) {
        const sha = await this.git.checkpoint('agent: final uncommitted changes');
        s.checkpoints.push({ sha, label: 'final', step: s.planStep });
      }
      s.phase = 'done';
      this.ui.print(`Selesai. Branch ${s.branch} siap di-merge manual (tidak di-push).`);
    } else if (c === 'c') {
      const fb = await this.ui.input('Perbaikan yang diminta:');
      s.phase = 'executing';
      s.execSteps = Math.max(0, s.execSteps - 15); // give room for the fixes
      this.pending = P.reviewFeedback(fb);
    } else {
      await this.git.rollback(base);
      s.phase = 'done';
      s.rejected = true;
      this.ui.print(`Ditolak. Branch ${s.branch} dikembalikan ke checkpoint 0.`);
    }
    this.log({ type: 'review', decision: c });
    this.save();
  }
}
