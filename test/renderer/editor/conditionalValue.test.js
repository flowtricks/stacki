// Goal: a conditional value is a model the app can trust, written as a plain
// Astro expression and read back only when the code says exactly what a model
// can say. Anything else stays code.
//
// Method: the pure modules, bundled as the app bundles them. The model parser
// is fed one known-good shape and then each known-bad shape (wrong kinds,
// missing parts, empty lists, duplicates, names that are not names) and every
// bound at and past its limit. Emitting and reading are checked as a round
// trip over multi-value comparisons, switches, bound values and an Else-only
// model, with Prettier asked whether it would change a byte of what is
// written. Then the negative space of reading: code an AI might write that the
// model cannot draw must come back undefined. Last, the catalog of props a
// condition can test, and the summary a conditional field shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const prettier = require('prettier');
const load = require('../../helpers/rendererModule');
const conditional = load('src/editor/conditionalValue.ts');
const model = load('src/features/props/conditionalModel.ts');

const text = (value) => ({ kind: 'text', text: value });
const reference = (path) => ({ kind: 'reference', path });
const string = (value) => ({ kind: 'string', value });
const isAny = (subject, ...values) => ({ kind: 'compare', subject, operator: 'in', values: values.map(string) });
const isNotAny = (subject, ...values) => ({ kind: 'compare', subject, operator: 'notIn', values: values.map(string) });
const truthy = (subject) => ({ kind: 'test', subject, operator: 'truthy' });
const falsy = (subject) => ({ kind: 'test', subject, operator: 'falsy' });
const group = (conditions, value, match = 'all') => ({ match, conditions, value });

const GOOD = {
  groups: [group([isAny('theme', 'dark'), isNotAny('paddingTop', 'small')], text('value1')), group([isAny('theme', 'light')], text('value2'))],
  otherwise: text('value3'),
};

test('the model parser accepts a known-good model as it is', () => {
  const parsed = conditional.parseConditionalValue(GOOD);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, GOOD);
  assert.deepEqual(conditional.parseConditionalValue({ groups: [], otherwise: reference('title') }), {
    ok: true,
    value: { groups: [], otherwise: reference('title') },
  });
});

test('the model parser rejects each known-bad shape with the part that is wrong', () => {
  const bad = [
    [undefined, /expected an object/],
    [[], /expected an object/],
    [{ otherwise: text('') }, /groups: expected an array/],
    [{ groups: [] }, /otherwise: expected an object/],
    [{ groups: [], otherwise: { kind: 'html', text: '' } }, /otherwise.kind/],
    [{ groups: [], otherwise: { kind: 'text', text: 3 } }, /otherwise.text/],
    [{ groups: [], otherwise: reference('a b') }, /otherwise.path/],
    [{ groups: [], otherwise: reference('true') }, /otherwise.path/],
    [{ groups: [], otherwise: reference('a.') }, /otherwise.path/],
    [{ groups: ['x'], otherwise: text('') }, /groups\[0\]: expected an object/],
    [{ groups: [{ ...group([truthy('a')], text('')), match: 'some' }], otherwise: text('') }, /match/],
    [{ groups: [group([], text(''))], otherwise: text('') }, /at least one condition/],
    [{ groups: [group([{ ...truthy('a'), kind: 'regex' }], text(''))], otherwise: text('') }, /kind: expected compare or test/],
    [{ groups: [group([{ ...truthy('a'), operator: 'in' }], text(''))], otherwise: text('') }, /expected truthy or falsy/],
    [{ groups: [group([{ ...isAny('a', 'x'), operator: 'truthy' }], text(''))], otherwise: text('') }, /expected in or notIn/],
    [{ groups: [group([{ ...isAny('a', 'x'), subject: 'a()' }], text(''))], otherwise: text('') }, /subject/],
    [{ groups: [group([{ ...isAny('a'), values: [] }], text(''))], otherwise: text('') }, /at least one value/],
    [{ groups: [group([isAny('a', 'x', 'x')], text(''))], otherwise: text('') }, /listed twice/],
    [{ groups: [group([{ ...isAny('a'), values: [{ kind: 'number', value: Number.NaN }] }], text(''))], otherwise: text('') }, /finite number/],
    [{ groups: [group([{ ...isAny('a'), values: [{ kind: 'bool', value: true }] }], text(''))], otherwise: text('') }, /string or number/],
    [{ groups: [group([truthy('a')], undefined)], otherwise: text('') }, /value: expected an object/],
  ];
  for (const [input, message] of bad) {
    const parsed = conditional.parseConditionalValue(input);
    assert.equal(parsed.ok, false, JSON.stringify(input));
    assert.match(parsed.error, message);
  }
});

