// Goal: a template condition is read into groups of conditions only when the
// model says exactly what the code says, written back as clean idiomatic
// JavaScript, and anything else is reported as code so the visual editor never
// rewrites what it cannot draw.
//
// Method: the pure module, bundled as the app bundles it. Known-good code is
// read into the model it should give and written back byte for byte (the
// editor's own style). Every read is then proved by running both the code and
// its rewriting over a grid of values (generated fixtures only) and requiring
// the same answer, so a reading that changes what a condition means fails here.
// Writing is checked over every operator, then over generated models, which
// must read back to a model that means the same. Last the negative space: a
// long list of expressions an author or an AI might write (calls, optional
// chaining, ternaries, regular expressions, `in`, `instanceof`, template
// strings, bitwise, comma, assignment, `await`, `typeof`, loose equality,
// strict equality against null, a literal on the left, nested `&&` in `||` in
// `&&`) must come back as undefined, and every bound must hold at its limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const expression = load('src/editor/conditionExpression.ts');

const DOUBLE = { quote: '"' };
const SINGLE = { quote: "'" };

const equals = (subject, value) => ({ subject, operator: 'equals', value: { kind: 'string', value } });
const only = (...conditions) => ({ groups: [{ match: 'all', conditions }] });
const anyOf = (...conditions) => ({ groups: [{ match: 'any', conditions }] });
const isTrue = (subject) => ({ subject, operator: 'isTrue' });

// Values the conditions below are run over: every name is each of a few shapes, so a reading
// that differs in meaning shows on some row of the grid.
const SHAPES = [undefined, JSON.parse('null'), true, false, 0, 1, 2, -1, '', 'a', 'home-platform', 'x', [], ['a'], ['a', 'b']];
function scopes() {
  const out = [];
  for (const first of SHAPES) {
    for (const second of [undefined, true, false, 1, 'x']) {
      for (const third of [undefined, 0, 'a']) {
        out.push({
          a: first,
          b: second,
          c: third,
          x: first,
          arr: Array.isArray(first) ? first : [second],
          n: typeof first === 'number' ? first : third,
          posts: [{ title: first }],
          list: first,
          items: [first],
          card: { fluted: first },
          post: { data: { 'campus-name': first } },
        });
      }
    }
  }
  return out;
}
const SCOPES = scopes();

// What the code answers, or that it throws: a rewriting must fail on the same values the original does.
function run(code, scope) {
  try {
    // A generated fixture's own code, run only over the grid above.
    return String(new Function('scope', `with (scope) { return Boolean(${code}); }`)(scope));
  } catch {
    return 'throws';
  }
}
function sameMeaning(left, right) {
  for (const scope of SCOPES) {
    assert.equal(run(left, scope), run(right, scope), `${left}  vs  ${right}`);
  }
}

test('known-good code reads into the model it says and writes back unchanged', () => {
  const table = [
    ['card.fluted === "home-platform"', only(equals('card.fluted', 'home-platform'))],
    ['a && b', only(isTrue('a'), isTrue('b'))],
    ['a || b || c', anyOf(isTrue('a'), isTrue('b'), isTrue('c'))],
    ['!x', only({ subject: 'x', operator: 'isFalse' })],
    ['x != null', only({ subject: 'x', operator: 'isSet' })],
    ['x == null', only({ subject: 'x', operator: 'isNotSet' })],
    ['arr.length > 0', only({ subject: 'arr', operator: 'isNotEmpty' })],
    ['arr.length === 0', only({ subject: 'arr', operator: 'isEmpty' })],
    ['arr.includes("a")', only({ subject: 'arr', operator: 'contains', value: { kind: 'string', value: 'a' } })],
    ['!arr.includes("a")', only({ subject: 'arr', operator: 'notContains', value: { kind: 'string', value: 'a' } })],
    ['n > 1', only({ subject: 'n', operator: 'greaterThan', value: { kind: 'number', value: 1 } })],
    ['n < 1', only({ subject: 'n', operator: 'lessThan', value: { kind: 'number', value: 1 } })],
    ['n >= -1.5', only({ subject: 'n', operator: 'atLeast', value: { kind: 'number', value: -1.5 } })],
    ['n <= 2', only({ subject: 'n', operator: 'atMost', value: { kind: 'number', value: 2 } })],
    ['x !== "a"', only({ subject: 'x', operator: 'notEquals', value: { kind: 'string', value: 'a' } })],
    ['b === true', only({ subject: 'b', operator: 'equals', value: { kind: 'boolean', value: true } })],
    ['post.data["campus-name"] === "x"', only(equals('post.data["campus-name"]', 'x'))],
    ['posts[0].title', only(isTrue('posts[0].title'))],
    [
      'a || (b && c)',
      {
        groups: [
          { match: 'all', conditions: [isTrue('a')] },
          { match: 'all', conditions: [isTrue('b'), isTrue('c')] },
        ],
      },
    ],
  ];
  for (const [code, model] of table) {
    const read = expression.readConditionExpression(code);
    assert.deepEqual(read, model, code);
    assert.equal(expression.emitConditionExpression(read, DOUBLE), code, `${code} writes back as written`);
    sameMeaning(code, expression.emitConditionExpression(read, DOUBLE));
  }
});

