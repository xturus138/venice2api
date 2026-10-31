import test from 'node:test';
import assert from 'node:assert/strict';
import { applySearchReplace, stripLineNumbers } from '../patches.mjs';

const file = 'a\nb\nc\nd\ne\n';

test('applies a unique 3-line match', () => {
  const r = applySearchReplace(file, 'b\nc\nd', 'B\nC\nD');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'a\nB\nC\nD\ne\n');
});

test('rejects zero matches', () => {
  const r = applySearchReplace(file, 'x\ny\nz', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('rejects multiple matches', () => {
  const r = applySearchReplace('x\ny\nz\nx\ny\nz\n', 'x\ny\nz', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /2 places/);
});

test('requires 3 lines of context', () => {
  const r = applySearchReplace(file, 'b\nc', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /at least 3/);
});

test('rejects empty SEARCH', () => {
  assert.equal(applySearchReplace(file, '  \n', 'q').ok, false);
});

test('strips copied line numbers', () => {
  assert.equal(stripLineNumbers(' 2| b\n 3| c\n 4| d'), 'b\nc\nd');
  assert.equal(stripLineNumbers('x = 1| 2\nplain'), 'x = 1| 2\nplain');
  const r = applySearchReplace(file, '2| b\n3| c\n4| d', 'X\nY\nZ');
  assert.equal(r.content, 'a\nX\nY\nZ\ne\n');
});

test('tolerates trailing whitespace differences', () => {
  const r = applySearchReplace('a  \nb\t\nc\nd\n', 'a\nb\nc', 'A\nB\nC');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'A\nB\nC\nd\n');
});

test('keeps CRLF line endings', () => {
  const r = applySearchReplace('a\r\nb\r\nc\r\nd\r\n', 'a\nb\nc', 'A\nB\nC');
  assert.equal(r.content, 'A\r\nB\r\nC\r\nd\r\n');
});

test('replacement may be empty (delete lines)', () => {
  const r = applySearchReplace(file, 'b\nc\nd\n', '');
  assert.equal(r.content, 'a\ne\n');
});
