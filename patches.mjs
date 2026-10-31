// SEARCH/REPLACE patch application with strict rules (plan §7).

export const MIN_SEARCH_LINES = 3;

const LINE_NO = /^\s*\d+\| ?/;

// fs_read returns "  12| code". Models sometimes copy the numbers into SEARCH.
// Strip them only when every non-empty line carries one.
export function stripLineNumbers(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => LINE_NO.test(l))) return text;
  return lines.map((l) => l.replace(LINE_NO, '')).join('\n');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

// Fallback: compare line by line ignoring trailing whitespace. Still needs exactly one match.
function looseMatches(fileLines, searchLines) {
  const norm = (s) => s.replace(/\s+$/, '');
  const target = searchLines.map(norm);
  const hits = [];
  for (let i = 0; i + target.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(fileLines[i + j]) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Apply one SEARCH/REPLACE block to file content.
 * Returns { ok: true, content, note } or { ok: false, error }.
 */
export function applySearchReplace(content, search, replace) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const body = content.replace(/\r\n/g, '\n');
  let s = stripLineNumbers(search.replace(/\r\n/g, '\n'));
  const r = replace.replace(/\r\n/g, '\n');

  if (s.trim() === '') {
    return { ok: false, error: 'SEARCH is empty. Use WRITE for new files, or copy existing lines into SEARCH.' };
  }

  const fileLineCount = body.split('\n').length;
  const searchLineCount = s.split('\n').length;
  if (searchLineCount < MIN_SEARCH_LINES && fileLineCount >= MIN_SEARCH_LINES) {
    return {
      ok: false,
      error: `SEARCH has ${searchLineCount} line(s); at least ${MIN_SEARCH_LINES} lines of context are required.`,
    };
  }

  const exact = countOccurrences(body, s);
  if (exact === 1) {
    const idx = body.indexOf(s);
    const out = body.slice(0, idx) + r + body.slice(idx + s.length);
    return { ok: true, content: out.replace(/\n/g, eol), note: 'applied' };
  }
  if (exact > 1) {
    return { ok: false, error: `SEARCH matches ${exact} places. Add more surrounding lines so it matches exactly once.` };
  }

  const fileLines = body.split('\n');
  const searchLines = s.split('\n');
  const hits = looseMatches(fileLines, searchLines);
  if (hits.length === 1) {
    const i = hits[0];
    const out = [...fileLines.slice(0, i), ...r.split('\n'), ...fileLines.slice(i + searchLines.length)].join('\n');
    return { ok: true, content: out.replace(/\n/g, eol), note: 'applied (trailing whitespace ignored)' };
  }
  if (hits.length > 1) {
    return { ok: false, error: `SEARCH matches ${hits.length} places. Add more surrounding lines so it matches exactly once.` };
  }
  return {
    ok: false,
    error: 'SEARCH not found in the file. fs_read the file again and copy the lines exactly (without line numbers).',
  };
}

// Small preview for human confirmation (L1).
export function previewPatch(path, search, replace, maxLines = 30) {
  const minus = search.split('\n').map((l) => `- ${l}`);
  const plus = replace.split('\n').map((l) => `+ ${l}`);
  const all = [...minus, ...plus];
  const cut = all.length > maxLines ? [...all.slice(0, maxLines), `  ... (${all.length - maxLines} baris lagi)`] : all;
  return `--- ${path}\n${cut.join('\n')}`;
}