test('reading ignores spacing, line breaks, quote style and redundant parentheses, and the writer settles them', () => {
  const table = [
    ['  a&&b ', 'a && b'],
    ['a\n  &&\n  b', 'a && b'],
    ["card.fluted === 'home-platform'", 'card.fluted === "home-platform"'],
    ['((a))', 'a'],
    ['(a && b)', 'a && b'],
    ['a && (b && c)', 'a && b && c'],
    ['(a || b) || c', 'a || b || c'],
    ['a && b || c', '(a && b) || c'],
    ['(a && b) || (c && a)', '(a && b) || (c && a)'],
    ['(a)||(b)', 'a || b'],
    ['arr . length > 0', undefined],
  ];
  for (const [code, written] of table) {
    const read = expression.readConditionExpression(code);
    if (written === undefined) {
      assert.equal(read, undefined, code);
      continue;
    }
    assert.notEqual(read, undefined, code);
    assert.equal(expression.emitConditionExpression(read, DOUBLE), written, code);
    sameMeaning(code, written);
  }
});

test('writing keeps the quote the file uses and switches only when the text holds that quote', () => {
  const model = only(equals('x', 'a'));
  assert.equal(expression.emitConditionExpression(model, SINGLE), "x === 'a'");
  assert.equal(expression.emitConditionExpression(model, DOUBLE), 'x === "a"');
  assert.equal(expression.emitConditionExpression(only(equals('x', "it's")), SINGLE), 'x === "it\'s"');
  assert.equal(expression.emitConditionExpression(only(equals('x', 'say "hi"')), DOUBLE), 'x === \'say "hi"\'');
  assert.equal(expression.expressionQuoteOf('', "a === 'b'", 'c === "d"'), "'");
  assert.equal(expression.expressionQuoteOf('nothing'), '"');
  assert.equal(expression.expressionQuoteOf(), '"');
});

test('every operator writes its idiomatic form and reads back as itself', () => {
  const literal = { kind: 'string', value: 'a' };
  for (const operator of expression.VALUELESS_OPERATORS) {
    const model = only({ subject: 'list', operator });
    const code = expression.emitConditionExpression(model, DOUBLE);
    assert.deepEqual(expression.readConditionExpression(code), model, code);
  }
  for (const operator of expression.VALUED_OPERATORS) {
    const numeric = expression.ordersValues(operator) || operator === 'lengthEquals' || operator === 'lengthGreaterThan';
    const value = numeric ? { kind: 'number', value: 3 } : literal;
    const model = only({ subject: 'list', operator, value });
    const code = expression.emitConditionExpression(model, DOUBLE);
    assert.deepEqual(expression.readConditionExpression(code), model, code);
  }
  // The list operators are read only by the rich reading (conditionExpressionRich.test.js), which also writes them.
  assert.equal(
    expression.EXPRESSION_OPERATORS.length,
    expression.VALUELESS_OPERATORS.length + expression.VALUED_OPERATORS.length + expression.LIST_OPERATORS.length,
  );
  assert.equal(expression.takesValue('equals'), true);
  assert.equal(expression.takesValue('isSet'), false);
});

