// Goal: removeClassFromExpression (shared/engine/classExpressionRemoval.ts) takes
// one class out of a `class:list` or `class={…}` expression the way a person
// would by hand: only the text that names the class changes, every other byte
// (quotes, indentation, CRLF, tabs, comments, trailing commas) stays, and the
// result still parses and no longer names the class. Shapes Stacki cannot
// rewrite come back as `computed` with where they are written, and broken code
// as `unreadable`, so nothing is ever written blind.
// Method: a table of before/after source text for every shape real projects
// write (strings, several words, object keys quoted and not, shorthand, nested
// arrays, ternaries, logical operators, templates, multi-line lists), each
// checked exactly; then the negative space (computed values, malformed code,
// limits, absent classes); then properties over the table: idempotence (a
// second removal finds nothing) and that the edit never touches text outside
// the removed class's own entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASS_EXPRESSION_LIMITS,
  classExpressionOccurrences,
  removeClassFromExpression,
  type ClassExpressionContext,
} from '#dist/shared/engine/classExpressionRemoval.js';
import { PLATFORM_LIMITS } from '#dist/shared/core/limits.js';

interface EditCase {
  readonly title: string;
  readonly before: string;
  readonly name: string;
  /** Undefined: nothing is left, so the attribute goes. */
  readonly after: string | undefined;
  readonly occurrences?: number;
  readonly context?: ClassExpressionContext;
}

