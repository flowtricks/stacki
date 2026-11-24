// Goal: a project's custom audits read from `.stacki/audits.json` only as a bounded, unique list of well-formed audits; every
// known-bad shape is refused naming its field; a file without the list reads as before and writes no list; and the regular
// expression guard refuses every pattern shape that can hang the matcher (nested repeats, backreferences, too many open-ended
// repeats, over-long, invalid, empty-matching) while it lets the owner's two examples and every preset through.
// Method: parse a known-good file, then each known-bad entry; round-trip through the app's serializer; run `checkPattern` over
// catastrophic, over-long and invalid patterns, pinning each refusal's code; compile every preset; derive ids against taken ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_AUDIT_IGNORES, parseAuditIgnores, parseAuditIgnoresSource, serializeAuditIgnores } from '#dist/shared/properties/auditIgnores.js';
import {
  CUSTOM_AUDIT_LIMITS,
  CUSTOM_AUDIT_PRESETS,
  checkPattern,
  compileCustomAudit,
  customAuditCategoryOf,
  customAuditIdFor,
  parseCustomAudits,
  withCustomAudit,
  withoutCustomAudit,
} from '#dist/shared/properties/customAudits.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const textAlign = {
  id: 'hard-coded-text-align',
  name: 'Hard-coded text-align',
  icon: 'text',
  category: 'tokens',
  severity: 'low',
  scope: 'declaration',
  match: { property: '^text-align$', valueMustNotMatch: 'var\\(' },
  enabled: true,
};
const todo = { id: 'todo', name: 'TODO', icon: 'placeholder', category: 'Launch', scope: 'markup', match: { pattern: '\\bTODO\\b' }, enabled: false };

test('a file with custom audits reads, and what is written reads back the same', () => {
  const file = parseAuditIgnores({ version: 2, ignored: [], customAudits: [textAlign, todo] });
  assert.equal(file.customAudits.length, 2);
  assert.deepEqual(file.customAudits[0]?.match, { scope: 'declaration', property: '^text-align$', valueMustMatch: undefined, valueMustNotMatch: 'var\\(' });
  assert.equal(file.customAudits[1]?.category, 'Launch');
  assert.equal(file.customAudits[1]?.severity, 'medium', 'severity defaults to medium');
  const text = serializeAuditIgnores(file);
  assert.deepEqual(parseAuditIgnoresSource(text), file);
  assert.ok(!text.includes('"severity": "medium"'), 'a default severity is not written');
  validateMetadata('audits', text);
});

test('a file without custom audits reads as before and writes no list', () => {
  const file = parseAuditIgnoresSource('{ "version": 2, "ignored": [] }\n');
  assert.deepEqual(file.customAudits, []);
  assert.ok(!serializeAuditIgnores(file).includes('customAudits'));
  assert.deepEqual(EMPTY_AUDIT_IGNORES.customAudits, []);
});

test('an entry’s unknown keys are ignored, so a newer Stacki’s field never breaks this one', () => {
  const [audit] = parseCustomAudits([{ ...textAlign, futureField: { anything: 1 } }]);
  assert.equal(audit?.id, 'hard-coded-text-align');
});

test('each known-bad custom audit is refused naming its field', () => {
  const bad: readonly (readonly [unknown, RegExp])[] = [
    ['nope', /customAudits: expected an array/],
    [[{ ...textAlign, id: 'Has Spaces' }], /\.id: expected lowercase/],
    [[{ ...textAlign, id: 'a'.repeat(41) }], /\.id: expected lowercase/],
    [[{ ...textAlign, id: '-leading' }], /\.id: expected lowercase/],
    [[{ ...textAlign, icon: 'rocket' }], /\.icon: expected one of/],
    [[{ ...textAlign, severity: 'loud' }], /\.severity: expected high, medium or low/],
    [[{ ...textAlign, enabled: 'yes' }], /\.enabled: expected a boolean/],
    [[{ ...textAlign, name: '   ' }], /\.name: expected a non-empty string/],
    [[{ ...textAlign, name: 'n'.repeat(CUSTOM_AUDIT_LIMITS.nameCharsMax + 1) }], /\.name: longer than/],
    [[{ ...textAlign, category: 'c'.repeat(CUSTOM_AUDIT_LIMITS.categoryCharsMax + 1) }], /\.category: longer than/],
    [[{ ...textAlign, message: '' }], /\.message: expected a non-empty string/],
    [[{ ...textAlign, scope: 'javascript' }], /\.scope: expected one of/],
    [[{ ...textAlign, match: 'text-align' }], /\.match: expected an object/],
    [[{ ...textAlign, match: {} }], /\.match\.property: expected a regular expression/],
    [[{ ...todo, match: { property: 'x' } }], /\.match\.pattern: expected a regular expression/],
    [[{ ...todo, match: { pattern: 'a'.repeat(CUSTOM_AUDIT_LIMITS.patternCharsMax + 1) } }], /\.match\.pattern: longer than/],
    [[{ ...textAlign, exclude: '' }], /\.exclude: expected a regular expression/],
    [[textAlign, textAlign], /an id is listed twice/],
    [Array.from({ length: CUSTOM_AUDIT_LIMITS.auditsMax + 1 }, (_, index) => ({ ...textAlign, id: `a${index}` })), /more than 50 audits/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseCustomAudits(input), message);
  }
  assert.throws(() => parseAuditIgnores({ version: 1, ignored: [], customAudits: [] }), /settings need version 2/);
});

