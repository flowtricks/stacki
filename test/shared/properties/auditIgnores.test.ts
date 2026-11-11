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
  tokenProperty,
  DEFAULT_PLACEHOLDERS,
  DEFAULT_TOKEN_SETTINGS,
} from '#dist/shared/properties/auditIgnores.js';
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
