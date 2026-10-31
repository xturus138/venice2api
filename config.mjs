import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// Randomize a delay within ms*(1 ± factor), never below floor. factor 0 = no jitter
// (so tests stay deterministic). Single source of truth for the node side.
export function jittered(ms, factor, floor = 0) {
  if (!factor || ms <= 0) return ms;
  const delta = ms * factor;
  return Math.max(floor, ms + (Math.random() * 2 - 1) * delta);
}

export const AUTONOMY_LEVELS = ['L1', 'L2', 'L3'];

export function loadConfig(env = process.env) {
  const autonomy = (env.BRIDGE_AUTONOMY || 'L1').toUpperCase();
  if (!AUTONOMY_LEVELS.includes(autonomy)) {
    throw new Error(`BRIDGE_AUTONOMY harus L1, L2, atau L3 (sekarang: ${autonomy})`);
  }
  return {
    // Project the agent works on. Use a copy, not the original.
    root: env.BRIDGE_ROOT ? path.resolve(env.BRIDGE_ROOT) : null,
    // state.json, PLAN.md, NOTES.md, focus.json, log.jsonl live here, outside the project.
    workspace: path.resolve(env.BRIDGE_WORKSPACE || path.join(here, 'workspace')),
    port: num(env.BRIDGE_PORT, 8765),
    testCmd: env.BRIDGE_TEST_CMD || '',
    autonomy,
    // Regex (case-insensitive) the active model label must match. Empty = don't check.
    modelPattern: env.BRIDGE_MODEL ?? 'deepseek',
    // Opt in to let fs_read show the KEYS in .env-style files, with values masked.
    // Off by default; never applies to key/certificate files.
    revealEnvKeys: ['1', 'true', 'yes'].includes(String(env.BRIDGE_ENV_KEYS || '').toLowerCase()),
    maxExploreSteps: num(env.BRIDGE_MAX_EXPLORE, 10),
    maxExecSteps: num(env.BRIDGE_MAX_STEPS, 60),
    // Pause between turns so the web UI can settle.
    stepDelayMs: num(env.BRIDGE_STEP_DELAY_MS, 1500),
    // Randomize the step delay within ±this fraction (0 = off, so tests are deterministic).
    delayJitter: clamp(num(env.BRIDGE_DELAY_JITTER, 0.35), 0, 0.9),
    replyTimeoutMs: num(env.BRIDGE_REPLY_TIMEOUT_MS, 10 * 60 * 1000),
    readMaxLines: num(env.BRIDGE_READ_MAX_LINES, 200),
    readMaxChars: num(env.BRIDGE_READ_MAX_CHARS, 12000),
    grepMaxLines: num(env.BRIDGE_GREP_MAX_LINES, 40),
    outputMaxChars: num(env.BRIDGE_OUTPUT_MAX_CHARS, 3000),
    shellTimeoutMs: num(env.BRIDGE_SHELL_TIMEOUT_MS, 120 * 1000),
    // "full" turns on the bash / powershell / cmd tools (arbitrary commands, not a sandbox).
    // Anything else keeps only the allowlisted shell_safe.
    shellMode: String(env.BRIDGE_SHELL || '').toLowerCase() === 'full' ? 'full' : 'safe',
    // Env var names to pass through to full-shell commands even though they look secret
    // (e.g. an API key curl needs). Everything else secret-looking is stripped.
    shellKeepEnv: String(env.BRIDGE_SHELL_KEEP_ENV || '').split(',').map((s) => s.trim()).filter(Boolean),
    shellMaxTimeoutMs: num(env.BRIDGE_SHELL_MAX_TIMEOUT_S, 600) * 1000,
    shellOutputMaxChars: num(env.BRIDGE_SHELL_OUTPUT_MAX_CHARS, 6000),
    testTimeoutMs: num(env.BRIDGE_TEST_TIMEOUT_MS, 10 * 60 * 1000),
    maxFocus: 4,
  };
}