const EDITS: readonly EditCase[] = [
  { title: 'a lone entry', before: "['a', 'b']", name: 'a', after: "['b']" },
  { title: 'the last entry', before: "['a', 'b']", name: 'b', after: "['a']" },
  { title: 'a middle entry', before: "['a', 'b', 'c']", name: 'b', after: "['a', 'c']" },
  { title: 'double quotes', before: '["a", "b"]', name: 'b', after: '["a"]' },
  { title: 'the only entry empties the list', before: "['a']", name: 'a', after: undefined },
  { title: 'one word of several', before: "['btn btn-primary', 'x']", name: 'btn', after: "['btn-primary', 'x']" },
  { title: 'the last word of several', before: "['btn btn-primary']", name: 'btn-primary', after: "['btn']" },
  { title: 'a word written twice in one string', before: "['a b a']", name: 'a', after: "['b']", occurrences: 2 },
  { title: 'a class written twice in the list', before: "['a', 'b', 'a']", name: 'a', after: "['b']", occurrences: 2 },
  { title: 'a trailing comma stays', before: "['a', 'b',]", name: 'b', after: "['a',]" },
  { title: 'an unquoted key with others', before: "['x', { b: on, c: off }]", name: 'b', after: "['x', { c: off }]" },
  { title: 'the only key removes the object', before: "['x', { b: on }]", name: 'b', after: "['x']" },
  { title: 'a quoted key', before: "[{ 'is-open': open }]", name: 'is-open', after: undefined },
  { title: 'one word of a quoted key', before: "['x', { 'c d': cond }]", name: 'c', after: "['x', { 'd': cond }]" },
  { title: 'a shorthand key', before: "['x', { active, open }]", name: 'active', after: "['x', { open }]" },
  { title: 'a nested array', before: "['x', ['a', 'b']]", name: 'a', after: "['x', ['b']]" },
  { title: 'a nested array emptied', before: "['x', ['a']]", name: 'a', after: "['x']" },
  { title: 'a guarded class removes the entry', before: "['x', cond && 'a']", name: 'a', after: "['x']" },
  { title: 'a guarded class with words', before: "['x', cond && 'a b']", name: 'a', after: "['x', cond && 'b']" },
  { title: 'a ternary arm becomes empty', before: "[cond ? 'open' : 'closed']", name: 'open', after: "[cond ? '' : 'closed']" },
  { title: 'the other ternary arm', before: "[cond ? 'open' : 'closed']", name: 'closed', after: "[cond ? 'open' : '']" },
  { title: 'a ternary with an empty arm goes', before: "['x', cond ? 'open' : '']", name: 'open', after: "['x']" },
  { title: 'both ternary arms the same class', before: "['x', cond ? 'a' : 'a']", name: 'a', after: "['x']", occurrences: 2 },
  { title: 'a fallback class', before: "['x', name || 'y']", name: 'y', after: "['x', name || '']" },
  { title: 'a nullish fallback class', before: "['x', name ?? 'y']", name: 'y', after: "['x', name ?? '']" },
  { title: 'a template word', before: '[`btn ${size}`]', name: 'btn', after: '[`${size}`]' },
  { title: 'a template word at the end', before: '[`${size} btn`]', name: 'btn', after: '[`${size}`]' },
  { title: 'a template word between holes', before: '[`${a} btn ${b}`]', name: 'btn', after: '[`${a} ${b}`]' },
  { title: 'a hole of its own', before: "[`a ${open ? 'is-open' : ''}`]", name: 'is-open', after: '[`a `]' },
  { title: 'a static template emptied', before: "['x', `a`]", name: 'a', after: "['x']" },
  { title: 'parentheses around an entry', before: "['x', (cond && 'a')]", name: 'a', after: "['x']" },
  { title: 'a comment between entries', before: "['a', /* why */ 'b']", name: 'b', after: "['a']" },
  { title: 'a comment beside a kept entry', before: "['a', 'b' /* keep */]", name: 'a', after: "['b' /* keep */]" },
  { title: 'Tailwind colons', before: "['md:flex', 'hover:bg-red-500']", name: 'md:flex', after: "['hover:bg-red-500']" },
  { title: 'Tailwind brackets', before: "['w-[10px] p-2']", name: 'w-[10px]', after: "['p-2']" },
  { title: 'a slash', before: "['w-1/2', 'x']", name: 'w-1/2', after: "['x']" },
  { title: 'unicode', before: "['café', 'naïve']", name: 'café', after: "['naïve']" },
  { title: 'a regex elsewhere is left alone', before: "['a', /a/.test(x) && 'b']", name: 'a', after: "[/a/.test(x) && 'b']" },
  { title: 'a computed entry is left as written', before: "['a', className]", name: 'a', after: '[className]' },
  { title: 'a spread is left as written', before: "['a', ...rest]", name: 'a', after: '[...rest]' },
  { title: 'a string root', before: "'a b'", name: 'a', after: "'b'" },
  { title: 'a string root emptied', before: "'a'", name: 'a', after: undefined },
  { title: 'an object root', before: '{ a: x, b: y }', name: 'a', after: '{ b: y }' },
  { title: 'class={…}: a template', before: '`card ${theme}`', name: 'card', after: '`${theme}`', context: 'string' },
  { title: 'class={…}: a ternary', before: "open ? 'a' : 'b'", name: 'a', after: "open ? '' : 'b'", context: 'string' },
  { title: 'class={…}: a guarded class', before: "open && 'a'", name: 'a', after: undefined, context: 'string' },
  // Lists broken over lines: the removed entry's line goes, the rest stay as written.
  {
    title: 'a multi-line list loses the line',
    before: "[\n  'a',\n  'b',\n  'c',\n]",
    name: 'b',
    after: "[\n  'a',\n  'c',\n]",
  },
  {
    title: 'a multi-line list without a trailing comma',
    before: "[\n  'a',\n  'b'\n]",
    name: 'b',
    after: "[\n  'a'\n]",
  },
  {
    title: 'a multi-line list loses its first line',
    before: "[\n  'a',\n  'b'\n]",
    name: 'a',
    after: "[\n  'b'\n]",
  },
  {
    title: 'a line comment goes with its entry',
    before: "[\n  'a', // first\n  'b', // second\n]",
    name: 'a',
    after: "[\n  'b', // second\n]",
  },
  { title: 'CRLF line endings', before: "[\r\n  'a',\r\n  'b',\r\n]", name: 'a', after: "[\r\n  'b',\r\n]" },
  { title: 'tab indentation', before: "[\n\t'a',\n\t'b',\n]", name: 'b', after: "[\n\t'a',\n]" },
  {
    title: 'a multi-line object',
    before: "[\n  'x',\n  {\n    a: on,\n    b: off,\n  },\n]",
    name: 'a',
    after: "[\n  'x',\n  {\n    b: off,\n  },\n]",
  },
  {
    title: 'a multi-line list with two entries on a line falls back to commas',
    before: "[\n  'a', 'b',\n  'c',\n]",
    name: 'b',
    after: "[\n  'a',\n  'c',\n]",
  },
];

test('every shape loses exactly the class, byte for byte', () => {
  for (const item of EDITS) {
    const result = removeClassFromExpression(item.before, item.name, item.context ?? 'list');
    assert.equal(result.tag, 'edited', `${item.title}: ${JSON.stringify(result)}`);
    if (result.tag !== 'edited') {
      continue;
    }
    assert.equal(result.code, item.after, item.title);
    assert.equal(result.occurrences, item.occurrences ?? 1, `${item.title}: occurrences`);
  }
});

test('removing again finds nothing: the edit is idempotent', () => {
  for (const item of EDITS) {
    if (item.after === undefined) {
      continue;
    }
    const context = item.context ?? 'list';
    assert.equal(classExpressionOccurrences(item.after, item.name, context), 0, item.title);
    const again = removeClassFromExpression(item.after, item.name, context);
    assert.notEqual(again.tag, 'edited', `${item.title}: a second removal edits nothing`);
  }
});

test('the edit leaves the other classes as they were', () => {
  for (const item of EDITS) {
    const context = item.context ?? 'list';
    for (const other of ['b', 'c', 'x', 'btn-primary', 'hover:bg-red-500', 'naïve', 'p-2']) {
      if (other === item.name || item.after === undefined) {
        continue;
      }
      const before = classExpressionOccurrences(item.before, other, context);
      const after = classExpressionOccurrences(item.after, other, context);
      assert.equal(after, before, `${item.title}: ${other} is still applied as often`);
    }
  }
});

