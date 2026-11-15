// Goal: `.stacki/breakpoints.json` holds an ordered list of breakpoints, each `down` (`width < X`, canvas X - 1) or `up`
// (`width >= X`, canvas X), strictly decreasing in pixels with every `up` before every `down`; every other shape is an error value
// (never a throw); one resolver turns a boundary into a canvas width; typed entries accept exactly `64rem`, `64 rem`, `62.5rem`,
// `1024px` and a bare number (px); and versions 1 and 2 migrate without moving a canvas width.
// Method: resolve the defaults (1023/767/479) and table-test the resolver for both directions, rem, px, decimals and mixed units;
// parse each good and bad typed entry pinning the error code; parse the good version 3 file and each bad shape (ids, names, counts,
// directions, ordering between up and down, equal boundaries, extra keys, wrong version, not JSON, oversized); migrate versions 1
// and 2; check the serializer is byte-stable and refuses an invalid list; add, remove and rename; run the metadata transport's
// validator so a bad write never reaches disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKPOINT_DEFAULTS,
  BREAKPOINT_DEFAULT_LIST,
  BREAKPOINT_LIMITS,
  boundaryPx,
  breakpointCondition,
  breakpointsEqual,
  canvasWidthPx,
  checkedList,
  conflictAt,
  formatBreakpoint,
  nextBreakpointId,
  parseBreakpointEntry,
  parseBreakpoints,
  parseBreakpointsSource,
  resolveBreakpoints,
  serializeBreakpoints,
  uniqueBreakpointName,
  withBreakpointAdded,
  withBreakpointName,
  withBreakpointRemoved,
  withBreakpointSetting,
} from '#dist/shared/properties/projectBreakpoints.js';
import type { Breakpoint, BreakpointList } from '#dist/shared/properties/projectBreakpoints.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const large: Breakpoint = { id: 'bp-1', name: 'Large', direction: 'up', setting: { value: 100, unit: 'rem' } };
const huge: Breakpoint = { id: 'bp-2', name: 'Huge', direction: 'up', setting: { value: 120, unit: 'rem' } };
const withUps: BreakpointList = [huge, large, ...BREAKPOINT_DEFAULT_LIST];

const entry = (id: string, direction: string, value: unknown, unit: unknown, extra: Record<string, unknown> = {}) => ({ id, direction, value, unit, ...extra });
const fileOf = (breakpoints: unknown) => ({ version: 3, breakpoints });
const goodFile = fileOf([
  entry('bp-1', 'up', 100, 'rem', { name: 'Large' }),
  entry('laptop', 'down', 64, 'rem'),
  entry('tablet', 'down', 800, 'px'),
  entry('phone', 'down', 30, 'rem'),
]);

function failureCode(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  assert.equal(result.ok, false);
  return result.error?.code ?? '';
}

test('the defaults are 64rem, 48rem and 30rem (down), which resolve to 1023, 767 and 479', () => {
  assert.deepEqual(
    BREAKPOINT_DEFAULT_LIST.map((breakpoint) => [breakpoint.id, breakpoint.direction, formatBreakpoint(breakpoint.setting)]),
    [
      ['laptop', 'down', '64rem'],
      ['tablet', 'down', '48rem'],
      ['phone', 'down', '30rem'],
    ],
  );
  assert.deepEqual(
    BREAKPOINT_DEFAULTS.map((breakpoint) => breakpoint.widthPx),
    [1023, 767, 479],
  );
  assert.deepEqual(parseBreakpointsSource(undefined), { ok: true, value: BREAKPOINT_DEFAULT_LIST });
  assert.equal(breakpointCondition(BREAKPOINT_DEFAULT_LIST.at(0) ?? large), 'width < 64rem');
  assert.equal(breakpointCondition(large), 'width >= 100rem');
});

test('the resolver: down is the boundary less one pixel, up is the boundary itself', () => {
  const widths = (breakpoint: Pick<Breakpoint, 'direction' | 'setting'>) => canvasWidthPx(breakpoint);
  assert.equal(widths({ direction: 'down', setting: { value: 64, unit: 'rem' } }), 1023);
  assert.equal(widths({ direction: 'down', setting: { value: 1024, unit: 'px' } }), 1023);
  assert.equal(widths({ direction: 'down', setting: { value: 62.5, unit: 'rem' } }), 999);
  assert.equal(widths({ direction: 'up', setting: { value: 100, unit: 'rem' } }), 1600);
  assert.equal(widths({ direction: 'up', setting: { value: 120, unit: 'rem' } }), 1920);
  assert.equal(widths({ direction: 'up', setting: { value: 1600, unit: 'px' } }), 1600);
  assert.equal(widths({ direction: 'up', setting: { value: 62.55, unit: 'rem' } }), 1001, 'the first whole pixel that is in it');
  assert.equal(boundaryPx({ value: 62.5, unit: 'rem' }), 1000);
  assert.deepEqual(
    resolveBreakpoints(withUps).map((breakpoint) => [breakpoint.id, breakpoint.widthPx]),
    [
      ['bp-2', 1920],
      ['bp-1', 1600],
      ['laptop', 1023],
      ['tablet', 767],
      ['phone', 479],
    ],
  );
});

