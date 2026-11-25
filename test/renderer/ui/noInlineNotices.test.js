// Goal: the UI never appends error, notice, hint or warning paragraphs into a panel or dialog (owner rule: failures and notices are
// toasts, explanations are tooltips, persistent status replaces existing UI in place). A paragraph that appears under a field or a
// toolbar moves everything below it, so the layout jumps, and the text is lost when the state clears.
// Method: scan every renderer .tsx file under src for a JSX element that is block text and either carries role="alert" or wears a
// className token ending in -note, -notice, -problem, -hint or -warning. A line that matches must be listed in
// test/helpers/inlineNoticeAllowlist.json as { file, pattern, reason }: `pattern` is a substring of the offending line, `reason`
// says why the case is legitimate (an empty state, a confirm dialog's own body, a tooltip, a log view). Negative space: an entry that
// matches no line fails, so no exception outlives its cause, and the scanner is tested on valid and invalid text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { repoPath } = require('../../helpers/sources');

const REASON_LENGTH_MIN = 20;
const FILES_MAX = 4000;
const BLOCK_TAG = /<(p|div|span|small|li|ul|section|aside)\b/;
const NOTICE_CLASS = /className=(?:"[^"]*|\{[^}]*)\b[\w-]+-(?:note|notice|problem|hint|warning)\b/;
const ALERT_ROLE = /role="alert"/;

/** The 1-based line numbers in one source text that append notice text. */
function scanText(text) {
  const hits = [];
  const lines = text.split('\n');
  assert(lines.length < 100000, 'scanText: file is implausibly long');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    // A tag may open on the previous line when its attributes wrap, so read the line with the one before it.
    const window = `${lines[index - 1] ?? ''} ${line}`;
    const named = NOTICE_CLASS.test(line) && BLOCK_TAG.test(window);
    const alerting = ALERT_ROLE.test(line) && BLOCK_TAG.test(window);
    if (named || alerting) {
      hits.push({ line: index + 1, text: trimmed });
    }
  }
  return hits;
}

// Iterative walk with an explicit stack and a visit cap, so a symlink loop fails loudly instead of hanging.
function listSources(root) {
  const found = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      assert(visited < FILES_MAX * 10, 'listSources: too many entries');
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith('.tsx')) {
        found.push(full);
      }
    }
  }
  assert(found.length < FILES_MAX, 'listSources: too many files');
  return found;
}

function parseAllowlist(input) {
  assert(typeof input === 'object', 'allowlist: expected an object');
  assert(input !== null, 'allowlist: expected an object, not null');
  assert(Array.isArray(input.exceptions), 'allowlist: exceptions is an array');
  return input.exceptions.map((entry, index) => {
    assert(typeof entry.file === 'string', `allowlist[${index}].file: expected a path`);
    assert(entry.file.length > 0, `allowlist[${index}].file: expected a path`);
    assert(typeof entry.pattern === 'string', `allowlist[${index}].pattern: expected text of the line`);
    assert(entry.pattern.length > 0, `allowlist[${index}].pattern: expected text of the line`);
    assert(typeof entry.reason === 'string', `allowlist[${index}].reason: say why`);
    assert(entry.reason.length >= REASON_LENGTH_MIN, `allowlist[${index}].reason: say why`);
    return entry;
  });
}

test('no panel or dialog appends error, notice, hint or warning paragraphs', () => {
  const root = repoPath('src');
  const allowlist = parseAllowlist(JSON.parse(fs.readFileSync(repoPath('test/helpers/inlineNoticeAllowlist.json'), 'utf8')));
  const used = new Set();
  const offenders = [];
  for (const file of listSources(root)) {
    const relative = path.relative(repoPath('.'), file).split(path.sep).join('/');
    for (const hit of scanText(fs.readFileSync(file, 'utf8'))) {
      const index = allowlist.findIndex((entry) => entry.file === relative && hit.text.includes(entry.pattern));
      if (index === -1) {
        offenders.push(`${relative}:${hit.line}  ${hit.text}`);
      } else {
        used.add(index);
      }
    }
  }
  assert.deepEqual(offenders, [], `appended notice text: use a toast (ErrorToast), a tooltip, or replace in place:\n${offenders.join('\n')}`);
  const stale = allowlist.filter((_, index) => !used.has(index)).map((entry) => `${entry.file}: ${entry.pattern}`);
  assert.deepEqual(stale, [], 'allowlist entries that match no line must be removed');
});

test('the scanner flags notice paragraphs and alerts, and passes toasts and plain content', () => {
  assert.equal(scanText('<p className="page-template-problem">{refused}</p>').length, 1);
  assert.equal(scanText('<div className="x" role="alert">{message}</div>').length, 1);
  assert.equal(scanText('<span className="a-note b">{text}</span>').length, 1);
  assert.equal(scanText('<div\n  role="alert"').length, 1);
  assert.equal(scanText('<ErrorToast message={problem} />').length, 0);
  assert.equal(scanText('<p className="page-title">{title}</p>').length, 0);
  assert.equal(scanText('// <p className="x-note"> in a comment').length, 0);
  assert.equal(scanText('<button className="notebook">x</button>').length, 0);
});
