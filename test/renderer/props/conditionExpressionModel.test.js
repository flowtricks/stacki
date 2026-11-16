// Goal: the pure rules under the template condition editor: which view an
// expression opens in and when the switch back is refused, which operators a
// kind of value offers, how typed values become literals (and when they are
// not values yet), and that a draft writes only its finished rows.
//
// Method: the pure modules, bundled as the app bundles them, fed tables of
// inputs including the invalid ones: half-chosen rows, words where a number
// belongs, blank code, unreadable code, and code that must never be cleared.

const assert = require('node:assert/strict');
const test = require('node:test');
const load = require('../../helpers/rendererModule');
const decision = load('src/features/props/conditionViewDecision.ts');
const model = load('src/features/props/conditionExpressionModel.ts');
const expression = load('src/editor/conditionExpression.ts');

const readable = (source) => expression.readConditionExpression(source) !== undefined;

test('code the controls cannot draw opens as code and refuses the way back', () => {
  assert.deepEqual(decision.decideConditionView({ source: 'a && b', readable, chosen: undefined }), {
    view: 'visual',
    note: undefined,
    visualRefusal: undefined,
  });
  assert.equal(decision.decideConditionView({ source: 'a && b', readable, chosen: 'code' }).view, 'code', 'a chosen code view stays code');
  assert.equal(decision.decideConditionView({ source: '', readable, chosen: undefined }).view, 'visual', 'a node with no test yet starts on the controls');
  for (const source of ['a ? b : c', 'f(x)', 'x?.y', '(a || b) && c']) {
    for (const chosen of [undefined, 'visual', 'code']) {
      assert.deepEqual(decision.decideConditionView({ source, readable, chosen }), { view: 'code', note: 'complex', visualRefusal: 'complex' }, source);
    }
  }
});

test('closing on code writes it only when it is new, and blank code never clears a field', () => {
  const before = { type: 'expr', value: 'a ? b : c' };
  assert.deepEqual(decision.appliedCode('a ? b : c ', before), { kind: 'unchanged' });
  assert.deepEqual(decision.appliedCode('', before), { kind: 'unchanged' });
  assert.deepEqual(decision.appliedCode('  ', undefined), { kind: 'unchanged' });
  assert.deepEqual(decision.appliedCode('x ? y : z', before), { kind: 'write', value: { type: 'expr', value: 'x ? y : z' } });
  assert.deepEqual(decision.appliedCode('x', { type: 'string', value: 'x' }), { kind: 'write', value: { type: 'expr', value: 'x' } });
});

test('each kind offers the operators that fit it, and keeps one the code already uses', () => {
  const values = (kind, keep) => model.operatorsFor(kind, keep).map((option) => option.value);
  assert.deepEqual(values('boolean'), ['isTrue', 'isFalse']);
  assert.ok(values('number').includes('greaterThan'));
  assert.ok(!values('boolean').includes('greaterThan'));
  assert.ok(values('array').includes('contains'));
  assert.equal(values('unknown').length, expression.EXPRESSION_OPERATORS.length, 'unknown offers everything: typed by hand');
  assert.deepEqual(values('boolean', 'equals').slice(-1), ['equals'], 'the code keeps its operator');
  assert.equal(model.operatorsFor('string', undefined).find((option) => option.value === 'notEquals') === undefined, false);
  assert.equal(model.operatorsFor('number', undefined).find((option) => option.value === 'greaterThan').label, 'is greater than');
});

test('typed values become literals only when they are values', () => {
  const lit = model.literalOfText;
  assert.deepEqual(lit('string', 'equals', ' a '), { kind: 'string', value: 'a' });
  assert.equal(lit('string', 'equals', ''), undefined);
  assert.equal(lit('string', 'equals', 'a\\b'), undefined, 'a backslash cannot be written');
  assert.equal(lit('string', 'equals', `it's "both"`), undefined);
  assert.deepEqual(lit('number', 'equals', '-2.5'), { kind: 'number', value: -2.5 });
  for (const bad of ['abc', '1e5', '0x1', '1,5', '1.', '.5', '--1', 'Infinity', 'NaN', '01']) {
    assert.equal(lit('number', 'greaterThan', bad), undefined, bad);
  }
  assert.deepEqual(lit('unknown', 'equals', '5'), { kind: 'number', value: 5 });
  assert.deepEqual(lit('unknown', 'equals', 'true'), { kind: 'boolean', value: true });
  assert.deepEqual(lit('unknown', 'equals', '"5"'), { kind: 'string', value: '5' });
  assert.deepEqual(lit('unknown', 'equals', 'dark'), { kind: 'string', value: 'dark' });
  assert.equal(model.textOfLiteral('unknown', { kind: 'string', value: '5' }), '"5"', 'words that read as a number are quoted back');
  assert.equal(model.textOfLiteral('string', { kind: 'string', value: '5' }), '5');
  assert.equal(model.textOfLiteral('unknown', { kind: 'boolean', value: false }), 'false');
});