test('computed values are reported with where they are written', () => {
  const cases: readonly { readonly code: string; readonly snippet: string }[] = [
    { code: '[className]', snippet: 'className' },
    { code: "['a', ...rest.class]", snippet: '...rest.class' },
    { code: '[getClasses()]', snippet: 'getClasses()' },
    { code: '[Astro.props.class]', snippet: 'Astro.props.class' },
    { code: 'props.classes', snippet: 'props.classes' },
    { code: '[`btn-${size}`]', snippet: '${size}' },
    { code: "['btn-' + size]", snippet: "'btn-' + size" },
    { code: '[{ [key]: on }]', snippet: '[key]: on' },
    { code: '[{ ...flags }]', snippet: '...flags' },
  ];
  for (const item of cases) {
    const result = removeClassFromExpression(item.code, 'btn-lg', 'list');
    assert.equal(result.tag, 'computed', `${item.code}: ${JSON.stringify(result)}`);
    if (result.tag !== 'computed') {
      continue;
    }
    const first = result.snippets[0];
    assert.ok(first !== undefined, `${item.code}: a snippet`);
    assert.equal(first.code, item.snippet, item.code);
    assert.equal(item.code.slice(first.from, first.to), item.snippet, `${item.code}: offsets point into the code`);
  }
});

test('a class not written and nothing computed is absent', () => {
  for (const code of ["['a', 'b']", '[]', '[{ a: on }]', "[cond ? 'a' : 'b']", "['a', null, false, undefined, 0]", "['btn-a']"]) {
    assert.deepEqual(removeClassFromExpression(code, 'btn', 'list'), { tag: 'absent' }, code);
  }
});

test('a word that is part of a computed one is never removed', () => {
  const result = removeClassFromExpression('[`btn${size}`]', 'btn', 'list');
  assert.equal(result.tag, 'computed');
  const glued = removeClassFromExpression('[`${size}btn`]', 'btn', 'list');
  assert.equal(glued.tag, 'computed');
});

test('condition values are not classes', () => {
  assert.deepEqual(removeClassFromExpression("[{ a: 'b' }]", 'b', 'list'), { tag: 'absent' });
  assert.deepEqual(removeClassFromExpression("[kind === 'b' && 'a']", 'b', 'list'), { tag: 'absent' });
  assert.deepEqual(removeClassFromExpression("[kind === 'b' ? 'a' : 'c']", 'b', 'list'), { tag: 'absent' });
});

test('malformed code is unreadable and nothing is edited', () => {
  for (const code of ["['a', 'b'", "['a' 'b']", "['a',, ]]", '', "['a'; 'b']", '{ a: }', "['a', `b]"]) {
    const result = removeClassFromExpression(code, 'a', 'list');
    assert.deepEqual(result, { tag: 'unreadable', reason: 'syntax' }, code);
  }
});

test('code past the depth bound is refused, not walked; long code is read', () => {
  // Code length is bounded only by the string: a longer one cannot be built, and Stacki has no product size limit.
  assert.equal(CLASS_EXPRESSION_LIMITS.codeCharsMax, PLATFORM_LIMITS.stringUnitsMax);
  const long = `['a', '${'x'.repeat(2 ** 20)}']`;
  assert.equal(removeClassFromExpression(long, 'a', 'list').tag, 'edited');
  assert.equal(classExpressionOccurrences(long, 'a', 'list'), 1);
  const deep = `${'['.repeat(CLASS_EXPRESSION_LIMITS.depthMax + 2)}'a'${']'.repeat(CLASS_EXPRESSION_LIMITS.depthMax + 2)}`;
  assert.deepEqual(removeClassFromExpression(deep, 'a', 'list'), { tag: 'unreadable', reason: 'limit' });
  const shallow = `${'['.repeat(4)}'a', 'b'${']'.repeat(4)}`;
  assert.equal(removeClassFromExpression(shallow, 'a', 'list').tag, 'edited');
});

test('a string context does not read arrays or objects as class lists', () => {
  const result = removeClassFromExpression("['a', 'b']", 'a', 'string');
  assert.equal(result.tag, 'computed');
});

test('preconditions are asserted', () => {
  assert.throws(() => removeClassFromExpression("['a']", '', 'list'), /a class has a name/);
  assert.throws(() => removeClassFromExpression("['a']", 'a b', 'list'), /one class, no whitespace/);
});

test('the quote style follows the file', () => {
  const double = removeClassFromExpression('[cond ? "open" : "closed"]', 'open', 'list');
  assert.deepEqual(double, { tag: 'edited', code: '[cond ? "" : "closed"]', occurrences: 1 });
  const single = removeClassFromExpression("[cond ? 'open' : 'closed']", 'open', 'list');
  assert.deepEqual(single, { tag: 'edited', code: "[cond ? '' : 'closed']", occurrences: 1 });
});