test('typed entries: rem, px, spaces, decimals and a bare number (px)', () => {
  const entries: ReadonlyArray<readonly [string, unknown]> = [
    ['64rem', { value: 64, unit: 'rem' }],
    ['64 rem', { value: 64, unit: 'rem' }],
    [' 62.5rem ', { value: 62.5, unit: 'rem' }],
    ['62.5REM', { value: 62.5, unit: 'rem' }],
    ['1024px', { value: 1024, unit: 'px' }],
    ['1024', { value: 1024, unit: 'px' }],
  ];
  for (const [text, expected] of entries) {
    assert.deepEqual(parseBreakpointEntry(text), { ok: true, value: expected }, text);
  }
  for (const text of ['', 'rem', 'abc', '64em', '-64rem', '.5rem', '1e3', '1,024px', '64rem;', '0x40', '62.55555rem']) {
    assert.equal(failureCode(parseBreakpointEntry(text)), 'breakpoints-syntax', JSON.stringify(text));
  }
  assert.equal(failureCode(parseBreakpointEntry('1000.5px')), 'breakpoints-pxWhole');
  for (const text of ['0', '280px', '1px', '7682px', '99999px', '481rem']) {
    assert.equal(failureCode(parseBreakpointEntry(text)), 'breakpoints-range', text);
  }
  assert.equal(parseBreakpointEntry('281px').ok, true);
  assert.equal(parseBreakpointEntry('7681px').ok, true);
});

test('the known-good version 3 file parses, mixed units and names included', () => {
  const parsed = parseBreakpointsSource(JSON.stringify(goodFile));
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.ok ? parsed.value.map((breakpoint) => [breakpoint.id, breakpoint.name, breakpoint.direction, formatBreakpoint(breakpoint.setting)]) : [],
    [
      ['bp-1', 'Large', 'up', '100rem'],
      ['laptop', undefined, 'down', '64rem'],
      ['tablet', undefined, 'down', '800px'],
      ['phone', undefined, 'down', '30rem'],
    ],
  );
  assert.deepEqual(parseBreakpoints(fileOf([])), { ok: true, value: [] }, 'the list may be empty: only Desktop is left');
});

test('ordering: strictly decreasing, every up before every down, equal boundaries refused', () => {
  const down = (id: string, value: number) => entry(id, 'down', value, 'rem');
  const up = (id: string, value: number) => entry(id, 'up', value, 'rem');
  assert.equal(failureCode(parseBreakpoints(fileOf([down('laptop', 48), down('tablet', 64)]))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(fileOf([down('laptop', 64), down('tablet', 64)]))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(fileOf([down('laptop', 64), up('bp-1', 100)]))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(fileOf([up('bp-1', 100), up('bp-2', 120)]))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(fileOf([up('bp-1', 64), down('laptop', 64)]))), 'breakpoints-order', 'an up is above every down, strictly');
  assert.equal(failureCode(parseBreakpoints(fileOf([up('bp-1', 60), down('laptop', 64)]))), 'breakpoints-order');
  assert.equal(parseBreakpoints(fileOf([up('bp-1', 65), down('laptop', 64)])).ok, true);
  assert.equal(
    failureCode(parseBreakpoints(fileOf([entry('bp-1', 'up', 100, 'rem'), entry('laptop', 'down', 1600, 'px')]))),
    'breakpoints-order',
    'by pixels, whatever the units',
  );
  assert.equal(conflictAt(withBreakpointSetting(BREAKPOINT_DEFAULT_LIST, 'tablet', { value: 64, unit: 'rem' }), 1)?.relation, 'smaller');
  assert.equal(conflictAt(withBreakpointSetting(BREAKPOINT_DEFAULT_LIST, 'laptop', { value: 40, unit: 'rem' }), 0)?.relation, 'larger');
  assert.equal(conflictAt(BREAKPOINT_DEFAULT_LIST, 1), undefined);
});

