import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
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
    maxExploreSteps: num(env.BRIDGE_MAX_EXPLORE, 10),
    maxExecSteps: num(env.BRIDGE_MAX_STEPS, 60),
    // Pause between turns so the web UI can settle. Not randomized.
    stepDelayMs: num(env.BRIDGE_STEP_DELAY_MS, 1500),
    replyTimeoutMs: num(env.BRIDGE_REPLY_TIMEOUT_MS, 10 * 60 * 1000),
    readMaxLines: num(env.BRIDGE_READ_MAX_LINES, 200),
    readMaxChars: num(env.BRIDGE_READ_MAX_CHARS, 12000),
    grepMaxLines: num(env.BRIDGE_GREP_MAX_LINES, 40),
    outputMaxChars: num(env.BRIDGE_OUTPUT_MAX_CHARS, 3000),
    shellTimeoutMs: num(env.BRIDGE_SHELL_TIMEOUT_MS, 120 * 1000),
    testTimeoutMs: num(env.BRIDGE_TEST_TIMEOUT_MS, 10 * 60 * 1000),
    maxFocus: 4,
  };
}
