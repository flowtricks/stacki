// Goal: `.stacki/audits.json` parses only into a bounded, unique list of
// ignored finding ids, each with a reason; every other shape is refused with a
// message naming the field; what is written reads back; adding and removing
// keep the list unique. The agent task value is bounded where it is built.
// Method: parse the known-good file, then each known-bad shape and each bound
// just past its limit, pinning the error; round-trip through the serializer;
// exercise withIgnore / withoutIgnore; build agent tasks across their bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_IGNORE_LIMITS,
  EMPTY_AUDIT_IGNORES,
  parseAuditIgnores,
  parseAuditIgnoresSource,
  serializeAuditIgnores,
  withIgnore,
  withoutIgnore,
  withCheckSetting,
  withIgnoredPage,
  withoutAnyIgnores,
  withoutIgnoredPage,
  tokenProperty,
  DEFAULT_PLACEHOLDERS,
  DEFAULT_TOKEN_SETTINGS,
} from '#dist/shared/properties/auditIgnores.js';
import { ignoreReasons, ignoredEntryCount, ignoredGroups } from '#dist/shared/properties/auditIgnoreList.js';
import { AGENT_TASK_LIMITS, agentTask } from '#dist/shared/properties/agentTask.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const good = { ...EMPTY_AUDIT_IGNORES, ignored: [{ id: 'img-alt|src/pages/index.astro|0.1|src="/a.png"', reason: 'Decorative hero' }] };

test('the good file parses', () => {
  assert.deepEqual(parseAuditIgnores(good), good);
  assert.deepEqual(parseAuditIgnoresSource(undefined), EMPTY_AUDIT_IGNORES);
  assert.doesNotThrow(() => validateMetadata('audits', JSON.stringify(good)));
});

test('each bad shape is refused, naming the field', () => {
  const bad: readonly (readonly [unknown, RegExp])[] = [
    [undefined, /expected an object/],
    [[], /expected an object/],
    [{ version: 3, ignored: [] }, /version/],
    [{ version: 1, ignored: [], tokens: {} }, /settings need version 2/],
    [{ version: 2, ignored: [], checks: { 'Bad Id': {} } }, /not a check id/],
    [{ version: 2, ignored: [], checks: { 'img-alt': { enabled: 'no' } } }, /enabled: expected a boolean/],
    [{ version: 2, ignored: [], checks: { 'img-alt': { priority: 'urgent' } } }, /priority/],
    [{ version: 2, ignored: [], tokens: { colours: true } }, /unknown field "colours"/],
    [{ version: 2, ignored: [], tokens: { px: 1 } }, /px: expected a boolean/],
    [{ version: 2, ignored: [], placeholders: [''] }, /placeholders\[0\]/],
    [{ version: 2, ignored: [], tokens: { allowed: 'auto' } }, /allowed: expected an array/],
    [{ version: 1 }, /ignored: expected an array/],
    [{ version: 1, ignored: [], extra: true }, /unknown field "extra"/],
    [{ version: 1, ignored: ['x'] }, /ignored\[0\]: expected an object/],
    [{ version: 1, ignored: [{ id: '', reason: 'r' }] }, /ignored\[0\]\.id/],
    [{ version: 1, ignored: [{ id: 'a', reason: '  ' }] }, /ignored\[0\]\.reason/],
    [{ version: 1, ignored: [{ id: 'a', reason: 'r', at: 1 }] }, /unknown field "at"/],
    [
      {
        version: 1,
        ignored: [
          { id: 'a', reason: 'r' },
          { id: 'a', reason: 's' },
        ],
      },
      /listed twice/,
    ],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseAuditIgnores(input), message);
  }
  assert.throws(() => parseAuditIgnoresSource('{broken'), SyntaxError);
  assert.throws(() => validateMetadata('audits', JSON.stringify({ version: 1, ignored: 'no' })), /expected an array/);
});

test('bounds hold at the limit and fail just past it', () => {
  const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `id-${index}`, reason: 'r' }));
  assert.doesNotThrow(() => parseAuditIgnores({ version: 1, ignored: entries(AUDIT_IGNORE_LIMITS.entriesMax) }));
  assert.throws(() => parseAuditIgnores({ version: 1, ignored: entries(AUDIT_IGNORE_LIMITS.entriesMax + 1) }), /more than/);
  assert.doesNotThrow(() => parseAuditIgnores({ version: 1, ignored: [{ id: 'x'.repeat(AUDIT_IGNORE_LIMITS.idCharsMax), reason: 'r' }] }));
  assert.throws(() => parseAuditIgnores({ version: 1, ignored: [{ id: 'x'.repeat(AUDIT_IGNORE_LIMITS.idCharsMax + 1), reason: 'r' }] }), /longer than/);
  assert.throws(() => parseAuditIgnores({ version: 1, ignored: [{ id: 'a', reason: 'r'.repeat(AUDIT_IGNORE_LIMITS.reasonCharsMax + 1) }] }), /longer than/);
});