test('the model parser holds every bound: at the limit it passes, past it it fails', () => {
  const { groupsMax, conditionsPerGroupMax, valuesPerConditionMax } = conditional.CONDITIONAL_LIMITS;
  assert.equal(groupsMax, 16);
  assert.equal(conditionsPerGroupMax, 16);
  const groups = (count) => ({ groups: Array.from({ length: count }, () => group([truthy('a')], text(''))), otherwise: text('') });
  assert.equal(conditional.parseConditionalValue(groups(groupsMax)).ok, true);
  assert.match(conditional.parseConditionalValue(groups(groupsMax + 1)).error, /more than 16/);
  const conditions = (count) => ({
    groups: [
      group(
        Array.from({ length: count }, () => truthy('a')),
        text(''),
      ),
    ],
    otherwise: text(''),
  });
  assert.equal(conditional.parseConditionalValue(conditions(conditionsPerGroupMax)).ok, true);
  assert.match(conditional.parseConditionalValue(conditions(conditionsPerGroupMax + 1)).error, /more than 16/);
  const values = (count) => ({ groups: [group([isAny('a', ...Array.from({ length: count }, (_, i) => `v${i}`))], text(''))], otherwise: text('') });
  assert.equal(conditional.parseConditionalValue(values(valuesPerConditionMax)).ok, true);
  assert.match(conditional.parseConditionalValue(values(valuesPerConditionMax + 1)).error, /more than 32/);
  assert.match(conditional.parseConditionalValue({ groups: [], otherwise: text('x'.repeat(8_193)) }).error, /exceeds/);
  assert.equal(conditional.parseConditionalValue({ groups: [], otherwise: reference('a'.repeat(201)) }).ok, false);
});

const ROUND_TRIPS = [
  ['two groups, an and and a negation', GOOD, "theme === 'dark' && paddingTop !== 'small' ? 'value1' : theme === 'light' ? 'value2' : 'value3'"],
  [
    'multi-value is any and is not any',
    { groups: [group([isAny('theme', 'dark', 'light')], text('a')), group([isNotAny('size', 'sm', 'md')], text('b'))], otherwise: text('c') },
    "['dark', 'light'].includes(theme) ? 'a' : !['sm', 'md'].includes(size) ? 'b' : 'c'",
  ],
  [
    'a switch, on and off',
    { groups: [group([truthy('shown')], text('on')), group([falsy('dimmed')], text('lit'))], otherwise: text('') },
    "shown ? 'on' : !dimmed ? 'lit' : ''",
  ],
  ['any of a group', { groups: [group([truthy('a'), isAny('b', 'x')], text('y'), 'any')], otherwise: text('z') }, "a || b === 'x' ? 'y' : 'z'"],
  [
    'bound values',
    { groups: [group([isAny('variant', 'link')], reference('href'))], otherwise: reference('post.data.url') },
    "variant === 'link' ? href : post.data.url",
  ],
  [
    'numbers and quoting',
    {
      groups: [group([{ kind: 'compare', subject: 'count', operator: 'in', values: [{ kind: 'number', value: 3 }] }], text("it's \\ 3\n"))],
      otherwise: text(''),
    },
    "count === 3 ? \"it's \\\\ 3\\n\" : ''",
  ],
  ['quotes of both kinds', { groups: [group([isAny('a', 'say "hi"')], text("it's"))], otherwise: text('') }, "a === 'say \"hi\"' ? \"it's\" : ''"],
];

test('a model is written as plain Astro and read back as the same model; Prettier leaves it alone', async () => {
  for (const [name, value, code] of ROUND_TRIPS) {
    assert.equal(conditional.emitConditionalExpression(value), code, name);
    assert.deepEqual(conditional.readConditionalExpression(code), value, name);
    const formatted = await prettier.format(`(${code});\n`, { parser: 'babel', singleQuote: true, printWidth: 160 });
    assert.equal(formatted, `${code};\n`, `${name}: Prettier changes nothing`);
  }
});