test('a pattern that fails the guard still reads: the file stays usable, and the audit reports its problem when it runs', () => {
  const [audit] = parseCustomAudits([{ ...todo, match: { pattern: '(a+)+$' } }]);
  assert.ok(audit !== undefined);
  const compiled = compileCustomAudit(audit);
  assert.equal(compiled.ok ? '' : compiled.error.code, 'nested-repeat');
});

test('the guard refuses catastrophic, unsafe, invalid and useless patterns, each by its code', () => {
  const refused: readonly (readonly [string, string])[] = [
    ['', 'empty'],
    ['a'.repeat(CUSTOM_AUDIT_LIMITS.patternCharsMax + 1), 'too-long'],
    ['(unclosed', 'invalid'],
    ['[z-a]', 'invalid'],
    ['(a)\\1', 'backreference'],
    ['(?<word>a)\\k<word>', 'backreference'],
    ['(a+)+$', 'nested-repeat'],
    ['(a*)*b', 'nested-repeat'],
    ['(\\w+\\s?)*x', 'nested-repeat'],
    ['((ab)+)+', 'nested-repeat'],
    ['(x+){10}', 'nested-repeat'],
    ['(?:[a-z]+)+', 'nested-repeat'],
    ['a*b*c*d*', 'too-many-repeats'],
    ['.+.+.+.+', 'too-many-repeats'],
    ['x*', 'matches-empty'],
    ['^', 'matches-empty'],
  ];
  for (const [pattern, code] of refused) {
    const checked = checkPattern(pattern, 'pattern');
    assert.equal(checked.ok ? 'accepted' : checked.error.code, code, pattern);
    assert.ok(checked.ok || checked.error.message.startsWith('pattern: '), 'the message names the field');
  }
});

test('the guard lets ordinary patterns through: the owner examples, alternations, bounded and lazy repeats, classes', () => {
  for (const pattern of [
    '^text-align$',
    'var\\(',
    'var\\(\\s*--swatch-',
    '^(color|background(-color)?|border(-(top|right))?)$',
    '(foo|bar)+',
    '[a-z]{2,4}',
    '\\d+px',
    'url\\(.*?\\)',
    '[(+*]',
    '(?!--)[a-z]',
    '\\{\\}',
  ]) {
    const checked = checkPattern(pattern, 'pattern');
    assert.ok(checked.ok, `${pattern}: ${checked.ok ? '' : checked.error.message}`);
    assert.ok(checked.value.flags.includes('i'), 'patterns are case-insensitive');
  }
  // A filter may match empty text: "the value must not match ^\s*$" is a sensible rule.
  assert.ok(checkPattern('^\\s*$', 'valueMustNotMatch').ok);
  assert.ok(checkPattern('^\\s*$', 'exclude').ok);
});

test('every preset compiles through the guard and parses as a file entry', () => {
  assert.ok(CUSTOM_AUDIT_PRESETS.length >= 4);
  const ids = new Set<string>();
  for (const preset of CUSTOM_AUDIT_PRESETS) {
    assert.ok(!ids.has(preset.preset), 'preset ids are unique');
    ids.add(preset.preset);
    const compiled = compileCustomAudit(preset.audit);
    assert.ok(compiled.ok, `${preset.preset}: ${compiled.ok ? '' : compiled.error.message}`);
    const audits = withCustomAudit([], { ...preset.audit, id: preset.preset, enabled: true });
    const text = serializeAuditIgnores({ ...EMPTY_AUDIT_IGNORES, customAudits: audits });
    assert.deepEqual(parseAuditIgnoresSource(text).customAudits, audits);
  }
  assert.ok(ids.has('hard-coded-text-align'));
  assert.ok(ids.has('core-swatch-instead-of-theme'));
});

test('ids come from the name, unique against the list; categories resolve to built-in ids when they name one', () => {
  assert.equal(customAuditIdFor('Hard-coded text-align!', []), 'hard-coded-text-align');
  assert.equal(customAuditIdFor('Hard-coded text-align', ['hard-coded-text-align']), 'hard-coded-text-align-2');
  assert.equal(customAuditIdFor('Hard-coded text-align', ['hard-coded-text-align', 'hard-coded-text-align-2']), 'hard-coded-text-align-3');
  assert.equal(customAuditIdFor('!!!', []), 'custom-audit');
  assert.ok(customAuditIdFor('x'.repeat(200), []).length <= CUSTOM_AUDIT_LIMITS.idCharsMax);
  assert.equal(customAuditCategoryOf('  Tokens '), 'tokens');
  assert.equal(customAuditCategoryOf('Brand'), 'Brand');
});

test('the list is bounded and edited by id', () => {
  const [first] = parseCustomAudits([textAlign]);
  assert.ok(first !== undefined);
  const full = Array.from({ length: CUSTOM_AUDIT_LIMITS.auditsMax }, (_, index) => ({ ...first, id: `a${index}` }));
  assert.throws(() => withCustomAudit(full, { ...first, id: 'one-more' }), /at most 50 custom audits/);
  assert.equal(withCustomAudit(full, { ...first, id: 'a3', name: 'Renamed' })[3]?.name, 'Renamed', 'replacing keeps the place');
  assert.equal(withoutCustomAudit(full, 'a3').length, CUSTOM_AUDIT_LIMITS.auditsMax - 1);
});