test('what is written reads back, and edits keep ids unique', () => {
  const text = serializeAuditIgnores(good);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(parseAuditIgnoresSource(text), good);
  const added = withIgnore(good, { id: 'b', reason: '  Third-party embed  ' });
  assert.deepEqual(
    added.ignored.map((entry) => entry.reason),
    ['Decorative hero', 'Third-party embed'],
  );
  const replaced = withIgnore(added, { id: 'b', reason: 'New reason' });
  assert.equal(replaced.ignored.length, 2);
  assert.equal(replaced.ignored[1]?.reason, 'New reason');
  assert.deepEqual(withoutIgnore(replaced, 'b'), good);
  assert.throws(() => withIgnore(good, { id: 'c', reason: ' ' }), /reason/);
});

test('an agent task is bounded where it is built', () => {
  const task = {
    title: 'Fix',
    prompt: 'Do it',
    context: { files: ['src/pages/index.astro'], nodeRefs: [{ file: 'src/pages/index.astro', path: [0] }], findingIds: ['a'] },
  };
  assert.deepEqual(agentTask(task), task);
  assert.throws(() => agentTask({ ...task, title: ' ' }), /title/);
  assert.throws(() => agentTask({ ...task, prompt: 'x'.repeat(AGENT_TASK_LIMITS.promptCharsMax + 1) }), /prompt is bounded/);
  assert.throws(() => agentTask({ ...task, context: { ...task.context, files: ['/abs/file.astro'] } }), /project-relative/);
});

