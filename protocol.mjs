// Turn the model's reply text (as read from the rendered chat page) into actions.
//
// The page renders markdown, so code blocks may come with extra lines such as a
// language label or a "Copy" button. The parser therefore looks for markers and
// balanced JSON instead of relying on exact fences.

export const MAX_EDITS_PER_REPLY = 4;

function clean(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[​‌‍﻿]/g, '');
}

function cleanPath(p) {
  // Strip quotes, backticks and markdown bold/italic stars around the path. Underscores are
  // left alone on purpose: names like __init__.py are real.
  return p.trim().replace(/^[`'"*]+|[`'"*]+$/g, '').trim();
}

// Find every balanced {...} that parses as JSON and has a string "tool" field.
export function findToolCalls(text) {
  const calls = [];
  // Only scan from braces that open an object whose first key is "tool" or "args". This keeps
  // the scan near-linear even on replies full of unrelated braces (code, JSON files).
  const starts = [...text.matchAll(/\{\s*"(?:tool|args)"\s*:/g)].map((m) => m.index);
  let skipUntil = -1;
  for (const start of starts) {
    if (start < skipUntil) continue; // nested inside a call we already took
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const chunk = text.slice(start, i + 1);
          if (chunk.includes('"tool"')) {
            try {
              const obj = JSON.parse(chunk);
              if (obj && typeof obj.tool === 'string') {
                calls.push({ kind: 'tool', tool: obj.tool.trim(), args: obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args) ? obj.args : {}, index: start });
                skipUntil = i;
              }
            } catch {
              /* not JSON */
            }
          }
          break;
        }
      }
    }
  }
  return calls;
}

// Up to 3 junk lines (language label, "Copy", an opening fence) may sit between the header and the marker.
// Every marker must sit at the start of its own line, so a code comment like "// ==========" or
// a string containing ">>>>>>> REPLACE" is never mistaken for one.
const PATCH_RE = /^[ \t]*PATCH[: \t]+([^\n]+?)[ \t]*\n(?:[^\n]*\n){0,3}?<<<<<<< SEARCH[ \t]*\n([\s\S]*?)^=======[ \t]*\n([\s\S]*?)^[ \t]*>>>>>>> REPLACE[ \t]*$/gm;
const BLOCK_RE = /^[ \t]*(WRITE|PLAN|NOTES)(?:[: \t]+([^\n]*?))?[ \t]*\n(?:[^\n]*\n){0,3}?<<<<<<< CONTENT[ \t]*\n([\s\S]*?)^[ \t]*>>>>>>> END[ \t]*$/gm;

// A SEARCH body may itself contain a "=======" line (markdown headings, conflict-marker docs).
// Return every possible split, first one first; the applier tries them until one matches.
function splitAlternatives(body) {
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/[ \t]+$/, '') !== '=======') continue;
    out.push({ search: lines.slice(0, i).join('\n'), replace: dropOneTrailingNewline(lines.slice(i + 1).join('\n')) });
  }
  return out;
}

function dropOneTrailingNewline(s) {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/**
 * Parse a reply. Returns one of:
 *   { kind: 'tool', tool, args }
 *   { kind: 'edits', edits: [{type:'patch', path, search, replace} | {type:'write', path, content}] }
 *   { kind: 'plan', plan, notes }
 *   { kind: 'error', error }
 */
export function parseReply(raw) {
  const text = clean(raw);
  const edits = [];
  let plan = null;
  let notes = null;

  for (const m of text.matchAll(PATCH_RE)) {
    const search = dropOneTrailingNewline(m[2]);
    const replace = dropOneTrailingNewline(m[3]);
    const edit = { type: 'patch', path: cleanPath(m[1]), search, replace, index: m.index };
    const alts = splitAlternatives(`${m[2]}=======\n${m[3]}`);
    if (alts.length > 1) edit.alternatives = alts.slice(1);
    edits.push(edit);
  }
  for (const m of text.matchAll(BLOCK_RE)) {
    const content = dropOneTrailingNewline(m[3]);
    if (m[1] === 'WRITE') {
      const p = cleanPath(m[2] || '');
      if (!p) return { kind: 'error', error: 'WRITE needs a path: "WRITE path/to/file".' };
      edits.push({ type: 'write', path: p, content, index: m.index });
    } else if (m[1] === 'PLAN') {
      plan = content;
    } else {
      notes = content;
    }
  }

  // Ignore JSON that sits inside an edit/plan block (e.g. a WRITE of a .json file).
  const blocks = [...text.matchAll(PATCH_RE), ...text.matchAll(BLOCK_RE)].map((m) => [m.index, m.index + m[0].length]);
  const tools = findToolCalls(text).filter((t) => !blocks.some(([a, b]) => t.index >= a && t.index < b));

  const kinds = [tools.length > 0, edits.length > 0, plan !== null].filter(Boolean).length;
  if (kinds === 0) {
    if (notes !== null) return { kind: 'error', error: 'NOTES was sent without PLAN. Send PLAN and NOTES together.' };
    // Looks like a tool call but did not parse: say why, instead of "no action".
    if (/["']tool["']\s*:/.test(text)) {
      return { kind: 'error', error: 'Your tool call is not valid JSON. Use double quotes for keys and strings, no trailing commas, no comments: {"tool": "name", "args": {...}}.' };
    }
    if (/<<<<<<< SEARCH/.test(text)) {
      return { kind: 'error', error: 'Your PATCH block is incomplete. It needs: "PATCH path" line, "<<<<<<< SEARCH", the old lines, a "=======" line on its own, the new lines, then ">>>>>>> REPLACE" on its own line.' };
    }
    return { kind: 'error', error: 'No action found. Send exactly one action in the required format.' };
  }
  if (kinds > 1) {
    return { kind: 'error', error: 'Mixed actions in one reply. Send either one tool call, or edit blocks, or the PLAN — not a mix.' };
  }
  if (plan !== null) return { kind: 'plan', plan, notes: notes ?? '' };
  if (edits.length > 0) {
    if (edits.length > MAX_EDITS_PER_REPLY) {
      return { kind: 'error', error: `Too many edit blocks (${edits.length}). Send at most ${MAX_EDITS_PER_REPLY} per reply.` };
    }
    edits.sort((a, b) => a.index - b.index);
    return { kind: 'edits', edits: edits.map(({ index, ...e }) => e) };
  }
  // If reasoning text leaked into the reply, the real call is the last one.
  const last = tools[tools.length - 1];
  return { kind: 'tool', tool: last.tool, args: last.args, extraCalls: tools.length - 1 };
}