test('bad entries are refused: ids, names, directions, values, units, keys', () => {
  const one = (changes: Record<string, unknown>) => parseBreakpoints(fileOf([{ ...entry('bp-1', 'up', 100, 'rem'), ...changes }]));
  assert.equal(failureCode(one({ id: 5 })), 'breakpoints-id');
  assert.equal(failureCode(one({ id: 'Bad Id' })), 'breakpoints-id');
  assert.equal(failureCode(one({ id: 'a'.repeat(BREAKPOINT_LIMITS.idCharsMax + 1) })), 'breakpoints-id');
  assert.equal(failureCode(one({ name: 5 })), 'breakpoints-name');
  assert.equal(failureCode(one({ name: '' })), 'breakpoints-name');
  assert.equal(failureCode(one({ name: 'x'.repeat(BREAKPOINT_LIMITS.nameCharsMax + 1) })), 'breakpoints-name');
  assert.equal(failureCode(one({ name: 'tab\there' })), 'breakpoints-name');
  assert.equal(failureCode(one({ direction: 'sideways' })), 'breakpoints-direction');
  assert.equal(failureCode(one({ value: 0 })), 'breakpoints-range');
  assert.equal(failureCode(one({ value: 1e15 })), 'breakpoints-range');
  assert.equal(failureCode(one({ value: '100' })), 'breakpoints-type');
  assert.equal(failureCode(one({ value: Number.NaN })), 'breakpoints-type');
  assert.equal(failureCode(one({ unit: 'em' })), 'breakpoints-unit');
  assert.equal(failureCode(one({ unit: 'px', value: 1600.5 })), 'breakpoints-pxWhole');
  assert.equal(failureCode(one({ extra: 1 })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints(fileOf([5]))), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints(fileOf('x'))), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ version: 3, breakpoints: [], note: 1 })), 'breakpoints-shape');
});

test('ids and names must be unique, and the count is bounded', () => {
  assert.equal(failureCode(parseBreakpoints(fileOf([entry('bp-1', 'up', 100, 'rem'), entry('bp-1', 'down', 64, 'rem')]))), 'breakpoints-duplicate');
  assert.equal(
    failureCode(parseBreakpoints(fileOf([entry('bp-1', 'up', 100, 'rem', { name: 'Big' }), entry('bp-2', 'down', 64, 'rem', { name: 'big' })]))),
    'breakpoints-name-duplicate',
  );
  const many = Array.from({ length: BREAKPOINT_LIMITS.countMax + 1 }, (_, index) => entry(`bp-${index + 1}`, 'down', 7000 - index * 400, 'px'));
  assert.equal(failureCode(parseBreakpoints(fileOf(many))), 'breakpoints-count');
  assert.equal(parseBreakpoints(fileOf(many.slice(0, BREAKPOINT_LIMITS.countMax))).ok, true);
});

test('wrong shapes, versions and sources are error values, never throws', () => {
  const parsedNull: unknown = JSON.parse('null');
  assert.equal(failureCode(parseBreakpoints(parsedNull)), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints([])), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ version: 4, breakpoints: [] })), 'breakpoints-version');
  assert.equal(failureCode(parseBreakpoints({ breakpoints: [] })), 'breakpoints-version');
  assert.equal(failureCode(parseBreakpointsSource('{ "version": 3, ')), 'breakpoints-unreadable');
  assert.equal(failureCode(parseBreakpointsSource(JSON.stringify({ ...goodFile, note: 'x'.repeat(BREAKPOINT_LIMITS.fileBytesMax) }))), 'breakpoints-limit');
});

test('version 2 (laptop, tablet, phone) reads as version 3 down breakpoints with the same widths', () => {
  const versionTwo = { version: 2, laptop: { value: 1101, unit: 'px' }, tablet: { value: 48, unit: 'rem' }, phone: { value: 30.5, unit: 'rem' } };
  const parsed = parseBreakpointsSource(JSON.stringify(versionTwo));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.map((breakpoint) => [breakpoint.id, breakpoint.direction, formatBreakpoint(breakpoint.setting)]) : [], [
    ['laptop', 'down', '1101px'],
    ['tablet', 'down', '48rem'],
    ['phone', 'down', '30.5rem'],
  ]);
  assert.equal(failureCode(parseBreakpoints({ ...versionTwo, tablet: { value: 90, unit: 'rem' } })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ ...versionTwo, phone: 479 })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...versionTwo, desktop: {} })), 'breakpoints-shape');
});