test('an Else-only model is the field’s plain value, which is not a conditional', () => {
  assert.deepEqual(conditional.conditionalAttr({ groups: [], otherwise: text('hello') }), { type: 'string', value: 'hello' });
  assert.deepEqual(conditional.conditionalAttr({ groups: [], otherwise: text('') }), { type: 'bare' });
  assert.deepEqual(conditional.conditionalAttr({ groups: [], otherwise: reference('title') }), { type: 'expr', value: 'title' });
  assert.equal(conditional.emitConditionalExpression({ groups: [], otherwise: reference('title') }), 'title');
  assert.equal(conditional.readConditionalExpression('title'), undefined, 'a value with no condition is not conditional');
  assert.equal(conditional.readConditionalExpression("'hello'"), undefined);
  assert.deepEqual(conditional.conditionalAttr(GOOD), { type: 'expr', value: conditional.emitConditionalExpression(GOOD) });
});

test('what carries no meaning is read through: spacing, line breaks, double quotes, parentheses', () => {
  const formatted = "(theme === \"dark\" && (paddingTop !== 'small'))\n  ? 'value1'\n  : theme === 'light'\n    ? 'value2'\n    : 'value3'";
  assert.deepEqual(conditional.readConditionalExpression(formatted), GOOD);
  assert.deepEqual(conditional.readConditionalExpression("['dark',].includes(theme) ? 'a' : 'b'"), {
    groups: [group([isAny('theme', 'dark')], text('a'))],
    otherwise: text('b'),
  });
});

test('code the model cannot draw stays code', () => {
  const unsupported = [
    "a ? b ? 'c' : 'd' : 'e'", // A ternary in a branch.
    "a && b || c ? 'x' : 'y'", // Precedence the groups cannot show.
    "f(a) ? 'x' : 'y'", // A call.
    "a ? `x\\n${b}` : 'y'", // An escape in a template.
    "a ? true : 'x'", // A keyword is not a prop.
    "a.b() ? 'x' : 'y'",
    "items[0] ? 'x' : 'y'",
    "a == 'x' ? 'y' : 'z'", // Loose equality is another operator.
    "a > 1 ? 'y' : 'z'",
    "!!a ? 'y' : 'z'",
    "['x'].includes(a, 1) ? 'y' : 'z'",
    "['x', 'x'].includes(a) ? 'y' : 'z'",
    "a ? 'y' : 'z' // why",
    "a ? 'y' : 'z';",
    "(a ? 'y' : 'z')",
    "a ? 'y' :",
    "'x' === a ? 'y' : 'z'",
    "a ? 'unterminated : 'z'",
    "a ? '\\x41' : 'z'",
  ];
  for (const code of unsupported) {
    assert.equal(conditional.readConditionalExpression(code), undefined, code);
  }
  const deep = `${"a ? 'x' : ".repeat(17)}'z'`;
  assert.equal(conditional.readConditionalExpression(deep), undefined, 'more groups than the bound');
  assert.equal(conditional.readConditionalExpression(`${"a ? 'x' : ".repeat(16)}'z'`)?.groups.length, 16, 'exactly the bound reads');
});

test('the catalog lists the props a condition can test, by the name the markup reads', () => {
  const frontmatter = "const { theme = 'dark', paddingTop: top, shown, items, label } = Astro.props;";
  const catalog = model.conditionProps(frontmatter, [
    { name: 'theme', type: 'enum', options: ['dark', 'light'] },
    { name: 'paddingTop', type: 'enum', options: ['small', 'large'] },
    { name: 'shown', type: 'boolean' },
    { name: 'items', type: 'code' },
    { name: 'label', type: 'string' },
    { name: 'count', type: 'number' },
  ]);
  assert.deepEqual(
    catalog.map((prop) => [prop.name, prop.label, prop.kind, prop.options]),
    [
      ['theme', 'Theme', 'option', ['dark', 'light']],
      ['top', 'Top', 'option', ['small', 'large']],
      ['shown', 'Shown', 'switch', []],
      ['label', 'Label', 'text', []],
      ['count', 'Count', 'number', []],
    ],
  );
  assert.deepEqual(
    model.operatorsFor('switch').map((option) => option.label),
    ['is true', 'is false'],
  );
  assert.deepEqual(
    model.operatorsFor('option').map((option) => option.label),
    ['is any', 'is not any', 'is set', 'is empty'],
  );
});

