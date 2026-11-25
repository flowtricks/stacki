// Goal: the rich reading of a template if's test draws every test an author
// writes as groups of rows, keeping each part the rows cannot draw as a locked
// Computed part holding its code byte for byte, and never changes what a test
// means: an untouched test is never rewritten, an edited one rewrites only the
// test, with the locked parts exactly as they were read. Only code that cannot
// be delimited (a regular expression, brackets that do not close) is refused.
//
// Method: the pure modules, bundled as the app bundles them. A table of real
// shapes (Lumos Button's `render && (isWritten ? content : true)`, `||`, `!`,
// comparisons, lists, optional chaining, leading comments) is read into the
// model it should give. Every read is proved by running the original and its
// rewriting over a grid of generated values and requiring the same answer. An
// edit is made on the model and the written test compared with the expected
// minimal text. The top-level scanner is held to its negative space, and every
// if in the Lumos fixture (test/fixtures/lumos, a copy of the starter) must read,
// with each locked part found verbatim in its test and the rewriting a fixed point.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const expression = load('src/editor/conditionExpression.ts');
const rich = load('src/editor/conditionExpressionRich.ts');
const scan = load('src/editor/conditionCodeScan.ts');
const parser = load('electron/parse/astroParser.ts');

const DOUBLE = { quote: '"' };
const code = (text) => ({ kind: 'code', code: text });
const isTrue = (subject) => ({ subject, operator: 'isTrue' });
const isFalse = (subject) => ({ subject, operator: 'isFalse' });
const all = (...conditions) => ({ groups: [{ match: 'all', conditions }] });

// Every name each of a few shapes, so a rewriting that differs in meaning shows on some row.
const SHAPES = [undefined, JSON.parse('null'), true, false, 0, 1, 3, '', 'main', 'link', 'play', [], ['a']];
const NAMES = ['render', 'isWritten', 'content', 'variant', 'count', 'hidden', 'items', 'image', 'note', 'a', 'b', 'c'];
function scopes() {
  const out = [];
  for (const first of SHAPES) {
    for (const second of [undefined, true, false, 'main', 2]) {
      const scope = {};
      for (const [index, name] of NAMES.entries()) {
        scope[name] = index % 2 === 0 ? first : second;
      }
      scope.image = first === undefined ? undefined : { url: second };
      scope.note = second === undefined ? undefined : { kind: first };
      scope.items = Array.isArray(first) ? first : [second];
      out.push(scope);
    }
  }
  return out;
}
const SCOPES = scopes();

// What the code answers over the grid, as truthiness (an if renders on truthiness), or that it throws.
function answers(source) {
  const run = new Function(...NAMES, `return (${source});`);
  return SCOPES.map((scope) => {
    try {
      return Boolean(run(...NAMES.map((name) => scope[name])));
    } catch (error) {
      return `throws ${String(error).split(':')[0]}`;
    }
  });
}

const SHAPES_READ = [
  ['render && (isWritten ? content : true)', all(isTrue('render'), code('isWritten ? content : true'))],
  ['render && (a || b)', all(isTrue('render'), code('a || b'))],
  [
    '!hidden || count > 3',
    { groups: [{ match: 'any', conditions: [isFalse('hidden'), { subject: 'count', operator: 'greaterThan', value: { kind: 'number', value: 3 } }] }] },
  ],
  [
    'a || b && c',
    {
      groups: [
        { match: 'all', conditions: [isTrue('a')] },
        { match: 'all', conditions: [isTrue('b'), isTrue('c')] },
      ],
    },
  ],
  [
    '["main", "link"].includes(variant)',
    all({
      subject: 'variant',
      operator: 'isAnyOf',
      values: [
        { kind: 'string', value: 'main' },
        { kind: 'string', value: 'link' },
      ],
    }),
  ],
  ["!['play'].includes(variant) && render", all({ subject: 'variant', operator: 'isNoneOf', values: [{ kind: 'string', value: 'play' }] }, isTrue('render'))],
  ['image?.url', all(isTrue('image?.url'))],
  ['note?.kind === "main" && !hidden', all({ subject: 'note?.kind', operator: 'equals', value: { kind: 'string', value: 'main' } }, isFalse('hidden'))],
  ['variant == "main"', all(code('variant == "main"'))],
  ['a ? b : c', all(code('a ? b : c'))],
  ['count >= 1 && format(count)', all({ subject: 'count', operator: 'atLeast', value: { kind: 'number', value: 1 } }, code('format(count)'))],
  ['/* Shown when set. */ render', { ...all(isTrue('render')), leading: '/* Shown when set. */' }],
];

test('each real shape reads into the rows it should, its undrawable parts locked as written', () => {
  for (const [source, model] of SHAPES_READ) {
    assert.deepEqual(rich.readRichConditionExpression(source), model, source);
  }
});

test('a test the strict reading takes reads exactly as it did', () => {
  for (const source of ['variant === "play"', 'a && b', 'a || b', '(a && b) || c', 'items.length > 0', '!hidden']) {
    assert.deepEqual(rich.readRichConditionExpression(source), expression.readConditionExpression(source), source);
  }
});

test('writing a read test back means the same, and locked parts go back byte for byte', () => {
  for (const [source] of SHAPES_READ) {
    if (source.includes('format(')) {
      continue; // `format` is a name in no scope here: the original and the rewriting both throw, which `answers` cannot call equal by message.
    }
    const model = rich.readRichConditionExpression(source);
    assert.notEqual(model, undefined, source);
    const written = expression.emitConditionExpression(model, DOUBLE);
    assert.deepEqual(answers(written), answers(source), `${source} → ${written}`);
    for (const group of model.groups) {
      for (const condition of group.conditions) {
        if (expression.isCodeCondition(condition)) {
          assert.ok(written.includes(condition.code), `the locked part is kept: ${condition.code}`);
          assert.ok(source.includes(condition.code), `and it is the source's own text: ${condition.code}`);
        }
      }
    }
    assert.deepEqual(rich.readRichConditionExpression(written), model, `the rewriting reads back the same: ${written}`);
  }
});

