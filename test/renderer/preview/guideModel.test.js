// Goal: the column guide lands where the project's content box is, takes each
// value from the right source, and refuses what it cannot draw. Methodology:
// resolve hand-built measurements against settings — Lumos's values, a project
// that declares nothing (fixed rem defaults at different root font sizes), menu
// lengths and menu variables declared or missing, a capped wide screen — then
// corrupt the inputs (zero columns, gutters wider than the box, lengths and
// names out of bounds) and check the assertions and parsers say so. Column
// counts follow --site-columns by default, fall back to 12, and respect overrides.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GUIDE_DEFAULTS,
  GUIDE_LENGTH_DEFAULTS,
  GUIDE_LIMITS,
  clampGuideOpacity,
  guideColumns,
  guideColumnText,
  parseGuideColumnSetting,
  guideLengthText,
  guideSizeText,
  guideVariableNames,
  parseGuideColumnCount,
  parseGuideLength,
  parseGuideSize,
  resolveGuide,
} = require('../../helpers/rendererModule')('src/features/preview/guideModel.ts');

// Lumos at a 1440px viewport: 48px margins, 32px gutters, a 1440px cap.
const LUMOS_WIDE = {
  viewportWidthPx: 1440,
  rootFontPx: 16,
  marginPx: 48,
  gutterPx: 32,
  widthMaxPx: 1440,
  variablesPx: {},
  variableCounts: {},
};
const NOTHING_DECLARED = {
  viewportWidthPx: 1000,
  rootFontPx: 16,
  marginPx: undefined,
  gutterPx: undefined,
  widthMaxPx: undefined,
  variablesPx: {},
  variableCounts: {},
};
const length = (amount, unit) => ({ kind: 'length', length: { amount, unit } });
const variable = (name) => ({ kind: 'variable', name });

test('project values win for the margin, gutter and maximum width', () => {
  const guide = resolveGuide(LUMOS_WIDE, GUIDE_DEFAULTS);
  assert.deepEqual(guide.margin, { px: 48, source: 'project' });
  assert.deepEqual(guide.gutter, { px: 32, source: 'project' });
  assert.deepEqual(guide.widthMax, { px: 1440, source: 'project' });
  assert.equal(guide.columnCount, 12);
  assert.equal(guide.columnSource, 'stacki');
});

test('a count picked in Stacki overrides the project count', () => {
  const guide = resolveGuide(LUMOS_WIDE, {
    ...GUIDE_DEFAULTS,
    columns: { kind: 'count', count: 16 },
  });
  assert.equal(guide.columnCount, 16);
  assert.equal(guide.columnSource, 'stacki');
  assert.deepEqual(guide.margin, { px: 48, source: 'project' });
});

test('missing layout variables use 3rem margin, 1rem gutter, and 90rem max width', () => {
  for (const rootFontPx of [16, 20]) {
    const guide = resolveGuide({ ...NOTHING_DECLARED, rootFontPx }, GUIDE_DEFAULTS);
    assert.deepEqual(guide.margin, { px: 3 * rootFontPx, source: 'default' });
    assert.deepEqual(guide.gutter, { px: rootFontPx, source: 'default' });
    assert.deepEqual(guide.widthMax, { px: 90 * rootFontPx, source: 'default' });
    assert.equal(guide.columnCount, 12);
  }
  assert.deepEqual(GUIDE_LENGTH_DEFAULTS.margin, { amount: 3, unit: 'rem' });
  const custom = resolveGuide(NOTHING_DECLARED, { ...GUIDE_DEFAULTS, margin: length(2, 'rem') });
  assert.deepEqual(custom.margin, { px: 32, source: 'fixed' });
  const partial = resolveGuide({ ...NOTHING_DECLARED, marginPx: 10 }, GUIDE_DEFAULTS);
  assert.deepEqual(partial.margin, { px: 10, source: 'project' });
  assert.deepEqual(partial.gutter, { px: 16, source: 'default' });
  assert.deepEqual(partial.widthMax, { px: 1440, source: 'default' });
});

