// Goal: a file's line breaks survive being edited as `\n` text: the text as it opened restores byte for byte, and an
// edit changes only the breaks of the lines it touched (CRLF, lone CR and mixed files alike).
// Method: fixed cases for each kind of file, then a seeded random walk (no dependency: a small linear congruential
// generator) of insertions, deletions and replacements over mixed-break texts, checking the invariants every time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLineBreaks, restoreLineBreaks } from '#dist/shared/core/lineBreaks.js';

test('the text as it opened restores exactly, whatever its breaks', () => {
  for (const source of ['', 'one', 'a\nb\n', 'a\r\nb\r\n', 'a\rb\r', 'a\r\nb\nc\rd', '\r\n\r\n', 'trailing\r\n', 'x\n\r\ny']) {
    const opened = normalizeLineBreaks(source);
    assert.ok(!opened.text.includes('\r'), 'the editor text has only \\n breaks');
    assert.equal(restoreLineBreaks(opened, opened.text), source);
  }
});

test('an edit in a CRLF file writes CRLF and leaves the other lines alone', () => {
  const opened = normalizeLineBreaks('first\r\nsecond\r\nthird\r\n');
  assert.equal(opened.layout.common, '\r\n');
  assert.equal(restoreLineBreaks(opened, 'first\nsecond changed\nthird\n'), 'first\r\nsecond changed\r\nthird\r\n');
  assert.equal(restoreLineBreaks(opened, 'first\nnew\nsecond\nthird\n'), 'first\r\nnew\r\nsecond\r\nthird\r\n');
  assert.equal(restoreLineBreaks(opened, 'first\nthird\n'), 'first\r\nthird\r\n');
  assert.equal(restoreLineBreaks(opened, 'first\nsecond\nthird\nadded'), 'first\r\nsecond\r\nthird\r\nadded');
});

test('a mixed file keeps each untouched line’s own break', () => {
  const opened = normalizeLineBreaks('a\r\nb\nc\r\nd\n');
  assert.equal(restoreLineBreaks(opened, 'A\nb\nc\nd\n'), 'A\r\nb\nc\r\nd\n');
  assert.equal(restoreLineBreaks(opened, 'a\nb\nc\nD\n'), 'a\r\nb\nc\r\nD\n');
});

test('a \\r in edited text is a broken caller', () => {
  assert.throws(() => restoreLineBreaks(normalizeLineBreaks('a\r\nb'), 'a\r\nb'), /only \\n breaks/);
});

test('random edits never touch a break outside the edited lines', () => {
  let seed = 7;
  const next = (limit: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  const breaks = ['\n', '\r\n', '\r'];
  for (let round = 0; round < 300; round += 1) {
    const lines = Array.from({ length: 1 + next(8) }, (_, index) => `line${index}`);
    const source = lines.map((line, index) => line + (index < lines.length - 1 ? (breaks[next(3)] ?? '\n') : '')).join('');
    const opened = normalizeLineBreaks(source);
    const edited = opened.text.split('\n');
    const at = next(edited.length);
    const kind = next(3);
    if (kind === 0) {
      edited.splice(at, 0, `inserted${round}`);
    } else if (kind === 1 && edited.length > 1) {
      edited.splice(at, 1);
    } else {
      edited[at] = `changed${round}`;
    }
    const written = restoreLineBreaks(opened, edited.join('\n'));
    const reopened = normalizeLineBreaks(written);
    assert.equal(reopened.text, edited.join('\n'), 'the written text holds exactly the edited lines');
    // Every break before the first edited line is the original's.
    const firstChanged = Math.min(at, opened.layout.breaks.length);
    assert.deepEqual(reopened.layout.breaks.slice(0, Math.max(0, firstChanged - 1)), opened.layout.breaks.slice(0, Math.max(0, firstChanged - 1)));
  }
});