test('an edit rewrites only what changed: the Button test with Render turned to false', () => {
  const source = 'render && (isWritten ? content : true)';
  const model = rich.readRichConditionExpression(source);
  const [group] = model.groups;
  const edited = { groups: [{ ...group, conditions: [isFalse('render'), group.conditions[1]] }] };
  assert.equal(expression.emitConditionExpression(edited, DOUBLE), '!render && (isWritten ? content : true)');
  assert.equal(expression.emitConditionExpression(model, DOUBLE), source, 'unedited, the writing is the source itself');
});

test('code that cannot be delimited is refused, and nothing else is', () => {
  for (const source of ['/^a/.test(title)', 'a && /x/.test(b)', '(a', 'a)', 'a ||', '&& a', '"open', '`a ${b`', 'a /* open']) {
    assert.equal(rich.readRichConditionExpression(source), undefined, `must stay code: ${source}`);
  }
  assert.deepEqual(rich.readRichConditionExpression(''), { groups: [] }, 'blank is the empty model');
  assert.equal(rich.readRichConditionExpression('a'.repeat(1_000_000)), undefined, 'past the bound is code');
});

test('the scanner finds only the top level, and refuses what it cannot delimit', () => {
  assert.deepEqual(scan.scanTopLevel('render && (isWritten ? content : true)'), { ors: [], ands: [7], loose: false });
  assert.deepEqual(scan.scanTopLevel('a || "b || c" || `${d && e}`'), { ors: [2, 14], ands: [], loose: false });
  assert.deepEqual(scan.scanTopLevel('a ? b : c'), { ors: [], ands: [], loose: true });
  assert.equal(scan.scanTopLevel('a ?? b').loose, true);
  assert.equal(scan.scanTopLevel('a?.b && c').loose, false, '`?.` is a member access');
  assert.equal(scan.scanTopLevel('a ||= b').loose, true, 'an assignment');
  assert.equal(scan.scanTopLevel('a === b').loose, false, 'a comparison');
  assert.equal(scan.scanTopLevel('a / 2 > 1').loose, false, 'a division');
  for (const bad of ['/a/', '(a]', '{a', 'a}', "'a", 'x === "a\nb"']) {
    assert.equal(scan.scanTopLevel(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(scan.withoutOuterParentheses('(a || b)'), 'a || b');
  assert.equal(scan.withoutOuterParentheses('(a) || (b)'), '(a) || (b)', 'two pairs are not one');
  assert.equal(scan.needsParentheses('a ? b : c'), true);
  assert.equal(scan.needsParentheses('format(a)'), false);
});

test('a list reads only literals the writer can spell, and one name', () => {
  assert.equal(rich.readListTest('[a, b].includes(x)'), undefined, 'names in the list are code');
  assert.equal(rich.readListTest('["a"].includes(x.y())'), undefined, 'a call is not a name');
  assert.equal(rich.readListTest('[].includes(x)'), undefined, 'an empty list is code');
  assert.equal(rich.readListTest('["a\\\\b"].includes(x)'), undefined, 'an escape is code');
  assert.deepEqual(rich.readListTest('[1, 2,].includes(n)'), {
    subject: 'n',
    operator: 'isAnyOf',
    values: [
      { kind: 'number', value: 1 },
      { kind: 'number', value: 2 },
    ],
  });
});

// Every `if` the Lumos starter writes, read from the fixture copy with the app's own parser.
function lumosTests() {
  const root = repoPath('test/fixtures/lumos');
  const files = [];
  const pending = [root];
  for (let round = 0; pending.length > 0 && round < 1_000; round += 1) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith('.astro')) {
        files.push(full);
      }
    }
  }
  const tests = [];
  for (const file of files) {
    const nodes = [...parser.parsePage(fs.readFileSync(file, 'utf8')).model.nodes];
    for (let round = 0; nodes.length > 0 && round < 100_000; round += 1) {
      const node = nodes.pop();
      if (node.kind === 'cond') {
        tests.push(node.test);
      }
      nodes.push(...(node.children ?? []));
    }
  }
  return tests;
}

test('every if in the Lumos starter opens as rows; the ones the strict reading refused carry one locked part', () => {
  const tests = lumosTests();
  assert.ok(tests.length >= 50, `the fixture has its ifs (${tests.length})`);
  let strict = 0;
  let locked = 0;
  for (const source of tests) {
    const model = rich.readRichConditionExpression(source);
    assert.notEqual(model, undefined, `reads: ${source}`);
    if (expression.readConditionExpression(source) !== undefined) {
      strict += 1;
    }
    if (rich.hasLockedCode(model)) {
      locked += 1;
      for (const group of model.groups) {
        for (const condition of group.conditions.filter(expression.isCodeCondition)) {
          assert.ok(source.includes(condition.code), `the locked part is the source's own text: ${condition.code}`);
        }
      }
    }
    const written = expression.emitConditionExpression(model, DOUBLE);
    assert.deepEqual(rich.readRichConditionExpression(written), model, `a fixed point: ${source}`);
  }
  assert.equal(strict + locked, tests.length, 'every if is rows, or rows with a locked part');
  assert.ok(locked <= 4, `at most the four tests the strict reading refused carry code (${locked})`);
});