test('a menu variable is used as the page resolves it, and a missing one falls back', () => {
  const metrics = { ...NOTHING_DECLARED, variablesPx: { '--pad': 40, '--wide': 900 } };
  const settings = {
    ...GUIDE_DEFAULTS,
    margin: variable('--pad'),
    gutter: variable('--missing'),
    widthMax: variable('--wide'),
  };
  const guide = resolveGuide(metrics, settings);
  assert.deepEqual(guide.margin, { px: 40, source: 'variable' });
  assert.equal(guide.gutter.source, 'default');
  assert.deepEqual(guide.widthMax, { px: 900, source: 'variable' });
  const missingCap = resolveGuide(metrics, { ...settings, widthMax: variable('--none') });
  assert.deepEqual(missingCap.widthMax, { px: 1440, source: 'default' });
});

test('the menu outranks the project, whose value is the default it falls back to', () => {
  const metrics = { ...LUMOS_WIDE, variablesPx: { '--pad': 10 } };
  const settings = {
    ...GUIDE_DEFAULTS,
    margin: variable('--pad'),
    gutter: length(1, 'rem'),
    widthMax: length(1000, 'px'),
  };
  const guide = resolveGuide(metrics, settings);
  assert.deepEqual(guide.margin, { px: 10, source: 'variable' });
  assert.deepEqual(guide.gutter, { px: 16, source: 'fixed' });
  assert.deepEqual(guide.widthMax, { px: 1000, source: 'fixed' });
  // A menu variable the page does not declare falls back to the project's value.
  const missing = resolveGuide(metrics, { ...settings, margin: variable('--missing') });
  assert.deepEqual(missing.margin, { px: 48, source: 'project' });
  // A menu maximum width that caps nothing falls back to the project's too.
  const empty = resolveGuide(metrics, { ...settings, widthMax: length(0, 'px') });
  assert.deepEqual(empty.widthMax, { px: 1440, source: 'project' });
});

test('typed values: a length, a variable name or var(), anything else refused', () => {
  assert.deepEqual(parseGuideSize('32px'), length(32, 'px'));
  assert.deepEqual(parseGuideSize('--pad'), variable('--pad'));
  assert.deepEqual(parseGuideSize(' var( --container_2 ) '), variable('--container_2'));
  for (const text of ['', '-pad', '--', '--a b', 'var(--a', 'var(pad)', '--a;color:red', '4em']) {
    assert.equal(parseGuideSize(text), undefined, text);
  }
  const longest = `--${'a'.repeat(GUIDE_LIMITS.variableCharsMax - 2)}`;
  assert.deepEqual(parseGuideSize(longest), variable(longest));
  assert.equal(parseGuideSize(`${longest}a`), undefined);
  assert.equal(guideSizeText(variable('--pad')), 'var(--pad)');
  assert.equal(guideSizeText(length(2, 'rem')), '2rem');
});

test('the frame is asked about each menu variable once', () => {
  const settings = {
    ...GUIDE_DEFAULTS,
    margin: variable('--pad'),
    gutter: variable('--pad'),
    widthMax: length(1200, 'px'),
  };
  assert.deepEqual(guideVariableNames(settings), ['--pad', '--site-columns']);
  assert.deepEqual(guideVariableNames(GUIDE_DEFAULTS), ['--site-columns']);
  const counted = { ...settings, gutter: variable('--gap'), columns: variable('--cols') };
  assert.deepEqual(guideVariableNames(counted), ['--pad', '--gap', '--cols', '--site-columns']);
});

test('automatic columns follow site-columns as it changes and show the binding', () => {
  assert.deepEqual(GUIDE_DEFAULTS.columns, { kind: 'automatic' });
  for (const count of [2, 3, 4, 8, 13, 24, 32]) {
    const metrics = { ...LUMOS_WIDE, variableCounts: { '--site-columns': count } };
    const guide = resolveGuide(metrics, GUIDE_DEFAULTS);
    assert.equal(guide.columnCount, count);
    assert.equal(guide.columnSource, 'project');
    assert.equal(guideColumns(guide).length, count);
    assert.equal(guideColumnText(GUIDE_DEFAULTS.columns, metrics), 'var(--site-columns)');
    const override = { ...GUIDE_DEFAULTS, columns: { kind: 'count', count: 12 } };
    assert.equal(resolveGuide(metrics, override).columnCount, 12);
    assert.equal(guideColumnText(override.columns, metrics), '12');
  }
});

test('automatic columns fall back to 12 for missing or unusable site-columns', () => {
  assert.equal(guideColumnText(GUIDE_DEFAULTS.columns), '12');
  for (const count of [undefined, 0, 1, 33, 4.5, Number.NaN, Infinity]) {
    const metrics = { ...LUMOS_WIDE, variableCounts: { '--site-columns': count } };
    const guide = resolveGuide(metrics, GUIDE_DEFAULTS);
    assert.equal(guide.columnCount, 12);
    assert.equal(guide.columnSource, 'stacki');
    assert.equal(guideColumnText(GUIDE_DEFAULTS.columns, metrics), '12');
  }
});

