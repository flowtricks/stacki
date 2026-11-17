// Goal: a default set per option in a lookup table (`label ?? named[variant]`)
// reads as the Value conditions the attribute fields use, every group starting
// with `variant = <option>`, and an edited model writes back as table entries
// in which every entry whose conditions did not change keeps its code byte for
// byte; a model that is not one group per option (an Else value, a group that
// does not start with the key) is refused rather than written lossy, and an
// entry the editor cannot show leaves the whole table read-only. A
// destructure default that is a chain reads and writes as itself.
// Method: the pure model (src/features/props/conditionalDefault.ts), bundled
// with esbuild and driven table-first over the corpus's table shapes (Button's
// label, a one-option table, a nested condition) with known-good and each
// known-bad shape; no renderer is needed.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/conditional-default');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'conditional-default.cjs');
buildSync({
  stdin: {
    contents: [
      "export * from './src/features/props/conditionalDefault';",
      "export { readConditionalExpression, emitConditionalExpression } from './src/editor/conditionalValue';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const model = require(output);

const QUOTE = { quote: '"' };
const BUTTON = {
  kind: 'table',
  prop: 'label',
  controller: 'variant',
  key: 'variant',
  table: 'named',
  entries: [
    { option: 'play', code: 'pressed ? "Pause" : "Play"' },
    { option: 'close', code: '"Close"' },
    { option: 'arrow', code: 'direction === "back" ? "Previous" : "Next"' },
  ],
};

const is = (option) => ({ kind: 'compare', subject: 'variant', operator: 'in', values: [{ kind: 'string', value: option }] });
const text = (words) => ({ kind: 'text', text: words });

test('Button label: each entry is the groups for its option, in table order', () => {
  const read = model.tableConditional(BUTTON);
  assert.deepEqual(read, {
    groups: [
      { match: 'all', conditions: [is('play'), { kind: 'test', subject: 'pressed', operator: 'truthy' }], value: text('Pause') },
      { match: 'all', conditions: [is('play')], value: text('Play') },
      { match: 'all', conditions: [is('close')], value: text('Close') },
      {
        match: 'all',
        conditions: [is('arrow'), { kind: 'compare', subject: 'direction', operator: 'in', values: [{ kind: 'string', value: 'back' }] }],
        value: text('Previous'),
      },
      { match: 'all', conditions: [is('arrow')], value: text('Next') },
    ],
    otherwise: { kind: 'none', word: 'undefined' },
  });
});

test('Button label: an unedited model writes every entry back as written', () => {
  const read = model.tableConditional(BUTTON);
  const entries = model.tableEntries(read, BUTTON, QUOTE);
  assert.ok(entries.ok);
  assert.deepEqual(entries.value, BUTTON.entries);
});

const EDITS = [
  {
    name: 'a value changed changes that entry only',
    edit: (groups) => groups.map((group, index) => (index === 2 ? { ...group, value: text('Dismiss') } : group)),
    entries: [BUTTON.entries[0], { option: 'close', code: '"Dismiss"' }, BUTTON.entries[2]],
  },
  {
    name: 'a group for a new option adds its entry',
    edit: (groups) => [...groups, { match: 'all', conditions: [is('main')], value: text('Go') }],
    entries: [...BUTTON.entries, { option: 'main', code: '"Go"' }],
  },
  {
    name: 'an option with a condition of its own becomes a chain',
    edit: (groups) => [
      ...groups.slice(0, 2),
      { match: 'all', conditions: [is('close'), { kind: 'test', subject: 'pressed', operator: 'truthy' }], value: text('Shut') },
      ...groups.slice(2),
    ],
    entries: [BUTTON.entries[0], { option: 'close', code: 'pressed ? "Shut" : "Close"' }, BUTTON.entries[2]],
  },
  {
    name: 'all of an option’s groups removed removes its entry',
    edit: (groups) => groups.filter((group) => group.conditions[0].values[0].value !== 'arrow'),
    entries: BUTTON.entries.slice(0, 2),
  },
  {
    name: 'a group after the option’s plain group is never reached and is dropped',
    edit: (groups) => [...groups, { match: 'all', conditions: [is('close'), { kind: 'test', subject: 'pressed', operator: 'falsy' }], value: text('X') }],
    entries: BUTTON.entries,
  },
];

for (const row of EDITS) {
  test(`tableEntries: ${row.name}`, () => {
    const read = model.tableConditional(BUTTON);
    const entries = model.tableEntries({ ...read, groups: row.edit(read.groups) }, BUTTON, QUOTE);
    assert.ok(entries.ok);
    assert.deepEqual(entries.value, row.entries);
  });
}

const REFUSED = [
  { name: 'an Else value', change: (read) => ({ ...read, otherwise: text('Button') }) },
  {
    name: 'a group that does not start with the key',
    change: (read) => ({ ...read, groups: [{ match: 'all', conditions: [{ kind: 'test', subject: 'pressed', operator: 'truthy' }], value: text('P') }] }),
  },
  {
    name: 'a group whose key condition names two options',
    change: (read) => ({
      ...read,
      groups: [
        {
          match: 'all',
          conditions: [
            {
              ...is('play'),
              values: [
                { kind: 'string', value: 'play' },
                { kind: 'string', value: 'close' },
              ],
            },
          ],
          value: text('P'),
        },
      ],
    }),
  },
  { name: 'an any-group of several conditions', change: (read) => ({ ...read, groups: [{ ...read.groups[0], match: 'any' }] }) },
];

for (const row of REFUSED) {
  test(`tableEntries refuses ${row.name}`, () => {
    const entries = model.tableEntries(row.change(model.tableConditional(BUTTON)), BUTTON, QUOTE);
    assert.deepEqual(entries, { ok: false, error: 'perOption' });
  });
}

const UNREADABLE = [
  { name: 'a call', code: 'labelFor(pressed)' },
  { name: 'an object', code: '{ label: "A" }' },
  { name: 'an any-group of several conditions', code: 'pressed || direction === "back" ? "A" : "B"' },
];

for (const row of UNREADABLE) {
  test(`an entry the editor cannot show leaves the table read-only: ${row.name}`, () => {
    const table = { ...BUTTON, entries: [...BUTTON.entries, { option: 'main', code: row.code }] };
    assert.equal(model.tableConditional(table), undefined);
  });
}

test('a destructure default chain reads as itself and writes back the same', () => {
  const code = 'size === "small" ? "S" : size === "large" ? "L" : "M"';
  const read = model.conditionalOfDefault(code);
  assert.ok(read !== undefined);
  assert.equal(model.defaultOfConditional(read, QUOTE), code);
  // A plain default is not conditional; a chain cut down to its Else is that value, and no value is no default.
  assert.equal(model.conditionalOfDefault('"Hello"'), undefined);
  assert.equal(model.defaultOfConditional({ groups: [], otherwise: text('Hi') }, QUOTE), '"Hi"');
  assert.equal(model.defaultOfConditional({ groups: [], otherwise: { kind: 'none', word: 'undefined' } }, QUOTE), '');
});

test('the conditions catalog reads options without their quotes and keeps switches and numbers', () => {
  const schema = model.conditionSchema([
    { name: 'variant', type: '"main" | "play"', required: false, readonly: false, defaultValue: '', description: '' },
    { name: 'pressed', type: 'boolean', required: false, readonly: false, defaultValue: '', description: '' },
    { name: 'count', type: 'number', required: false, readonly: false, defaultValue: '', description: '' },
    { name: 'label', type: 'string', required: false, readonly: false, defaultValue: '', description: '' },
  ]);
  assert.deepEqual(schema, [
    { name: 'variant', type: 'enum', options: ['main', 'play'] },
    { name: 'pressed', type: 'boolean' },
    { name: 'count', type: 'number' },
    { name: 'label', type: 'string' },
  ]);
});