test('generated models write code that reads back to a model that means the same', () => {
  // A small deterministic generator: no randomness, so a failure names its model.
  const subjects = ['a', 'b', 'x', 'card.fluted', 'arr'];
  const conditions = [];
  for (const subject of subjects) {
    for (const operator of expression.VALUELESS_OPERATORS) {
      conditions.push({ subject, operator });
    }
    for (const value of [
      { kind: 'string', value: 'a' },
      { kind: 'number', value: 1 },
      { kind: 'boolean', value: true },
    ]) {
      for (const operator of ['equals', 'notEquals', 'contains', 'notContains']) {
        conditions.push({ subject, operator, value });
      }
    }
    conditions.push({ subject, operator: 'greaterThan', value: { kind: 'number', value: 0 } });
    conditions.push({ subject, operator: 'atMost', value: { kind: 'number', value: 1 } });
  }
  let checked = 0;
  for (let index = 0; index < conditions.length; index += 1) {
    const first = conditions[index];
    const second = conditions[(index * 7 + 3) % conditions.length];
    const third = conditions[(index * 13 + 5) % conditions.length];
    const models = [
      only(first),
      only(first, second),
      anyOf(first, second),
      {
        groups: [
          { match: 'all', conditions: [first, second] },
          { match: 'any', conditions: [second, third] },
        ],
      },
      {
        groups: [
          { match: 'all', conditions: [first] },
          { match: 'all', conditions: [second, third] },
          { match: 'all', conditions: [third] },
        ],
      },
    ];
    for (const model of models) {
      const code = expression.emitConditionExpression(model, DOUBLE);
      const read = expression.readConditionExpression(code);
      assert.notEqual(read, undefined, `what the writer writes is read: ${code}`);
      sameMeaning(code, expression.emitConditionExpression(read, DOUBLE));
      assert.equal(
        expression.emitConditionExpression(expression.readConditionExpression(expression.emitConditionExpression(read, DOUBLE)), DOUBLE),
        expression.emitConditionExpression(read, DOUBLE),
        `writing settles: ${code}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 500, 'a broad grid was checked');
});

test('code the model cannot say exactly reads as undefined: the negative space', () => {
  const unsupported = [
    // Calls and member tricks.
    'format(x)',
    'x.includes("a", 1)',
    'x.includes(y)',
    'x.includes()',
    '!x.startsWith("a")',
    '!x.endsWith("a")',
    'x.startsWith(1)',
    'x.startsWith(y)',
    'x.endsWith("a", 2)',
    'x.trim()',
    'includes("a")',
    'x.length()',
    'x?.y',
    'x?.y === 1',
    'x?.[0]',
    'x[y]',
    'x[0',
    'x.y.',
    'x.',
    'x..y',
    'x [0]',
    // Operators beyond the model.
    'a ? b : c',
    'a ?? b',
    'a ? b : c ? d : e',
    '/^a/.test(x)',
    'x.match(/a/)',
    '"a" in x',
    'x instanceof Date',
    '`${a}`',
    '`a` === x',
    'a & b',
    'a | b',
    'a ^ b',
    '~a',
    '(a, b)',
    'a, b',
    'a = b',
    'a += 1',
    'a++',
    'await a',
    'typeof a === "string"',
    'typeof a',
    'void 0',
    'delete a.b',
    'a + b',
    'a - 1 > 0',
    'a * 2 > 1',
    'a % 2 === 0',
    'a ** 2',
    '!!a',
    '!(a && b)',
    '!(a)',
    '-a',
    '+a',
    'new Date()',
    'function () {}',
    '() => a',
    'a => a',
    '[1, 2].includes(a)',
    '{ a: 1 }',
    'a; b',
    // Equality the model cannot keep.
    'x == "a"',
    'x == 1',
    'x == undefined',
    'x != undefined',
    'x === null',
    'x !== null',
    'x === undefined',
    'x !== undefined',
    'x === NaN',
    'x === Infinity',
    'x === y',
    'x === a.b',
    'x < y',
    'x > true',
    '!x === y',
    '!x == null',
    // A literal where a name goes.
    '"a" === x',
    '1 === x',
    'true === x',
    'null == x',
    'true',
    'false',
    'null',
    'undefined',
    '1',
    '"a"',
    'this',
    'this.x',
    // Number spellings the writer would change.
    'x === 010',
    'x === 0x10',
    'x === 1e3',
    'x === 1_000',
    'x === .5',
    'x === 5.',
    'x === 007',
    'x === 123456789012345678901234567890',
    'x === +1',
    'x === - 1',
    // Strings the writer cannot spell.
    'x === "a\\nb"',
    'x === "a\\"b"',
    "x === 'a\\'b'",
    'x === "unterminated',
    'x === "line\nbreak"',
    // Precedence the two-level model cannot draw.
    '(a || b) && c',
    'a && (b || c)',
    '(a || b) && (c || a)',
    'a && b && (c || a)',
    // Brackets that do not balance.
    '(a',
    'a)',
    '((a)',
    '()',
    '(a &&)',
    '&& a',
    'a ||',
    'a && || b',
    // Reserved words and noise.
    'if',
    'class',
    'typeof',
    'a b',
    'a b c',
    'a === "x" "y"',
    '#',
    '@a',
    'a ??= b',
    'é === 1',
    'a   b',
  ];
  for (const code of unsupported) {
    assert.equal(expression.readConditionExpression(code), undefined, `must stay code: ${JSON.stringify(code)}`);
  }
});

test('blank code is the empty model, and anything past a bound stays code', () => {
  assert.deepEqual(expression.readConditionExpression(''), { groups: [] });
  assert.deepEqual(expression.readConditionExpression('   \n  '), { groups: [] });
  const limits = expression.CONDITION_EXPRESSION_LIMITS;
  const names = (count, join) => Array.from({ length: count }, (_, index) => `n${index}`).join(join);
  // Groups: `a && b` runs joined by `||`.
  const groups = (count) => Array.from({ length: count }, (_, index) => `(g${index} && h${index})`).join(' || ');
  assert.equal(expression.readConditionExpression(groups(limits.groupsMax)).groups.length, limits.groupsMax);
  assert.equal(expression.readConditionExpression(groups(limits.groupsMax + 1)), undefined);
  // Conditions per group.
  assert.equal(expression.readConditionExpression(names(limits.conditionsPerGroupMax, ' && ')).groups[0].conditions.length, limits.conditionsPerGroupMax);
  assert.equal(expression.readConditionExpression(names(limits.conditionsPerGroupMax + 1, ' && ')), undefined);
  assert.equal(expression.readConditionExpression(names(limits.conditionsPerGroupMax + 1, ' || ')), undefined);
  // Parenthesis depth.
  const wrapped = (depth) => `${'('.repeat(depth)}a${')'.repeat(depth)}`;
  assert.notEqual(expression.readConditionExpression(wrapped(limits.parenthesesDepthMax)), undefined);
  assert.equal(expression.readConditionExpression(wrapped(limits.parenthesesDepthMax + 1)), undefined);
  // Tokens and text length.
  assert.equal(expression.readConditionExpression(`a${' && a'.repeat(limits.tokensMax)}`), undefined);
  assert.equal(expression.readConditionExpression(`x === "${'a'.repeat(limits.stringCharsMax + 1)}"`), undefined);
  assert.notEqual(expression.readConditionExpression(`x === "${'a'.repeat(limits.stringCharsMax)}"`), undefined);
  assert.equal(expression.readConditionExpression(`${'a'.repeat(1_000_000)}`), undefined);
});

test('a name a condition tests is one the writer can spell back', () => {
  for (const good of ['a', 'card.fluted', 'post.data.title', 'posts[0].title', 'post.data["campus-name"]', "post.data['campus-name']", 'items[2]', '_a$.b1']) {
    assert.equal(expression.isConditionSubject(good), true, good);
  }
  for (const bad of [
    '',
    'true',
    'null',
    'this',
    'a?.b',
    'a.',
    '.a',
    'a b',
    'a . b',
    'a()',
    'a.b()',
    'a[b]',
    'a[',
    'a[0',
    '1a',
    'a-b',
    'a + b',
    '"a"',
    'a, b',
    'x'.repeat(201),
  ]) {
    assert.equal(expression.isConditionSubject(bad), false, JSON.stringify(bad));
  }
});

test('writing asserts what it cannot write instead of writing something else', () => {
  assert.throws(() => expression.emitConditionExpression({ groups: [{ match: 'all', conditions: [] }] }, DOUBLE), /a group holds a condition/);
  assert.throws(() => expression.emitConditionExpression(only(isTrue('')), DOUBLE), /a condition names something/);
  assert.throws(() => expression.emitConditionExpression(only(equals('x', 'a\\b')), DOUBLE), /the literal can be written/);
  assert.throws(() => expression.emitConditionExpression(only(equals('x', `it's "both"`)), DOUBLE), /the literal can be written/);
  assert.throws(
    () => expression.emitConditionExpression(only({ subject: 'x', operator: 'equals', value: { kind: 'number', value: Number.NaN } }), DOUBLE),
    /the literal can be written/,
  );
  assert.throws(
    () => expression.emitConditionExpression(only({ subject: 'x', operator: 'equals', value: { kind: 'number', value: 1e21 } }), DOUBLE),
    /the literal can be written/,
  );
  const tooMany = { groups: Array.from({ length: expression.CONDITION_EXPRESSION_LIMITS.groupsMax + 1 }, () => ({ match: 'all', conditions: [isTrue('a')] })) };
  assert.throws(() => expression.emitConditionExpression(tooMany, DOUBLE), /the groups are bounded/);
  assert.equal(expression.isWritableLiteral({ kind: 'string', value: 'plain' }), true);
  assert.equal(expression.isWritableLiteral({ kind: 'string', value: 'a\nb' }), false);
  assert.equal(expression.isWritableLiteral({ kind: 'string', value: 'x'.repeat(201) }), false);
  assert.equal(expression.isWritableLiteral({ kind: 'number', value: -3.25 }), true);
  assert.equal(expression.isWritableLiteral({ kind: 'number', value: Infinity }), false);
});