test('version 2 settings: defaults fill what the file leaves out, and only choices are written', () => {
  const read = parseAuditIgnores({ version: 1, ignored: [] });
  assert.equal(read.version, 2, 'version 1 reads as version 2');
  assert.deepEqual(read.tokens, DEFAULT_TOKEN_SETTINGS);
  assert.deepEqual(read.placeholders, DEFAULT_PLACEHOLDERS);
  const chosen = withCheckSetting({ ...read, tokens: { ...read.tokens, px: true, allowed: ['1px'] } }, 'token-value', { enabled: false, priority: undefined });
  const text = serializeAuditIgnores(chosen);
  assert.deepEqual(JSON.parse(text), {
    version: 2,
    ignored: [],
    checks: { 'token-value': { enabled: false } },
    tokens: { ...DEFAULT_TOKEN_SETTINGS, px: true, allowed: ['1px'] },
  });
  assert.deepEqual(parseAuditIgnoresSource(text), chosen);
  assert.deepEqual(withCheckSetting(chosen, 'token-value', { enabled: true, priority: undefined }).checks, {}, 'back to its defaults: nothing written');
  assert.equal(serializeAuditIgnores(EMPTY_AUDIT_IGNORES), '{\n  "version": 2,\n  "ignored": []\n}\n', 'defaults are not written');
  const lists = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`);
  assert.doesNotThrow(() => parseAuditIgnores({ version: 2, ignored: [], placeholders: lists(AUDIT_IGNORE_LIMITS.listItemsMax) }));
  assert.throws(() => parseAuditIgnores({ version: 2, ignored: [], placeholders: lists(AUDIT_IGNORE_LIMITS.listItemsMax + 1) }), /more than/);
  assert.equal(tokenProperty(DEFAULT_TOKEN_SETTINGS, 'padding-inline-start'), true);
  assert.equal(tokenProperty(DEFAULT_TOKEN_SETTINGS, 'color'), false);
});

// Whole-page ignores: an optional list beside the per-finding one. Old files read
// unchanged and write back without the key; bad entries are refused by field; add
// and remove touch only their entry and keep the order; the ignore list groups
// every entry by file, keeps stale ones, and a finding's own reason beats its page's.

const withPage = { ...good, ignoredPages: [{ file: 'src/pages/legal.astro', reason: 'Lawyers own the copy' }] };

test('page entries round-trip, and a file without them reads and writes as before', () => {
  assert.deepEqual(parseAuditIgnores(withPage), withPage);
  assert.deepEqual(parseAuditIgnoresSource(serializeAuditIgnores(withPage)), withPage);
  assert.equal(serializeAuditIgnores(good).includes('ignoredPages'), false, 'nothing to say, nothing written');
  assert.deepEqual(parseAuditIgnoresSource('{ "version": 1, "ignored": [] }').ignoredPages, []);
});

test('bad page entries are refused with the field named', () => {
  const bad = (pages: unknown) => () => parseAuditIgnores({ ...good, ignoredPages: pages });
  assert.throws(bad('x'), /ignoredPages: expected an array/);
  assert.throws(bad([1]), /ignoredPages\[0\]: expected an object/);
  assert.throws(bad([{ file: '', reason: 'r' }]), /ignoredPages\[0\]\.file/);
  assert.throws(bad([{ file: '/abs.astro', reason: 'r' }]), /ignoredPages\[0\]\.file/);
  assert.throws(bad([{ file: 'a.astro', reason: ' ' }]), /ignoredPages\[0\]\.reason/);
  assert.throws(bad([{ file: 'a.astro', reason: 'r', extra: 1 }]), /unknown field "extra"/);
  assert.throws(
    bad([
      { file: 'a.astro', reason: 'r' },
      { file: 'a.astro', reason: 's' },
    ]),
    /a file is listed twice/,
  );
  assert.throws(bad(Array.from({ length: AUDIT_IGNORE_LIMITS.pagesMax + 1 }, (_, index) => ({ file: `f${index}`, reason: 'r' }))), /more than/);
});

test('ignoring and unignoring a page touch only that entry', () => {
  const first = withIgnoredPage(good, { file: 'a.astro', reason: ' one ' });
  const second = withIgnoredPage(first, { file: 'b.astro', reason: 'two' });
  assert.deepEqual(second.ignoredPages, [
    { file: 'a.astro', reason: 'one' },
    { file: 'b.astro', reason: 'two' },
  ]);
  assert.deepEqual(
    withIgnoredPage(second, { file: 'a.astro', reason: 'again' }).ignoredPages.map((page) => page.file),
    ['b.astro', 'a.astro'],
    'replaced, moved last',
  );
  const without = withoutIgnoredPage(second, 'a.astro');
  assert.deepEqual(without.ignoredPages, [{ file: 'b.astro', reason: 'two' }]);
  assert.deepEqual(without.ignored, good.ignored, 'finding-level ignores stay');
  assert.deepEqual(withoutIgnoredPage(without, 'missing.astro'), without);
  assert.throws(() => withIgnoredPage(good, { file: 'a.astro', reason: ' ' }), /Assertion failed/);
  assert.deepEqual(withoutAnyIgnores({ ...withPage, checks: { x: { enabled: false, priority: undefined } } }).checks, {
    x: { enabled: false, priority: undefined },
  });
  assert.equal(ignoredEntryCount(withoutAnyIgnores(withPage)), 0);
});

const found = (id: string, file: string) => ({ id, file, detail: `detail ${id}` });

test('a page silences every finding in it; a finding keeps its own reason', () => {
  const alt = found('img-alt|src/pages/legal.astro|0|a', 'src/pages/legal.astro');
  const link = found('link-text|src/pages/legal.astro|1|b', 'src/pages/legal.astro');
  const other = found('x|src/pages/home.astro|0|c', 'src/pages/home.astro');
  const findings = [alt, link, other];
  const file = { ...withPage, ignored: [{ id: link.id, reason: 'mine' }] };
  const reasons = ignoreReasons(findings, file);
  assert.equal(reasons.get(alt.id), 'Lawyers own the copy');
  assert.equal(reasons.get(link.id), 'mine');
  assert.equal(reasons.has(other.id), false, 'another page is untouched');
  assert.equal(ignoredEntryCount(file), 2);
});

test('the ignored list groups by file and keeps stale entries removable', () => {
  const findings = [found('img-alt|src/pages/legal.astro|0|a', 'src/pages/legal.astro')];
  const file = {
    ...good,
    ignored: [
      { id: 'img-alt|src/pages/legal.astro|0|a', reason: 'live' },
      { id: 'img-alt|src/pages/gone.astro|3|old', reason: 'moved' },
    ],
    ignoredPages: [
      { file: 'src/pages/legal.astro', reason: 'whole' },
      { file: 'src/pages/deleted.astro', reason: 'stale page' },
    ],
  };
  const groups = ignoredGroups(findings, file);
  assert.deepEqual(
    groups.map((group) => [group.file, group.page?.count, group.findings.map((row) => row.live)]),
    [
      ['src/pages/deleted.astro', 0, []],
      ['src/pages/gone.astro', undefined, [false]],
      ['src/pages/legal.astro', 1, [true]],
    ],
  );
  assert.equal(groups[1]?.findings[0]?.label, 'old', 'a stale entry is named from its id');
  assert.deepEqual(ignoredGroups([], EMPTY_AUDIT_IGNORES), []);
});