test('a connected column variable follows the page and updates with its value', () => {
  const settings = { ...GUIDE_DEFAULTS, columns: variable('--cols') };
  for (const count of [2, 3, 4, 10, 13, 24, 32]) {
    const metrics = { ...LUMOS_WIDE, variableCounts: { '--cols': count, '--site-columns': 6 } };
    const guide = resolveGuide(metrics, settings);
    assert.equal(guide.columnCount, count);
    assert.equal(guide.columnSource, 'project');
    assert.equal(guideColumns(guide).length, count);
  }
  assert.equal(guideColumnText(settings.columns), 'var(--cols)');
});

test('unusable column variables follow site-columns before the fixed fallback', () => {
  const settings = { ...GUIDE_DEFAULTS, columns: variable('--cols') };
  for (const count of [undefined, 0, 1, 33, 4.5, Number.NaN, Infinity]) {
    const metrics = { ...LUMOS_WIDE, variableCounts: { '--cols': count, '--site-columns': 8 } };
    const guide = resolveGuide(metrics, settings);
    assert.equal(guide.columnCount, 8);
    assert.equal(guide.columnSource, 'project');
    assert.equal(guideColumns(guide).length, 8);
    assert.equal(guideColumnText(settings.columns, metrics), 'var(--cols)');
  }
});

test('unusable connections use 12 when the project fallback is also unusable', () => {
  const settings = { ...GUIDE_DEFAULTS, columns: variable('--cols') };
  for (const count of [undefined, 0, 1, 33, 4.5, Number.NaN, Infinity]) {
    const metrics = { ...LUMOS_WIDE, variableCounts: { '--cols': 0, '--site-columns': count } };
    assert.equal(resolveGuide(metrics, settings).columnCount, 12);
    assert.equal(resolveGuide(metrics, settings).columnSource, 'stacki');
  }
});

test('four distinct menu connections also measure the project column fallback', () => {
  const settings = {
    ...GUIDE_DEFAULTS,
    margin: variable('--pad'),
    gutter: variable('--gap'),
    widthMax: variable('--max'),
    columns: variable('--cols'),
  };
  assert.deepEqual(guideVariableNames(settings), ['--pad', '--gap', '--max', '--cols', '--site-columns']);
  assert.equal(guideVariableNames(settings).length, GUIDE_LIMITS.variablesMax);
  const duplicate = { ...settings, columns: variable('--site-columns') };
  assert.deepEqual(guideVariableNames(duplicate), ['--pad', '--gap', '--max', '--site-columns']);
  const fixed = { ...settings, columns: { kind: 'count', count: 8 } };
  assert.deepEqual(guideVariableNames(fixed), ['--pad', '--gap', '--max']);
});

test('the column field accepts only a bounded whole count or one variable', () => {
  for (const text of ['2', '3', '4', '13', '24', '32', ' 12 ']) {
    assert.deepEqual(parseGuideColumnSetting(text), { kind: 'count', count: Number(text) });
  }
  assert.deepEqual(parseGuideColumnSetting('--cols'), variable('--cols'));
  assert.deepEqual(parseGuideColumnSetting('var( --cols )'), variable('--cols'));
  for (const text of [
    '',
    '0',
    '1',
    '33',
    '4.5',
    '12px',
    '2rem',
    '1e1',
    'calc(6 + 6)',
    'var(--cols, 12)',
    '--a b',
    `--${'a'.repeat(GUIDE_LIMITS.variableCharsMax)}`,
  ]) {
    assert.equal(parseGuideColumnSetting(text), undefined, text);
  }
});

test('a maximum width the page resolves to nothing uses 90rem', () => {
  const guide = resolveGuide({ ...LUMOS_WIDE, widthMaxPx: 0 }, GUIDE_DEFAULTS);
  assert.deepEqual(guide.widthMax, { px: 1440, source: 'default' });
});