test('a draft writes its finished rows and drops the rest', () => {
  const typeOf = () => ({ kind: 'unknown', options: [] });
  const finished = { subject: 'a', operator: 'isTrue', text: '' };
  const noName = model.blankRow();
  const noValue = { subject: 'b', operator: 'equals', text: '' };
  const badName = { subject: 'a b', operator: 'isTrue', text: '' };
  const draft = {
    groups: [
      { match: 'all', conditions: [finished, noName, noValue, badName] },
      { match: 'any', conditions: [noName] },
    ],
  };
  assert.deepEqual(model.expressionOfDraft(draft, typeOf), { groups: [{ match: 'all', conditions: [{ subject: 'a', operator: 'isTrue' }] }] });
  assert.deepEqual(model.expressionOfDraft({ groups: [{ match: 'all', conditions: [noName] }] }, typeOf), { groups: [] });
  // A model opens as a draft and writes back as itself.
  const read = expression.readConditionExpression('a || (b === "x" && c > 1)');
  assert.deepEqual(model.expressionOfDraft(model.draftOfExpression(read, typeOf), typeOf), read);
  assert.equal(model.draftOfExpression({ groups: [] }, typeOf).groups[0].conditions.length, 1, 'there is always a row to start from');
});

test('rows and groups change without ever leaving the editor empty or past its bounds', () => {
  const start = { groups: [{ match: 'all', conditions: [model.blankRow()] }] };
  assert.equal(model.withGroupRemoved(start, 0).groups.length, 1, 'removing the only group leaves a fresh one');
  let grown = start;
  for (let round = 0; round < 40; round += 1) {
    grown = model.withGroupAdded(grown);
  }
  assert.equal(grown.groups.length, expression.CONDITION_EXPRESSION_LIMITS.groupsMax);
  let group = start.groups[0];
  for (let round = 0; round < 40; round += 1) {
    group = model.withRowAdded(group);
  }
  assert.equal(group.conditions.length, expression.CONDITION_EXPRESSION_LIMITS.conditionsPerGroupMax);
  assert.throws(() => model.withGroupRemoved(start, 3), /the group exists/);
  assert.throws(() => model.withRow(start.groups[0], -1, model.blankRow()), /the index is not negative/);
  assert.throws(() => model.withRowRemoved(start.groups[0], 5), /the row exists/);
  const boolean = { kind: 'boolean', options: [] };
  assert.deepEqual(
    model.rowWithSubject({ subject: 'a', operator: 'greaterThan', text: '3' }, 'flag', boolean),
    { subject: 'flag', operator: 'isTrue', text: '' },
    'an operator the new name lacks starts over',
  );
  assert.equal(model.rowWithSubject({ subject: 'a', operator: 'isFalse', text: '' }, 'flag', boolean).operator, 'isFalse', 'one it offers is kept');
});

test('a name is typed from the same data the picker shows', () => {
  const context = {
    frontmatter: 'const { count, open, title, tags } = Astro.props;',
    propsSchema: [
      { name: 'count', type: 'number' },
      { name: 'open', type: 'boolean' },
      { name: 'title', type: 'string' },
      { name: 'mode', type: 'enum', options: ['a', 'b'] },
    ],
  };
  assert.equal(model.valueTypeOf(context, 'count').kind, 'number');
  assert.equal(model.valueTypeOf(context, 'open').kind, 'boolean');
  assert.equal(model.valueTypeOf(context, 'title').kind, 'string');
  assert.equal(model.valueTypeOf(context, 'nothingHere').kind, 'unknown');
  assert.equal(model.valueTypeOf(undefined, 'count').kind, 'unknown');
});