test('version 1: the old defaults read as the rem defaults, other widths as px one pixel up', () => {
  assert.deepEqual(parseBreakpointsSource(JSON.stringify({ version: 1, laptop: 1023, tablet: 767, phone: 479 })), { ok: true, value: BREAKPOINT_DEFAULT_LIST });
  const parsed = parseBreakpointsSource(JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    resolveBreakpoints(parsed.ok ? parsed.value : []).map((breakpoint) => breakpoint.widthPx),
    [1100, 800, 500],
  );
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 700, tablet: 800, phone: 500 })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: '500' })), 'breakpoints-type');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 500.5 })), 'breakpoints-integer');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 10 })), 'breakpoints-range');
});

test('the serializer writes version 3, byte-stable, and round-trips; an invalid list is a programmer error', () => {
  const text = serializeBreakpoints(withUps);
  assert.ok(text.startsWith('{\n  "version": 3,\n  "breakpoints": [\n'));
  assert.ok(text.endsWith('\n'));
  const parsed = parseBreakpointsSource(text);
  assert.equal(parsed.ok, true);
  assert.equal(serializeBreakpoints(parsed.ok ? parsed.value : []), text);
  assert.ok(!text.includes('"name": undefined') && !/"name":\s*null/.test(text), 'a built-in without a name writes no name');
  assert.equal(serializeBreakpoints([]), '{\n  "version": 3,\n  "breakpoints": []\n}\n');
  assert.throws(() => serializeBreakpoints([...BREAKPOINT_DEFAULT_LIST].reverse()), /Assertion failed: serializeBreakpoints/);
});

test('add inserts by size, remove drops, rename and re-value change one breakpoint, ids and names stay unique', () => {
  const added = withBreakpointAdded(BREAKPOINT_DEFAULT_LIST, large);
  assert.deepEqual(
    added.map((breakpoint) => breakpoint.id),
    ['bp-1', 'laptop', 'tablet', 'phone'],
  );
  const between = withBreakpointAdded(BREAKPOINT_DEFAULT_LIST, { id: 'bp-3', name: 'Mid', direction: 'down', setting: { value: 40, unit: 'rem' } });
  assert.deepEqual(
    between.map((breakpoint) => breakpoint.id),
    ['laptop', 'tablet', 'bp-3', 'phone'],
  );
  assert.equal(checkedList(between).ok, true);
  assert.deepEqual(
    withBreakpointRemoved(withUps, 'tablet').map((breakpoint) => breakpoint.id),
    ['bp-2', 'bp-1', 'laptop', 'phone'],
  );
  assert.deepEqual(withBreakpointRemoved(BREAKPOINT_DEFAULT_LIST, 'nope'), BREAKPOINT_DEFAULT_LIST);
  assert.equal(withBreakpointName(BREAKPOINT_DEFAULT_LIST, 'phone', 'Mobile')[2]?.name, 'Mobile');
  assert.equal(nextBreakpointId(withUps), 'bp-3');
  assert.equal(nextBreakpointId(BREAKPOINT_DEFAULT_LIST), 'bp-1');
  const label = (breakpoint: Breakpoint) => breakpoint.name ?? breakpoint.id;
  assert.equal(uniqueBreakpointName(withUps, 'Large', label), 'Large 2');
  assert.equal(uniqueBreakpointName(withUps, 'large', label), 'large 2', 'names compare without case');
  assert.equal(uniqueBreakpointName(withUps, 'Fresh', label), 'Fresh');
});

test('equality compares ids, names, directions, values and units', () => {
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_LIST, [...BREAKPOINT_DEFAULT_LIST]), true);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_LIST, BREAKPOINT_DEFAULT_LIST.slice(1)), false);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_LIST, withBreakpointSetting(BREAKPOINT_DEFAULT_LIST, 'phone', { value: 480, unit: 'px' })), false);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_LIST, withBreakpointName(BREAKPOINT_DEFAULT_LIST, 'phone', 'Mobile')), false);
});

test('the metadata transport validates the file before any write', () => {
  assert.doesNotThrow(() => validateMetadata('breakpoints', JSON.stringify(goodFile)));
  assert.doesNotThrow(() => validateMetadata('breakpoints', JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 })));
  assert.throws(
    () => validateMetadata('breakpoints', JSON.stringify(fileOf([entry('laptop', 'down', 48, 'rem'), entry('tablet', 'down', 64, 'rem')]))),
    /must be larger/,
  );
  assert.throws(() => validateMetadata('breakpoints', 'not json'), /not valid JSON/);
});
