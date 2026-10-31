import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../protocol.mjs';

test('tool call inside a rendered code block with label and Copy button', () => {
  const text = 'I will read the file.\ntool\nCopy code\n{"tool": "fs_read", "args": {"path": "src/a.js", "start": 1}}\n';
  const r = parseReply(text);
  assert.deepEqual(r, { kind: 'tool', tool: 'fs_read', args: { path: 'src/a.js', start: 1 }, extraCalls: 0 });
});

test('braces inside JSON strings do not confuse the parser', () => {
  const r = parseReply('{"tool":"grep_search","args":{"pattern":"function \\\\w+\\\\(\\\\) {"}}');
  assert.equal(r.kind, 'tool');
  assert.equal(r.args.pattern, 'function \\w+\\(\\) {');
});

test('uses the last tool call when reasoning leaked an earlier one', () => {
  const r = parseReply('maybe {"tool":"fs_list","args":{}} ... final:\n{"tool":"fs_read","args":{"path":"x"}}');
  assert.equal(r.tool, 'fs_read');
  assert.equal(r.extraCalls, 1);
});

test('patch block with junk lines between header and marker', () => {
  const text = [
    'Fixing the bug.',
    'PATCH `src/a.js`',
    'text',
    'Copy',
    '<<<<<<< SEARCH',
    'line1',
    'line2',
    'line3',
    '=======',
    'new1',
    'new2',
    '>>>>>>> REPLACE',
  ].join('\n');
  const r = parseReply(text);
  assert.equal(r.kind, 'edits');
  assert.deepEqual(r.edits, [{ type: 'patch', path: 'src/a.js', search: 'line1\nline2\nline3', replace: 'new1\nnew2' }]);
});

test('multiple patches and a write, in order', () => {
  const text = `PATCH a.js
<<<<<<< SEARCH
1
2
3
=======
x
>>>>>>> REPLACE
WRITE b.json
<<<<<<< CONTENT
{"tool": "not-a-call"}
>>>>>>> END`;
  const r = parseReply(text);
  assert.equal(r.kind, 'edits');
  assert.equal(r.edits.length, 2);
  assert.equal(r.edits[1].type, 'write');
  assert.equal(r.edits[1].content, '{"tool": "not-a-call"}');
});

test('empty replacement', () => {
  const r = parseReply('PATCH a\n<<<<<<< SEARCH\n1\n2\n3\n=======\n>>>>>>> REPLACE');
  assert.equal(r.edits[0].replace, '');
});

test('plan with notes', () => {
  const r = parseReply('PLAN\n<<<<<<< CONTENT\n1. do x\n2. do y\n>>>>>>> END\nNOTES\n<<<<<<< CONTENT\nfile a.js\n>>>>>>> END');
  assert.deepEqual(r, { kind: 'plan', plan: '1. do x\n2. do y', notes: 'file a.js' });
});

test('mixed actions are rejected', () => {
  const r = parseReply('{"tool":"fs_list","args":{}}\nPATCH a\n<<<<<<< SEARCH\n1\n2\n3\n=======\nx\n>>>>>>> REPLACE');
  assert.equal(r.kind, 'error');
  assert.match(r.error, /Mixed/);
});

test('no action is an error', () => {
  assert.equal(parseReply('Sure, I can help with that!').kind, 'error');
});

test('non-breaking spaces and zero-width chars are normalised', () => {
  const r = parseReply('{"tool": "fs_list",​"args":{}}');
  assert.equal(r.tool, 'fs_list');
});