test('each kind offers only the operators that make sense for it, and a plain test reads as the owner of the code reads it', () => {
  const values = (kind, keep) => model.operatorsFor(kind, keep).map((option) => option.value);
  const label = (kind, operator, keep) => model.operatorsFor(kind, keep ?? operator).find((option) => option.value === operator)?.label;
  const table = {
    boolean: { yes: ['isTrue', 'isFalse'], no: ['equals', 'contains', 'isEmpty', 'isNotEmpty', 'greaterThan', 'startsWith', 'isSet'] },
    string: {
      yes: ['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty', 'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith'],
      no: ['greaterThan', 'lessThan', 'atLeast', 'atMost', 'lengthEquals', 'isSet'],
    },
    enum: { yes: ['isTrue', 'isFalse', 'equals', 'notEquals'], no: ['contains', 'isEmpty', 'greaterThan', 'startsWith'] },
    number: {
      yes: ['equals', 'notEquals', 'greaterThan', 'atLeast', 'lessThan', 'atMost', 'isSet', 'isNotSet'],
      no: ['contains', 'isEmpty', 'isNotEmpty', 'startsWith', 'notContains', 'isTrue'],
    },
    array: {
      yes: ['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty', 'contains', 'notContains', 'lengthEquals', 'lengthGreaterThan'],
      no: ['equals', 'notEquals', 'greaterThan', 'startsWith'],
    },
    object: { yes: ['isTrue', 'isFalse'], no: ['equals', 'contains', 'isEmpty', 'greaterThan', 'isSet'] },
    date: { yes: ['isTrue', 'isFalse'], no: ['equals', 'contains', 'isEmpty'] },
  };
  for (const [kind, { yes, no }] of Object.entries(table)) {
    assert.deepEqual(values(kind), yes, `${kind} offers exactly these`);
    for (const absent of no) {
      assert.ok(!values(kind).includes(absent), `${kind} must not offer ${absent}`);
    }
  }
  // Unknown: everything, said by nobody.
  assert.equal(values('unknown').length, expression.EXPRESSION_OPERATORS.length);
  // The plain test: "is true" on a switch or an unknown, "is set" on everything else.
  assert.equal(label('boolean', 'isTrue'), 'is true');
  assert.equal(label('unknown', 'isTrue'), 'is true');
  for (const kind of ['string', 'enum', 'array', 'object', 'date']) {
    assert.equal(label(kind, 'isTrue'), 'is set', kind);
    assert.equal(label(kind, 'isFalse'), 'is not set', kind);
  }
  // A number tested for truthiness (`count`) reads "is set" in place of the null test's, and writes back unchanged.
  assert.deepEqual(values('number', 'isTrue'), ['equals', 'notEquals', 'greaterThan', 'atLeast', 'lessThan', 'atMost', 'isTrue', 'isFalse']);
  assert.equal(label('number', 'isTrue'), 'is set');
  // Code that tests `!= null` on a text keeps its operator, told apart from the plain test.
  assert.equal(label('string', 'isSet'), 'is not null');
  assert.equal(label('string', 'isNotSet'), 'is null');
  assert.equal(label('boolean', 'isSet'), 'is set', 'a switch has no plain "set", so the null test says it');
  // Defaults match what a bare name would be.
  assert.equal(model.defaultOperator('boolean'), 'isTrue');
  assert.equal(model.defaultOperator('string'), 'isTrue');
  assert.equal(model.defaultOperator('number'), 'isSet');
  assert.equal(model.defaultOperator('unknown'), 'isTrue');
  // `card.fluted &&` on an optional text reads back as "is set" and writes the same code.
  const read = expression.readConditionExpression('card.fluted');
  const draft = model.draftOfExpression(read, () => ({ kind: 'enum', options: ['home-platform'] }));
  assert.equal(draft.groups[0].conditions[0].operator, 'isTrue');
  assert.equal(
    expression.emitConditionExpression(
      model.expressionOfDraft(draft, () => ({ kind: 'enum', options: [] })),
      { quote: '"' },
    ),
    'card.fluted',
  );
  // Starts-with and length values are typed as they are used.
  assert.deepEqual(model.literalOfText('string', 'startsWith', 'ab'), { kind: 'string', value: 'ab' });
  assert.deepEqual(model.literalOfText('array', 'lengthGreaterThan', '3'), { kind: 'number', value: 3 });
  for (const bad of ['-1', '1.5', 'x', '01']) {
    assert.equal(model.literalOfText('array', 'lengthEquals', bad), undefined, bad);
  }
});