test('the summary reads as the field shows it', () => {
  const catalog = model.conditionProps('const { theme, paddingTop, shown } = Astro.props;', [
    { name: 'theme', type: 'enum', options: ['dark', 'light'] },
    { name: 'paddingTop', type: 'enum', options: ['small'] },
    { name: 'shown', type: 'boolean' },
  ]);
  assert.deepEqual(model.summaryLines(GOOD, catalog), [
    { heading: 'If all are true', bullets: ['Theme = Dark', 'Padding Top ≠ Small'], value: text('value1') },
    { heading: 'If Theme = Light', bullets: [], value: text('value2') },
    { heading: 'Else', bullets: [], value: text('value3') },
  ]);
  assert.equal(model.conditionWords(truthy('shown'), catalog), 'Shown is true');
  assert.equal(model.conditionWords(falsy('label'), catalog), 'Label is empty', 'a name the catalog does not hold reads as text');
  assert.equal(model.conditionWords(isAny('theme', 'dark', 'light'), catalog), 'Theme is any of Dark, Light');
});

test('a draft applies only what was finished, and writes nothing when nothing changed', () => {
  const catalog = model.conditionProps('const { theme } = Astro.props;', [{ name: 'theme', type: 'enum', options: ['dark'] }]);
  const start = model.startingConditional({ type: 'string', value: 'plain' }, catalog);
  assert.deepEqual(start.otherwise, text('plain'), 'the Else starts as what the field holds');
  assert.equal(start.groups[0].conditions[0].subject, 'theme');
  assert.deepEqual(model.appliedAttr(start, { type: 'string', value: 'plain' }), { kind: 'unchanged' }, 'an unfinished condition writes nothing');
  const chosen = model.withGroup(start, 0, (current) => ({
    ...model.withCondition(current, 0, model.withValueAdded(current.conditions[0], string('dark'))),
    value: text('night'),
  }));
  assert.deepEqual(model.appliedAttr(chosen, { type: 'string', value: 'plain' }), {
    kind: 'write',
    value: { type: 'expr', value: "theme === 'dark' ? 'night' : 'plain'" },
  });
  assert.equal(model.startingConditional({ type: 'expr', value: 'name.trim()' }, catalog), undefined, 'code a branch cannot hold is not offered');
  assert.deepEqual(
    model.startingConditional({ type: 'expr', value: '`Hi ${name}`' }, catalog).otherwise,
    {
      kind: 'template',
      parts: [
        { kind: 'text', text: 'Hi ' },
        { kind: 'reference', path: 'name' },
      ],
    },
    'a template is a branch value',
  );
  assert.equal(model.startingConditional(undefined, catalog).otherwise.kind, 'none', 'no attribute starts as left out');
  assert.throws(() => model.withGroupRemoved(start, 3), /the group exists/);
  assert.throws(() => model.withConditionRemoved(start.groups[0], -1), /never negative/);
});

test('the style that is set only when a prop is: read, summarised and written back byte for byte', async () => {
  const code = 'maxWidth ? `--_mw: ${maxWidth}ch;` : undefined';
  const read = conditional.readConditionalExpression(code);
  assert.deepEqual(read, {
    groups: [
      {
        match: 'all',
        conditions: [truthy('maxWidth')],
        value: {
          kind: 'template',
          parts: [
            { kind: 'text', text: '--_mw: ' },
            { kind: 'reference', path: 'maxWidth' },
            { kind: 'text', text: 'ch;' },
          ],
        },
      },
    ],
    otherwise: { kind: 'none', word: 'undefined' },
  });
  assert.equal(conditional.emitConditionalExpression(read), code);
  const catalog = model.conditionProps('const { maxWidth } = Astro.props;', [{ name: 'maxWidth', type: 'number' }]);
  assert.equal(model.summaryLines(read, catalog)[0].heading, 'If Max Width is set', 'a bare test is "is set"');
  assert.equal(model.conditionWords(falsy('maxWidth'), catalog), 'Max Width is empty');
  assert.equal(await prettier.format(`(${code});\n`, { parser: 'babel', singleQuote: true, printWidth: 160 }), `${code};\n`);
});

