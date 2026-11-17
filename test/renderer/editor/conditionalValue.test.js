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
//
// The rich reading (an attribute's value) is held the same way: one round
// trip per shape an author writes (a ternary with no value in a branch, `??`,
// a table entry picked by a prop, nested ternaries, `&&` and `||` mixed,
// parenthesised groups, templates, numbers), each written back byte for byte
// and left alone by Prettier; then what each shape means, and the code that
// still cannot be read, which is Computed.

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
    [{ groups: [group([{ ...truthy('a'), kind: 'regex' }], text(''))], otherwise: text('') }, /kind: expected compare, test or code/],
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
  // There is no text size limit any more (a805ae62): a long branch is a valid one.
  assert.equal(conditional.parseConditionalValue({ groups: [], otherwise: text('x'.repeat(8_193)) }).ok, true);
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
  assert.deepEqual(start.groups[0].value, text('plain'), 'a new conditional gives what the field holds first');
  assert.deepEqual(start.otherwise, { kind: 'none', word: 'undefined' }, 'and leaves it out otherwise');
  assert.equal(start.groups[0].conditions[0].subject, 'theme');
  assert.deepEqual(model.appliedStart(start, { type: 'string', value: 'plain' }), { kind: 'unchanged' }, 'an unfinished condition writes nothing');
  const chosen = model.withGroup(start, 0, (current) => ({
    ...model.withCondition(current, 0, model.withValueAdded(current.conditions[0], string('dark'))),
    value: text('night'),
  }));
  assert.deepEqual(model.appliedStart(chosen, { type: 'string', value: 'plain' }), {
    kind: 'write',
    value: { type: 'expr', value: "theme === 'dark' ? 'night' : undefined" },
  });
  assert.deepEqual(
    model.startingConditional({ type: 'expr', value: 'name.trim()' }, catalog).groups[0].value,
    { kind: 'computed', code: 'name.trim()' },
    'an attribute’s code starts as a locked value',
  );
  assert.equal(model.resultOfAttr({ type: 'expr', value: 'name.trim()' }), undefined, 'the plain reading still does not take code');
  assert.deepEqual(
    model.startingConditional({ type: 'expr', value: '`Hi ${name}`' }, catalog).groups[0].value,
    {
      kind: 'template',
      parts: [
        { kind: 'text', text: 'Hi ' },
        { kind: 'reference', path: 'name' },
      ],
    },
    'a template is a branch value',
  );
  assert.equal(model.startingConditional(undefined, catalog).groups[0].value.kind, 'none', 'no attribute starts as left out');
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

