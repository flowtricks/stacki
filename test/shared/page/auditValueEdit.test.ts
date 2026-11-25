// Goal: typing a new value for a raw CSS value in the review window becomes
// exactly one token replacement, and anything that is not a single, balanced
// value is refused with a reason before a byte is written. The property's own
// acceptance is asked about the declaration as it would read, not the token alone.
// Method: parse known-good values (a length, a keyword, a variable, a calc) and
// each refusal (empty, too long, `;`, braces, comments, `!important`, unbalanced
// brackets and quotes, a value the property rejects); build the edit for a
// style-block and a stylesheet place, and none for an inline style; rewrite a
// group of identical findings; and read the static pass's findings for the place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditCssContext, AuditFinding } from '#dist/shared/page/auditFindings.js';
import { VALUE_EDIT_LIMITS, parseRawValue, valueEdit, valueFixes, withToken } from '#dist/shared/page/auditValueEdit.js';

const css = { property: 'gap', value: '0.5em', token: '0.5em' };

test('good values are trimmed and accepted', () => {
  for (const typed of ['1rem', '  2px ', 'auto', 'var(--space-2)', 'calc(var(--a) * 2)']) {
    const parsed = parseRawValue(css, typed, undefined);
    assert.ok(parsed.ok, typed);
    assert.equal(parsed.value, typed.trim());
  }
});

test('refusals name their reason and write nothing', () => {
  const refused = (typed: string, supports?: (property: string, value: string) => boolean) => {
    const parsed = parseRawValue(css, typed, supports);
    return parsed.ok ? 'accepted' : parsed.error;
  };
  assert.equal(refused(''), 'empty');
  assert.equal(refused('   '), 'empty');
  assert.equal(refused('x'.repeat(VALUE_EDIT_LIMITS.charsMax + 1)), 'long');
  assert.equal(refused('x'.repeat(VALUE_EDIT_LIMITS.charsMax)), 'accepted');
  assert.equal(refused('1px; color: red'), 'illegal');
  assert.equal(refused('1px } .x {'), 'illegal');
  assert.equal(refused('1px /* c */'), 'illegal');
  assert.equal(refused('1px !important'), 'important');
  assert.equal(refused('calc(1px'), 'unbalanced');
  assert.equal(refused('1px)'), 'unbalanced');
  assert.equal(refused('"open'), 'unbalanced');
  assert.equal(refused('('.repeat(VALUE_EDIT_LIMITS.parenDepthMax + 1) + ')'.repeat(VALUE_EDIT_LIMITS.parenDepthMax + 1)), 'unbalanced');
  assert.equal(
    refused('banana', (_property, value) => value !== 'banana'),
    'unsupported',
  );
});

test('the property is asked about the whole declaration with the token swapped', () => {
  const shadow = { property: 'box-shadow', value: '0 0 4px red', token: '4px' };
  assert.equal(withToken(shadow, '8px'), '0 0 8px red');
  const asked: string[] = [];
  parseRawValue(shadow, '8px', (_property, value) => (asked.push(value), true));
  assert.deepEqual(asked, ['0 0 8px red']);
});

const baseCss: AuditCssContext = {
  selector: '.a',
  property: 'gap',
  value: '0.5em',
  token: '0.5em',
  line: 1,
  group: 'spacing',
  place: { tag: 'stylesheet', offset: 7 },
};
const finding = (id: string, css: AuditCssContext | undefined): AuditFinding => ({
  id,
  check: 'token-value',
  file: 'a.css',
  fileKind: 'site',
  element: undefined,
  detail: 'd',
  source: 'static',
  fix: undefined,
  ...(css === undefined ? {} : { css }),
});
const unplaced: AuditCssContext = {
  selector: baseCss.selector,
  property: baseCss.property,
  value: baseCss.value,
  token: baseCss.token,
  line: 1,
  group: 'spacing',
};

test('the edit swaps the token where it is, and is absent where its bytes are unknown', () => {
  assert.deepEqual(valueEdit(baseCss, '1rem'), { tag: 'file-text', offset: 7, before: '0.5em', after: '1rem' });
  const block: AuditCssContext = { ...baseCss, place: { tag: 'style-block', path: [2], offset: 12 } };
  assert.deepEqual(valueEdit(block, 'var(--x)'), { tag: 'raw-text', path: [2], expect: 'style', offset: 12, before: '0.5em', after: 'var(--x)' });
  assert.equal(valueEdit(unplaced, '1rem'), undefined);
});

test('a group is rewritten together, or not at all', () => {
  const far: AuditCssContext = { ...baseCss, place: { tag: 'stylesheet', offset: 40 } };
  const fixes = valueFixes([finding('first', baseCss), finding('second', far)], '1rem');
  assert.ok(fixes !== undefined);
  assert.deepEqual(
    fixes.map((each) => each.fix?.edits),
    [[{ tag: 'file-text', offset: 7, before: '0.5em', after: '1rem' }], [{ tag: 'file-text', offset: 40, before: '0.5em', after: '1rem' }]],
  );
  assert.equal(fixes[0]?.fix?.after, 'gap: 1rem;');
  assert.equal(valueFixes([finding('first', baseCss), finding('third', unplaced)], '1rem'), undefined, 'one member without a place: no partial edit');
  assert.equal(valueFixes([finding('bare', undefined)], '1rem'), undefined);
});
