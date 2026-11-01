// Goal: a stored guide record from any app version reads back as usable
// settings, and a bad field costs only that field. Methodology: parse a full record,
// then records missing or garbling each field in turn, and check every other
// field survives. Legacy column presets migrate to literals or explicit
// variable connections. Old defaults migrate to automatic; newly saved literal
// overrides round-trip without becoming automatic. Colours go
// through CSS.supports, which Node lacks, so a stand-in accepts the literal
// colours a browser would.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.CSS = {
  supports: (property, value) => property === 'color' && /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|red)$/i.test(value),
};

const { parseGuideColor, parseGuideSettings } = require('../../helpers/rendererModule')('src/features/preview/guideSettings.ts');
const { GUIDE_DEFAULTS, GUIDE_LIMITS } = require('../../helpers/rendererModule')('src/features/preview/guideModel.ts');

const STORED = {
  visible: true,
  columns: { kind: 'count', count: 16 },
  color: '#00ff88',
  opacity: 0.15,
  numbers: false,
  margin: { kind: 'length', length: { amount: 2, unit: 'rem' } },
  gutter: { kind: 'variable', name: '--gap' },
  widthMax: { kind: 'length', length: { amount: 1200, unit: 'px' } },
};

test('a stored record reads back whole', () => {
  assert.deepEqual(parseGuideSettings(STORED), STORED);
  const bound = { ...STORED, columns: { kind: 'variable', name: '--cols' } };
  assert.deepEqual(parseGuideSettings(bound), bound);
});

test('the guide is off by default, grey at 0.06, numbered, with automatic columns', () => {
  assert.equal(GUIDE_DEFAULTS.visible, false);
  assert.equal(GUIDE_DEFAULTS.color, 'rgb(146, 146, 146)');
  assert.equal(GUIDE_DEFAULTS.opacity, 0.06);
  assert.equal(GUIDE_DEFAULTS.numbers, true);
  assert.deepEqual(GUIDE_DEFAULTS.columns, { kind: 'automatic' });
});

test('anything that is not a record is the defaults', () => {
  const PLATFORM_NULL = JSON.parse('null');
  for (const input of [undefined, PLATFORM_NULL, 3, 'guide', true]) {
    assert.deepEqual(parseGuideSettings(input), GUIDE_DEFAULTS);
  }
});

test('a garbled field falls back alone', () => {
  const garbled = {
    visible: 'yes',
    columns: 12.5,
    color: 'var(--brand)',
    opacity: Number.NaN,
    numbers: 0,
    margin: { kind: 'length', length: { amount: -1, unit: 'px' } },
    gutter: { kind: 'variable', name: 'gap;color:red' },
    widthMax: { kind: 'length', length: { amount: 4, unit: 'em' } },
  };
  for (const [field, bad] of Object.entries(garbled)) {
    const parsed = parseGuideSettings({ ...STORED, [field]: bad });
    assert.deepEqual(parsed[field], GUIDE_DEFAULTS[field], field);
    for (const other of Object.keys(STORED).filter((key) => key !== field)) {
      assert.deepEqual(parsed[other], STORED[other], `${field} kept ${other}`);
    }
  }
});

test('margin, gutter and maximum width are unset by default, and a stored size can be', () => {
  assert.equal(GUIDE_DEFAULTS.margin, undefined);
  assert.equal(GUIDE_DEFAULTS.gutter, undefined);
  assert.equal(GUIDE_DEFAULTS.widthMax, undefined);
  for (const unset of [undefined, 'none', { kind: 'other' }, { kind: 'variable' }]) {
    assert.equal(parseGuideSettings({ ...STORED, margin: unset }).margin, undefined);
  }
});

test('legacy counts survive independently of the removed preset list', () => {
  for (const count of [2, 3, 4, 13, 24, 32]) {
    const legacy = { ...STORED, columns: count, columnChoices: [12] };
    assert.deepEqual(parseGuideSettings(legacy).columns, { kind: 'count', count });
  }
  const legacy = { ...STORED, columns: 'project', columnVariable: '--cols' };
  assert.deepEqual(parseGuideSettings(legacy).columns, { kind: 'variable', name: '--cols' });
  assert.deepEqual(parseGuideSettings({ columns: 'project' }).columns, GUIDE_DEFAULTS.columns);
  assert.deepEqual(parseGuideSettings({ columns: 8, columnVariable: '--cols' }).columns, {
    kind: 'count',
    count: 8,
  });
});

test('old defaults become automatic while new literal overrides survive reopening', () => {
  for (const columns of [12, { kind: 'count', count: 12 }, { kind: 'automatic' }]) {
    assert.deepEqual(parseGuideSettings({ ...STORED, columns }).columns, GUIDE_DEFAULTS.columns);
  }
  const columns = { kind: 'count', count: 12 };
  const saved = JSON.parse(JSON.stringify({ ...STORED, columns, columnDefaultsVersion: 1 }));
  assert.deepEqual(parseGuideSettings(saved), { ...STORED, columns });
  const automatic = { ...saved, columns: { kind: 'automatic' } };
  assert.deepEqual(parseGuideSettings(automatic).columns, GUIDE_DEFAULTS.columns);
  const custom = { ...STORED, columns: { kind: 'variable', name: '--site-columns' } };
  assert.deepEqual(parseGuideSettings(custom), custom);
});

test('malformed stored column settings reset to automatic without changing other fields', () => {
  const badValues = [
    { kind: 'count' },
    { kind: 'count', count: 0 },
    { kind: 'count', count: 1 },
    { kind: 'count', count: 33 },
    { kind: 'count', count: 4.5 },
    { kind: 'count', count: '12' },
    { kind: 'variable' },
    { kind: 'variable', name: '--bad name' },
    { kind: 'variable', name: `--${'a'.repeat(GUIDE_LIMITS.variableCharsMax)}` },
    { kind: 'other', count: 8 },
    [],
    0,
    Infinity,
  ];
  for (const columns of badValues) {
    assert.deepEqual(parseGuideSettings({ ...STORED, columns }), {
      ...STORED,
      columns: GUIDE_DEFAULTS.columns,
    });
  }
});

test('a stored opacity is pulled back into range', () => {
  assert.equal(parseGuideSettings({ ...STORED, opacity: 2 }).opacity, GUIDE_LIMITS.opacityMax);
  assert.equal(parseGuideSettings({ ...STORED, opacity: 0 }).opacity, GUIDE_LIMITS.opacityMin);
});

test('colours: literal, bounded, never a variable', () => {
  assert.equal(parseGuideColor(' #ff5c5c '), '#ff5c5c');
  assert.equal(parseGuideColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(parseGuideColor(''), undefined);
  assert.equal(parseGuideColor('not a colour'), undefined);
  assert.equal(parseGuideColor('var(--brand)'), undefined);
  assert.equal(parseGuideColor(42), undefined);
  assert.equal(parseGuideColor(`rgb(${' '.repeat(GUIDE_LIMITS.colorCharsMax)}1, 2, 3)`), undefined);
});