test('a style attribute starts a conditional from its declarations and writes it back as style={...} code', () => {
  const catalog = model.conditionProps('const { maxWidth } = Astro.props;', [{ name: 'maxWidth', type: 'number' }]);
  const before = { type: 'string', value: 'color: red;' };
  const start = model.startingConditional(before, catalog);
  assert.notEqual(start, undefined, 'declarations start a conditional');
  assert.equal(model.valueLanguageOf('style'), 'css');
  const draft = { groups: [{ match: 'all', conditions: [truthy('maxWidth')], value: text('width: 10ch;') }], otherwise: start.otherwise };
  const applied = model.appliedAttr(draft, before);
  assert.equal(applied.kind, 'write');
  assert.equal(applied.value.type, 'expr', 'a conditional is an expression attribute');
  assert.equal(applied.value.value, "maxWidth ? 'width: 10ch;' : undefined");
  const reread = model.conditionalOfAttr(applied.value);
  assert.notEqual(reread, undefined, 'the written code reads back as a conditional');
  assert.equal(model.appliedAttr(model.draftOf(reread), applied.value).kind, 'unchanged', 'writing it again changes nothing');
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
  for (const code of ['[...rest]', '[undefined]', '"a"', '[a, ]extra', '[a && ]', '[,]']) {
    assert.equal(conditional.readClassListExpression(code), undefined, code);
  }
  // What a class cannot be drawn as is kept as locked code, the rest of the list stays editable.
  assert.deepEqual(conditional.readClassListExpression('["a", { b: c }]').entries[1].value, { kind: 'computed', code: '{ b: c }' });
  assert.deepEqual(conditional.readClassListExpression('[cn("a")]').entries[0].value, { kind: 'computed', code: 'cn("a")' });
  assert.deepEqual(conditional.readClassListExpression('[a || "b"]').entries[0].value, {
    kind: 'fallback',
    operator: '||',
    operands: [reference('a'), text('b')],
  });
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

// Each shape an attribute holds in the corpus (docs/props-complex-shapes.md),
// as Prettier writes it. Read richly, each is a model; written back, each is
// the same bytes; the plain reading refuses each (its writers cannot write them).
const RICH = (path) => ({ path, kind: 'reference' });
const RICH_ROUND_TRIPS = [
  [
    'a ternary with no value, then the first set of a prop and a table entry',
    'isWritten ? undefined : (label ?? named[variant])',
    {
      groups: [group([truthy('isWritten')], { kind: 'none', word: 'undefined' })],
      otherwise: { kind: 'fallback', operator: '??', operands: [RICH('label'), { kind: 'lookup', table: 'named', key: 'variant' }] },
    },
  ],
  [
    'a fallback in a branch',
    'as === "button" ? (type ?? "button") : undefined',
    {
      groups: [group([isAny('as', 'button')], { kind: 'fallback', operator: '??', operands: [RICH('type'), text('button')] })],
      otherwise: { kind: 'none', word: 'undefined' },
    },
  ],
  [
    'numbers in branches',
    'i === 0 ? 0 : -1',
    {
      groups: [group([{ kind: 'compare', subject: 'i', operator: 'in', values: [{ kind: 'number', value: 0 }] }], { kind: 'computed', code: '0' })],
      otherwise: { kind: 'computed', code: '-1' },
    },
  ],
  [
    'a test the rows cannot show',
    'index >= PAGE_SIZE ? "display:none" : undefined',
    { groups: [group([{ kind: 'code', code: 'index >= PAGE_SIZE' }], text('display:none'))], otherwise: { kind: 'none', word: 'undefined' } },
  ],
  [
    '&& inside ||, parenthesised as Prettier does',
    '(a && b) || c ? "x" : "y"',
    { groups: [group([{ kind: 'code', code: 'a && b' }, truthy('c')], text('x'), 'any')], otherwise: text('y') },
  ],
  ['|| inside &&', '(a || b) && c ? "x" : "y"', { groups: [group([{ kind: 'code', code: 'a || b' }, truthy('c')], text('x'))], otherwise: text('y') }],
  [
    'a fallback on its own',
    'required || undefined',
    { groups: [], otherwise: { kind: 'fallback', operator: '||', operands: [RICH('required'), { kind: 'none', word: 'undefined' }] } },
  ],
  [
    'a call in a branch and a fallback with code in it',
    'item.fields.publishDate ? String(item.fields.publishDate) : (item.publishedAt ?? undefined)',
    {
      groups: [group([truthy('item.fields.publishDate')], { kind: 'computed', code: 'String(item.fields.publishDate)' })],
      otherwise: { kind: 'fallback', operator: '??', operands: [RICH('item.publishedAt'), { kind: 'none', word: 'undefined' }] },
    },
  ],
  [
    'a template with code in a hole',
    'theme ? `cc-${card.tone ?? "blue"}` : undefined',
    { groups: [group([truthy('theme')], { kind: 'computed', code: '`cc-${card.tone ?? "blue"}`' })], otherwise: { kind: 'none', word: 'undefined' } },
  ],
  [
    'optional chaining in a test',
    'option.id === selected?.id ? 0 : -1',
    { groups: [group([{ kind: 'code', code: 'option.id === selected?.id' }], { kind: 'computed', code: '0' })], otherwise: { kind: 'computed', code: '-1' } },
  ],
];

test('every shape an attribute holds reads richly, writes back byte for byte, and Prettier leaves it alone', async () => {
  for (const [name, code, expected] of RICH_ROUND_TRIPS) {
    const read = conditional.readConditionalExpression(code, { shapes: 'rich' });
    assert.deepEqual(read, expected, name);
    assert.equal(conditional.emitConditionalExpression(read, { quote: '"' }), code, `${name}: written back as it was`);
    assert.equal(conditional.readConditionalExpression(code), undefined, `${name}: the plain reading refuses it`);
    assert.equal(await prettier.format(`(${code});\n`, { parser: 'babel', printWidth: 160 }), `${code};\n`, `${name}: Prettier changes nothing`);
  }
});

test('a ternary in a branch is flattened into groups that mean the same', () => {
  const read = conditional.readConditionalExpression('a ? (b ? "c" : "d") : "e"', { shapes: 'rich' });
  assert.deepEqual(read, {
    groups: [group([truthy('a'), truthy('b')], text('c')), group([truthy('a')], text('d'))],
    otherwise: text('e'),
  });
  // What each reads as for every combination: the first group that holds gives the value.
  const evaluate = (model, scope) => {
    const holds = (condition) => Boolean(scope[condition.subject]) === (condition.operator === 'truthy');
    const found = model.groups.find((candidate) => candidate.conditions.every(holds));
    return (found ?? { value: model.otherwise }).value.text;
  };
  for (const left of [true, false]) {
    for (const right of [true, false]) {
      assert.equal(evaluate(read, { a: left, b: right }), left ? (right ? 'c' : 'd') : 'e', `a=${left} b=${right}`);
    }
  }
  assert.equal(conditional.readConditionalExpression("a ? b ? 'c' : 'd' : 'e'"), undefined, 'the plain reading refuses a flattened chain');
  const anyOuter = conditional.readConditionalExpression('a || x ? (b ? "c" : "d") : "e"', { shapes: 'rich' });
  assert.equal(anyOuter.groups.length, 3, 'each alternative of an any group takes the inner group');
  assert.deepEqual(anyOuter.groups.at(-1), group([truthy('a'), truthy('x')], text('d'), 'any'));
});

test('what the rich reading still cannot delimit is Computed, never read; a plain value is neither', () => {
  const computed = [
    'Astro.url.pathname.replace(/\\/$/, "") === "/shop-all" ? "page" : undefined', // A regular expression.
    'switchable && persona.id !== defaultId', // A test with no value to give.
    '`${label} ${isWebinar ? "registration" : "download"} form`', // A condition inside a template.
    'a ? () => b : c', // An arrow function.
  ];
  for (const code of computed) {
    assert.equal(conditional.readConditionalExpression(code, { shapes: 'rich' }), undefined, code);
    assert.equal(conditional.isConditionalShaped(code), true, `${code}: chooses between values`);
    assert.equal(model.computedOfAttr({ type: 'expr', value: code }), code, `${code}: the field shows Computed`);
  }
  for (const code of ['title', 'slug(label)', 'items.filter((b) => b.a && b.c)', '`x-${y}`', 'selected?.id']) {
    assert.equal(conditional.isConditionalShaped(code), false, `${code}: not conditional`);
    assert.equal(model.computedOfAttr({ type: 'expr', value: code }), undefined, `${code}: keeps its code field`);
  }
  assert.equal(model.computedOfAttr({ type: 'expr', value: 'a ? "x" : "y"' }), undefined, 'a readable chain is Conditional, not Computed');
  assert.deepEqual(
    conditional.readConditionalExpression("a ? '\\x41' : 'z'", { shapes: 'rich' }).groups[0].value,
    { kind: 'computed', code: "'\\x41'" },
    'a string with an escape the reader does not decode is kept whole, as code',
  );
  assert.equal(model.computedOfAttr({ type: 'string', value: 'a ? b' }), undefined, 'words are never Computed');
});

test('the rich parts of a model are parsed at the boundary: known-good passes, each known-bad fails', () => {
  const lookup = { kind: 'lookup', table: 'named', key: 'variant' };
  const good = {
    groups: [group([{ kind: 'code', code: 'a > 1' }], { kind: 'computed', code: 'f(a)' })],
    otherwise: { kind: 'fallback', operator: '??', operands: [reference('a'), lookup] },
  };
  assert.deepEqual(conditional.parseConditionalValue(good), { ok: true, value: good });
  const bad = [
    [{ groups: [group([{ kind: 'code', code: '' }], text(''))], otherwise: text('') }, /code: expected one expression/],
    [{ groups: [group([{ kind: 'code', code: ' a' }], text(''))], otherwise: text('') }, /code: expected one expression/],
    [{ groups: [group([{ kind: 'code', code: 'a, b' }], text(''))], otherwise: text('') }, /code: expected one expression/],
    [{ groups: [group([{ kind: 'code', code: 'f(a' }], text(''))], otherwise: text('') }, /code: expected one expression/],
    [{ groups: [], otherwise: { kind: 'computed', code: 'a)' } }, /otherwise.code/],
    [{ groups: [], otherwise: { ...lookup, key: 'a b' } }, /otherwise.key/],
    [{ groups: [], otherwise: { ...lookup, table: 'true' } }, /otherwise.table/],
    [{ groups: [], otherwise: { kind: 'fallback', operator: '&&', operands: [reference('a'), reference('b')] } }, /operator: expected \?\? or \|\|/],
    [{ groups: [], otherwise: { kind: 'fallback', operator: '??', operands: [reference('a')] } }, /at least two values/],
    [
      { groups: [], otherwise: { kind: 'fallback', operator: '??', operands: [reference('a'), { kind: 'fallback', operator: '??', operands: [] }] } },
      /operands\[1\].kind/,
    ],
  ];
  for (const [input, message] of bad) {
    const parsed = conditional.parseConditionalValue(input);
    assert.equal(parsed.ok, false, JSON.stringify(input));
    assert.match(parsed.error, message);
  }
  const { fallbackOperandsMax, nestingDepthMax } = conditional.CONDITIONAL_LIMITS;
  const operands = (count) => ({
    groups: [],
    otherwise: { kind: 'fallback', operator: '??', operands: Array.from({ length: count }, (_, i) => reference(`v${i}`)) },
  });
  assert.equal(conditional.parseConditionalValue(operands(fallbackOperandsMax)).ok, true);
  assert.match(conditional.parseConditionalValue(operands(fallbackOperandsMax + 1)).error, /more than 8/);
  const nested = (depth) => Array.from({ length: depth }).reduce((inner) => `a ? (${inner}) : 'y'`, "'x'");
  assert.notEqual(conditional.readConditionalExpression(`c ? ${nested(nestingDepthMax - 1)} : 'z'`, { shapes: 'rich' }), undefined, 'within the nesting bound');
  assert.equal(conditional.readConditionalExpression(`c ? ${nested(nestingDepthMax + 1)} : 'z'`, { shapes: 'rich' }), undefined, 'past it');
});

test('a class list keeps what it cannot draw as locked code, parenthesised where it needs it', async () => {
  const code = '[borderless && (compact ? "u-plr-0" : "u-p-0 u-mt-md"), padClass("top", paddingTop), i < groups.length - 1 && "cc-gap"]';
  const read = conditional.readClassListExpression(code);
  assert.deepEqual(read.entries, [
    { value: { kind: 'computed', code: '(compact ? "u-plr-0" : "u-p-0 u-mt-md")' }, match: 'all', when: [truthy('borderless')] },
    { value: { kind: 'computed', code: 'padClass("top", paddingTop)' }, match: 'all', when: [] },
    { value: text('cc-gap'), match: 'all', when: [{ kind: 'code', code: 'i < groups.length - 1' }] },
  ]);
  assert.equal(conditional.emitClassListExpression(read, { quote: '"' }), code);
  assert.equal(await prettier.format(`(${code});\n`, { parser: 'babel', printWidth: 160 }), `${code};\n`);
  // `a && b ? x : y` binds the ternary loosest: the whole entry is the class, not a condition on it.
  assert.deepEqual(conditional.readClassListExpression('[a && b ? "x" : "y"]').entries[0], {
    value: { kind: 'computed', code: 'a && b ? "x" : "y"' },
    match: 'all',
    when: [],
  });
});

test('one group that leaves the value out reads value first, when the negation is exact; unchanged, nothing is written', () => {
  const button = conditional.readConditionalExpression('isWritten ? undefined : (label ?? named[variant])', { shapes: 'rich' });
  const shown = model.presentedModel(button);
  assert.deepEqual(shown.groups, [group([falsy('isWritten')], button.otherwise)], 'If Is Written is false ↳ the value');
  assert.deepEqual(shown.otherwise, { kind: 'none', word: 'undefined' }, 'Else left out');
  const opened = model.draftOf(shown);
  assert.equal(model.draftUnchanged(model.draftOf(shown), opened), true, 'closed unchanged: nothing is written');
  assert.equal(
    conditional.emitConditionalExpression(model.modelOf(opened), { quote: '"' }),
    '!isWritten ? (label ?? named[variant]) : undefined',
    'an edit writes the value-first form',
  );
  // Each negation is exact: not all of them is any of their negations, and the other way round.
  assert.deepEqual(model.presentedModel(conditional.readConditionalExpression("a === 'x' && !b ? null : 'y'")).groups, [
    group([isNotAny('a', 'x'), truthy('b')], text('y'), 'any'),
  ]);
  assert.deepEqual(model.presentedModel(conditional.readConditionalExpression("['x', 'z'].includes(a) || b ? undefined : 'y'")).groups, [
    group([isNotAny('a', 'x', 'z'), falsy('b')], text('y')),
  ]);
  // Refused: a code condition (its negation is not drawn), two groups, an Else that leaves it out too, a group with a value.
  for (const code of ['index >= 3 ? undefined : "y"', 'a ? undefined : b ? undefined : "y"', 'a ? undefined : null', 'a ? "x" : undefined']) {
    const read = conditional.readConditionalExpression(code, { shapes: 'rich' });
    assert.equal(model.presentedModel(read), read, `${code}: shown as written`);
  }
});

test('values the frontmatter computes are listed after the props, with their definition and the prop condition they mean', () => {
  const frontmatter = [
    'const { variant = "main", element = "button", label } = Astro.props;',
    'const isLink = element === "link";',
    'const Tag = isLink ? "a" : "button";',
    'const isWritten = variant === "main" || variant === "link";',
    'const isPlain = variant !== "main" && variant !== "link";',
    'const mixed = variant === "main" || element === "link";',
    'const named = { play: "Play" };',
  ].join('\n');
  const schema = [
    { name: 'variant', type: 'enum', options: ['main', 'link', 'play'] },
    { name: 'element', type: 'enum', options: ['button', 'link'] },
    { name: 'label', type: 'string' },
  ];
  assert.deepEqual(
    model.conditionProps(frontmatter, schema).map((prop) => prop.name),
    ['variant', 'element', 'label'],
    'a default or a type cannot read the frontmatter: props only',
  );
  const catalog = model.conditionProps(frontmatter, schema, 'template');
  const computed = catalog.filter((prop) => prop.computed !== undefined);
  assert.deepEqual(
    computed.map((prop) => [prop.name, prop.label, prop.kind, prop.computed.code]),
    [
      ['isLink', 'Is Link', 'switch', 'element === "link"'],
      ['isWritten', 'Is Written', 'switch', 'variant === "main" || variant === "link"'],
      ['isPlain', 'Is Plain', 'switch', 'variant !== "main" && variant !== "link"'],
      ['mixed', 'Mixed', 'switch', 'variant === "main" || element === "link"'],
    ],
    'tests of props only, after the props; a ternary or an object is not one',
  );
  assert.deepEqual(computed[1].computed.equivalent, isAny('variant', 'main', 'link'), '`||` of one prop is that prop is any of them');
  assert.deepEqual(computed[2].computed.equivalent, isNotAny('variant', 'main', 'link'), '`&&` of `!==` is none of them');
  assert.equal(computed[3].computed.equivalent, undefined, 'two props are not one condition');
  const row = (operator) => ({ subject: 'isWritten', operator, values: [] });
  assert.deepEqual(model.plainerCondition(row('truthy'), catalog), { subject: 'variant', operator: 'in', values: [string('main'), string('link')] });
  assert.deepEqual(
    model.plainerCondition(row('falsy'), catalog),
    { subject: 'variant', operator: 'notIn', values: [string('main'), string('link')] },
    'is false offers the negation',
  );
  assert.equal(model.plainerCondition({ subject: 'mixed', operator: 'truthy', values: [] }, catalog), undefined);
  assert.equal(model.plainerCondition({ subject: 'variant', operator: 'truthy', values: [] }, catalog), undefined, 'a prop is already plain');
});