test('templates: holes with member paths read, `null` is kept, and anything escaped or nested stays code', () => {
  assert.equal(
    conditional.emitConditionalExpression(conditional.readConditionalExpression('a ? `x ${post.data.title} y` : null')),
    'a ? `x ${post.data.title} y` : null',
  );
  assert.equal(conditional.emitConditionalExpression(conditional.readConditionalExpression('a ? `${b}${c}` : ``')), 'a ? `${b}${c}` : ``');
  for (const code of [
    'a ? `\\`` : 1',
    'a ? `\\n` : "x"',
    'a ? `${f()}` : "x"',
    'a ? `${b[0]}` : "x"',
    'a ? `${`x`}` : "x"',
    'a ? `${b ? c : d}` : "x"',
    'a ? `unterminated : "x"',
  ]) {
    assert.equal(conditional.readConditionalExpression(code), undefined, code);
  }
  assert.equal(
    conditional.parseConditionalValue({ groups: [], otherwise: { kind: 'template', parts: [{ kind: 'text', text: 'a`b' }] } }).ok,
    false,
    'a backtick is code',
  );
  assert.equal(conditional.parseConditionalValue({ groups: [], otherwise: { kind: 'none', word: 'nothing' } }).ok, false);
});

test('code is written in the quote the file uses', async () => {
  assert.equal(conditional.quoteOf('const a = "x";'), '"');
  assert.equal(conditional.quoteOf('const a = 1;'), undefined);
  const written = conditional.emitConditionalExpression(GOOD, { quote: '"' });
  assert.equal(written, 'theme === "dark" && paddingTop !== "small" ? "value1" : theme === "light" ? "value2" : "value3"');
  assert.equal(
    await prettier.format(`(${written});\n`, { parser: 'babel', printWidth: 160 }),
    `${written};\n`,
    'Prettier with its default quotes changes nothing',
  );
});

const CLASS_LIST = '["heading", variant !== "inherit" && `text-style-${variant}`, className]';

test('a class list: read, written back as Prettier leaves it, and bounded', async () => {
  const read = conditional.readClassListExpression(CLASS_LIST);
  assert.deepEqual(read, {
    entries: [
      { value: text('heading'), match: 'all', when: [] },
      {
        value: {
          kind: 'template',
          parts: [
            { kind: 'text', text: 'text-style-' },
            { kind: 'reference', path: 'variant' },
          ],
        },
        match: 'all',
        when: [isNotAny('variant', 'inherit')],
      },
      { value: reference('className'), match: 'all', when: [] },
    ],
  });
  assert.equal(conditional.emitClassListExpression(read, { quote: '"' }), CLASS_LIST);
  const any = '[(a || b === "x") && "both", shown && !dimmed && "lit"]';
  assert.equal(conditional.emitClassListExpression(conditional.readClassListExpression(any), { quote: '"' }), any);
  for (const code of [CLASS_LIST, any]) {
    assert.equal(await prettier.format(`(${code});\n`, { parser: 'babel', printWidth: 160 }), `${code};\n`, code);
  }
  for (const code of ['["a", { b: c }]', '[...rest]', '["a", ["b"]]', '[cn("a")]', '[a || "b"]', '[a && b || "c"]', '[undefined]', '"a"', '[a, ]extra']) {
    assert.equal(conditional.readClassListExpression(code), undefined, code);
  }
  const many = `[${Array.from({ length: 33 }, (_, i) => `"c${i}"`).join(', ')}]`;
  assert.equal(conditional.readClassListExpression(many), undefined, 'more entries than the bound');
  const bad = [
    [{}, /entries: expected an array/],
    [{ entries: [{ value: text('a'), match: 'some', when: [] }] }, /match/],
    [{ entries: [{ value: { kind: 'none', word: 'undefined' }, match: 'all', when: [] }] }, /never no value/],
    [{ entries: [{ value: text('a'), match: 'all', when: 'x' }] }, /when: expected an array/],
  ];
  for (const [input, message] of bad) {
    const parsed = conditional.parseClassListValue(input);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, message);
  }
});