test('columns fill the content box between the margins, gutters between them', () => {
  const columns = guideColumns(resolveGuide(LUMOS_WIDE, GUIDE_DEFAULTS));
  assert.equal(columns.length, 12);
  // 1440 − 2 × 48 = 1344; less 11 gutters of 32 = 992; twelve columns of 82.67.
  assert.equal(columns[0].xPx, 48);
  assert.ok(Math.abs(columns[0].widthPx - 992 / 12) < 1e-9);
  const last = columns[11];
  assert.ok(Math.abs(last.xPx + last.widthPx - (1440 - 48)) < 1e-9);
  assert.ok(Math.abs(columns[1].xPx - (columns[0].xPx + columns[0].widthPx) - 32) < 1e-9);
});

test('past the maximum width the content box stays centred', () => {
  const guide = resolveGuide({ ...LUMOS_WIDE, viewportWidthPx: 2000 }, GUIDE_DEFAULTS);
  const columns = guideColumns(guide);
  assert.equal(columns[0].xPx, (2000 - 1440) / 2);
  const last = columns[11];
  assert.ok(Math.abs(last.xPx + last.widthPx - (2000 + 1440) / 2) < 1e-9);
});

test('gutters that leave no room draw no columns', () => {
  const crowded = { ...LUMOS_WIDE, viewportWidthPx: 400, gutterPx: 40 };
  assert.deepEqual(guideColumns(resolveGuide(crowded, { ...GUIDE_DEFAULTS, columns: { kind: 'count', count: 24 } })), []);
  const marginsOnly = { ...LUMOS_WIDE, viewportWidthPx: 80 };
  assert.deepEqual(guideColumns(resolveGuide(marginsOnly, GUIDE_DEFAULTS)), []);
});

test('column counts the guide cannot draw are assertion failures', () => {
  const guide = resolveGuide(LUMOS_WIDE, GUIDE_DEFAULTS);
  assert.throws(() => guideColumns({ ...guide, columnCount: 2.5 }), /column count is an integer/);
  for (const columnCount of [0, 1, 33]) {
    assert.throws(() => guideColumns({ ...guide, columnCount }), /column count within range/);
  }
  assert.throws(() => resolveGuide({ ...LUMOS_WIDE, rootFontPx: 0 }, GUIDE_DEFAULTS), /root font/);
});

test('typed lengths take px or rem, a bare number is px, anything else is refused', () => {
  assert.deepEqual(parseGuideLength('48px'), { amount: 48, unit: 'px' });
  assert.deepEqual(parseGuideLength(' 3 REM '), { amount: 3, unit: 'rem' });
  assert.deepEqual(parseGuideLength('24'), { amount: 24, unit: 'px' });
  assert.deepEqual(parseGuideLength('.5rem'), { amount: 0.5, unit: 'rem' });
  for (const text of ['', 'px', '-4px', '4em', '4 px rem', 'var(--x)', '1e3px', 'Infinitypx']) {
    assert.equal(parseGuideLength(text), undefined, text);
  }
  assert.equal(parseGuideLength(`${GUIDE_LIMITS.lengthPxMax + 1}px`), undefined);
  assert.equal(parseGuideLength(`${GUIDE_LIMITS.lengthRemMax + 1}rem`), undefined);
  assert.deepEqual(parseGuideLength(`${GUIDE_LIMITS.lengthPxMax}px`), {
    amount: GUIDE_LIMITS.lengthPxMax,
    unit: 'px',
  });
});

test('lengths read back as they were typed', () => {
  assert.equal(guideLengthText({ amount: 1.23456, unit: 'rem' }), '1.235rem');
  assert.equal(guideLengthText({ amount: 32, unit: 'px' }), '32px');
});

test('a typed count accepts whole numbers from 2 through 32', () => {
  for (const count of [2, 3, 4, 10, 24, 25, 32]) {
    assert.equal(parseGuideColumnCount(String(count)), count);
  }
  for (const text of ['0', '-1', '1', '33', '99', '100', '04x', '', ' 8', 'ten', '-8', '8.5', '8,5']) {
    assert.equal(parseGuideColumnCount(text), undefined, text);
  }
});

test('opacity stays within 0.06 and 0.2, on 0.01 steps', () => {
  assert.equal(clampGuideOpacity(0.1), 0.1);
  assert.equal(clampGuideOpacity(0.123), 0.12);
  assert.equal(clampGuideOpacity(0), GUIDE_LIMITS.opacityMin);
  assert.equal(clampGuideOpacity(0.05), 0.06);
  assert.equal(clampGuideOpacity(0.9), GUIDE_LIMITS.opacityMax);
  assert.equal(clampGuideOpacity(0.19999), 0.2);
});
