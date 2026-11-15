// Goal: `.stacki/breakpoints.json` holds Desktop's frame width and an ordered list of breakpoints whose side of Desktop is DERIVED from
// their numbers (wider than Desktop is `up`, `width >= X`, canvas X; narrower is `down`, `width < X`, canvas X - 1; equal is refused);
// the list is strictly decreasing in pixels, Desktop included; every other shape is an error value (never a throw); one resolver turns a
// boundary into a canvas width; typed entries accept exactly `64rem`, `64 rem`, `62.5rem`, `1024px` and a bare number (px); Desktop
// (90rem, 1440px by default) is configurable and is never a media query; and versions 1, 2 and 3 migrate without moving a canvas width.
// Method: resolve the defaults (1023/767/479 around a 1440px Desktop) and table-test the derivation and the resolver for both sides, rem,
// px, decimals and mixed units; parse each good and bad typed entry pinning the error code; parse the good version 4 file and each bad
// shape (ids, names, counts, ordering across Desktop, equal boundaries, extra keys, a stored direction in version 4, wrong version, not
// JSON, oversized); read version 3 files whose stored direction disagrees with the numbers as derived; migrate versions 1, 2 and 3; check
// the serializer is byte-stable, writes no direction and refuses an invalid configuration; move Desktop (blocked when it would flip a
// breakpoint); add, remove and rename; run the metadata transport's validator so a bad write never reaches disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKPOINT_DEFAULTS,
  BREAKPOINT_DEFAULT_CONFIG,
  BREAKPOINT_DEFAULT_LIST,
  BREAKPOINT_LIMITS,
  DESKTOP_DEFAULT,
  boundaryPx,
  breakpointCondition,
  breakpointsEqual,
  canvasWidthPx,
  checkedConfig,
  conflictAt,
  desktopBlocker,
  desktopFramePx,
  directionOf,
  formatBreakpoint,
  nextBreakpointId,
  parseBreakpointEntry,
  parseBreakpoints,
  parseBreakpointsSource,
  resolveBreakpoints,
  sequenceOf,
  serializeBreakpoints,
  uniqueBreakpointName,
  withBreakpointAdded,
  withBreakpointName,
  withBreakpointRemoved,
  withBreakpointSetting,
  withDesktop,
  withSettingInPlace,
} from '#dist/shared/properties/projectBreakpoints.js';
import type { Breakpoint, BreakpointConfig } from '#dist/shared/properties/projectBreakpoints.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const rem = (value: number) => ({ value, unit: 'rem' as const });
const withUps: BreakpointConfig = {
  desktop: DESKTOP_DEFAULT,
  list: [
    { id: 'bp-2', name: 'Huge', direction: 'up', setting: rem(120) },
    { id: 'bp-1', name: 'Large', direction: 'up', setting: rem(100) },
    ...BREAKPOINT_DEFAULT_LIST,
  ],
};

const entry = (id: string, value: unknown, unit: unknown, extra: Record<string, unknown> = {}) => ({ id, value, unit, ...extra });
const fileOf = (breakpoints: unknown, desktop: unknown = { value: 90, unit: 'rem' }) => ({ version: 4, desktop, breakpoints });
const goodFile = fileOf([entry('bp-1', 100, 'rem', { name: 'Large' }), entry('laptop', 64, 'rem'), entry('tablet', 800, 'px'), entry('phone', 30, 'rem')]);

function failureCode(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  assert.equal(result.ok, false);
  return result.error?.code ?? '';
}

test('Desktop is 90rem (1440px) by default; the Lumos breakpoints around it are 64rem, 48rem and 30rem, down, 1023, 767 and 479', () => {
  assert.equal(formatBreakpoint(DESKTOP_DEFAULT), '90rem');
  assert.equal(desktopFramePx(DESKTOP_DEFAULT), 1440);
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
  assert.deepEqual(parseBreakpointsSource(undefined), { ok: true, value: BREAKPOINT_DEFAULT_CONFIG });
  const [huge, large] = withUps.list;
  const [laptop] = BREAKPOINT_DEFAULT_LIST;
  assert.ok(huge && large && laptop);
  assert.equal(breakpointCondition(laptop), 'width < 64rem');
  assert.equal(breakpointCondition(large), 'width >= 100rem');
  assert.equal(breakpointCondition(huge), 'width >= 120rem');
});

test('the side is derived from the number against Desktop: wider is up, narrower is down, equal is neither', () => {
  const desktop = rem(90);
  assert.equal(directionOf(rem(100), desktop), 'up');
  assert.equal(directionOf({ value: 1441, unit: 'px' }, desktop), 'up');
  assert.equal(directionOf(rem(64), desktop), 'down');
  assert.equal(directionOf({ value: 1439, unit: 'px' }, desktop), 'down');
  assert.equal(directionOf(rem(90), desktop), undefined);
  assert.equal(directionOf({ value: 1440, unit: 'px' }, desktop), undefined, 'the same width in the other unit is equal');
  assert.equal(directionOf(rem(64), rem(50)), 'up', 'it follows Desktop when Desktop moves');
});

test('the resolver: down is the boundary less one pixel, up is the boundary itself', () => {
  const widths = (breakpoint: Pick<Breakpoint, 'direction' | 'setting'>) => canvasWidthPx(breakpoint);
  assert.equal(widths({ direction: 'down', setting: rem(64) }), 1023);
  assert.equal(widths({ direction: 'down', setting: { value: 1024, unit: 'px' } }), 1023);
  assert.equal(widths({ direction: 'down', setting: rem(62.5) }), 999);
  assert.equal(widths({ direction: 'up', setting: rem(100) }), 1600);
  assert.equal(widths({ direction: 'up', setting: rem(120) }), 1920);
  assert.equal(widths({ direction: 'up', setting: { value: 1600, unit: 'px' } }), 1600);
  assert.equal(widths({ direction: 'up', setting: rem(62.55) }), 1001, 'the first whole pixel that is in it');
  assert.equal(boundaryPx(rem(62.5)), 1000);
  assert.equal(desktopFramePx(rem(62.5)), 1000);
  assert.deepEqual(
    resolveBreakpoints(withUps.list).map((breakpoint) => [breakpoint.id, breakpoint.widthPx]),
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
    ['64rem', rem(64)],
    ['64 rem', rem(64)],
    [' 62.5rem ', rem(62.5)],
    ['62.5REM', rem(62.5)],
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

test('the known-good version 4 file parses, directions derived, mixed units and names included', () => {
  const parsed = parseBreakpointsSource(JSON.stringify(goodFile));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? formatBreakpoint(parsed.value.desktop) : '', '90rem');
  assert.deepEqual(
    parsed.ok ? parsed.value.list.map((breakpoint) => [breakpoint.id, breakpoint.name, breakpoint.direction, formatBreakpoint(breakpoint.setting)]) : [],
    [
      ['bp-1', 'Large', 'up', '100rem'],
      ['laptop', undefined, 'down', '64rem'],
      ['tablet', undefined, 'down', '800px'],
      ['phone', undefined, 'down', '30rem'],
    ],
  );
  const empty = parseBreakpoints(fileOf([]));
  assert.equal(empty.ok && empty.value.list.length, 0, 'the list may be empty: only Desktop is left');
  const noDesktop = parseBreakpoints({ version: 4, breakpoints: [] });
  assert.equal(noDesktop.ok && formatBreakpoint(noDesktop.value.desktop), '90rem', 'an absent Desktop is 90rem');
});

test('Desktop is configurable in the file, and decides the side of every breakpoint', () => {
  const small = parseBreakpoints(fileOf([entry('bp-1', 100, 'rem'), entry('laptop', 64, 'rem')], { value: 80, unit: 'rem' }));
  assert.equal(small.ok && desktopFramePx(small.value.desktop), 1280);
  assert.equal(failureCode(parseBreakpoints(fileOf([entry('bp-1', 80, 'rem')], { value: 1280, unit: 'px' }))), 'breakpoints-desktop-equal');
  assert.equal(failureCode(parseBreakpoints(fileOf([], { value: 10, unit: 'rem' }))), 'breakpoints-range');
  assert.equal(failureCode(parseBreakpoints(fileOf([], 5))), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints(fileOf([], { value: 90, unit: 'rem', extra: 1 }))), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints(fileOf([], { value: 90, unit: 'em' }))), 'breakpoints-unit');
});

test('ordering: strictly decreasing across Desktop, equal boundaries refused', () => {
  const list = (...entries: ReturnType<typeof entry>[]) => fileOf(entries);
  assert.equal(failureCode(parseBreakpoints(list(entry('laptop', 48, 'rem'), entry('tablet', 64, 'rem')))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(list(entry('laptop', 64, 'rem'), entry('tablet', 64, 'rem')))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(list(entry('laptop', 64, 'rem'), entry('bp-1', 100, 'rem')))), 'breakpoints-order', 'a wider one comes first');
  assert.equal(failureCode(parseBreakpoints(list(entry('bp-1', 100, 'rem'), entry('bp-2', 120, 'rem')))), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints(list(entry('bp-1', 90, 'rem')))), 'breakpoints-desktop-equal');
  assert.equal(failureCode(parseBreakpoints(list(entry('bp-1', 1440, 'px')))), 'breakpoints-desktop-equal');
  assert.equal(parseBreakpoints(list(entry('bp-1', 91, 'rem'), entry('laptop', 89, 'rem'))).ok, true);
  assert.equal(
    failureCode(parseBreakpoints(list(entry('bp-1', 100, 'rem'), entry('laptop', 1600, 'px')))),
    'breakpoints-order',
    'by pixels, whatever the units',
  );
  const tablet = withSettingInPlace(BREAKPOINT_DEFAULT_CONFIG, 'tablet', rem(64));
  assert.equal(conflictAt(tablet, 'tablet')?.relation, 'smaller');
  assert.equal(conflictAt(withSettingInPlace(BREAKPOINT_DEFAULT_CONFIG, 'laptop', rem(40)), 'laptop')?.relation, 'larger');
  assert.equal(conflictAt(BREAKPOINT_DEFAULT_CONFIG, 'tablet'), undefined);
  const aboveDesktop = conflictAt(withSettingInPlace(BREAKPOINT_DEFAULT_CONFIG, 'laptop', rem(95)), 'laptop');
  assert.equal(aboveDesktop?.against.id, 'desktop', 'a narrower breakpoint cannot be set above Desktop');
  assert.equal(aboveDesktop?.relation, 'smaller');
  const belowDesktop = conflictAt(withSettingInPlace(withUps, 'bp-1', rem(80)), 'bp-1');
  assert.equal(belowDesktop?.against.id, 'desktop');
  assert.equal(belowDesktop?.relation, 'larger', 'a wider breakpoint cannot be set below Desktop');
});

test('moving Desktop is allowed only between the largest narrower and the smallest wider breakpoint', () => {
  assert.equal(desktopBlocker(withUps, rem(80)), undefined, 'between 64rem and 100rem');
  assert.equal(desktopBlocker(withUps, rem(110))?.id, 'bp-1', 'past the smallest wider one');
  assert.equal(desktopBlocker(withUps, rem(70)), undefined, '70rem is above 64rem and below 100rem');
  assert.equal(desktopBlocker(withUps, rem(100))?.id, 'bp-1', 'equal to the smallest wider one');
  assert.equal(desktopBlocker(withUps, rem(130))?.direction, 'up');
  assert.equal(desktopBlocker(withUps, rem(64))?.id, 'laptop', 'equal to the largest narrower one');
  assert.equal(desktopBlocker(withUps, rem(40))?.direction, 'down', 'below a narrower one');
  assert.equal(desktopBlocker(BREAKPOINT_DEFAULT_CONFIG, rem(200)), undefined, 'with nothing wider there is nothing to flip');
  const moved = withDesktop(withUps, rem(80));
  assert.equal(
    moved.list.every((breakpoint, index) => breakpoint.direction === withUps.list[index]?.direction),
    true,
  );
  assert.equal(checkedConfig(moved).ok, true);
});

test('bad entries are refused: ids, names, values, units, keys', () => {
  const one = (changes: Record<string, unknown>) => parseBreakpoints(fileOf([{ ...entry('bp-1', 100, 'rem'), ...changes }]));
  assert.equal(failureCode(one({ id: 5 })), 'breakpoints-id');
  assert.equal(failureCode(one({ id: 'Bad Id' })), 'breakpoints-id');
  assert.equal(failureCode(one({ id: 'desktop' })), 'breakpoints-id', 'Desktop is not a breakpoint');
  assert.equal(failureCode(one({ id: 'a'.repeat(BREAKPOINT_LIMITS.idCharsMax + 1) })), 'breakpoints-id');
  assert.equal(failureCode(one({ name: 5 })), 'breakpoints-name');
  assert.equal(failureCode(one({ name: '' })), 'breakpoints-name');
  assert.equal(failureCode(one({ name: 'x'.repeat(BREAKPOINT_LIMITS.nameCharsMax + 1) })), 'breakpoints-name');
  assert.equal(failureCode(one({ name: 'tab\there' })), 'breakpoints-name');
  assert.equal(failureCode(one({ value: 0 })), 'breakpoints-range');
  assert.equal(failureCode(one({ value: 1e15 })), 'breakpoints-range');
  assert.equal(failureCode(one({ value: '100' })), 'breakpoints-type');
  assert.equal(failureCode(one({ value: Number.NaN })), 'breakpoints-type');
  assert.equal(failureCode(one({ unit: 'em' })), 'breakpoints-unit');
  assert.equal(failureCode(one({ unit: 'px', value: 1600.5 })), 'breakpoints-pxWhole');
  assert.equal(failureCode(one({ extra: 1 })), 'breakpoints-shape');
  assert.equal(failureCode(one({ direction: 'up' })), 'breakpoints-shape', 'version 4 has no stored direction');
  assert.equal(failureCode(parseBreakpoints(fileOf([5]))), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints(fileOf('x'))), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...fileOf([]), note: 1 })), 'breakpoints-shape');
});

test('ids and names must be unique, and the count is bounded', () => {
  assert.equal(failureCode(parseBreakpoints(fileOf([entry('bp-1', 100, 'rem'), entry('bp-1', 64, 'rem')]))), 'breakpoints-duplicate');
  assert.equal(
    failureCode(parseBreakpoints(fileOf([entry('bp-1', 100, 'rem', { name: 'Big' }), entry('bp-2', 64, 'rem', { name: 'big' })]))),
    'breakpoints-name-duplicate',
  );
  const many = Array.from({ length: BREAKPOINT_LIMITS.countMax + 1 }, (_, index) => entry(`bp-${index + 1}`, 7000 - index * 400, 'px'));
  assert.equal(failureCode(parseBreakpoints(fileOf(many))), 'breakpoints-count');
  assert.equal(parseBreakpoints(fileOf(many.slice(0, BREAKPOINT_LIMITS.countMax))).ok, true);
});

test('wrong shapes, versions and sources are error values, never throws', () => {
  const parsedNull: unknown = JSON.parse('null');
  assert.equal(failureCode(parseBreakpoints(parsedNull)), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints([])), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ version: 5, breakpoints: [] })), 'breakpoints-version');
  assert.equal(failureCode(parseBreakpoints({ breakpoints: [] })), 'breakpoints-version');
  assert.equal(failureCode(parseBreakpointsSource('{ "version": 4, ')), 'breakpoints-unreadable');
  assert.equal(failureCode(parseBreakpointsSource(JSON.stringify({ ...goodFile, note: 'x'.repeat(BREAKPOINT_LIMITS.fileBytesMax) }))), 'breakpoints-limit');
});

test('version 3 (stored directions) reads at the same widths; a stored direction that disagrees is read as derived, with no rewrite', () => {
  const versionThree = (breakpoints: unknown) => ({ version: 3, breakpoints });
  const stored = (id: string, direction: string, value: number) => ({ id, direction, value, unit: 'rem' });
  const agree = parseBreakpoints(versionThree([stored('bp-1', 'up', 100), stored('laptop', 'down', 64)]));
  assert.equal(agree.ok && formatBreakpoint(agree.value.desktop), '90rem', 'Desktop is 90rem when the file had none');
  assert.deepEqual(agree.ok ? agree.value.list.map((breakpoint) => [breakpoint.id, breakpoint.direction]) : [], [
    ['bp-1', 'up'],
    ['laptop', 'down'],
  ]);
  const disagree = parseBreakpoints(versionThree([stored('bp-1', 'down', 100), stored('laptop', 'up', 64)]));
  assert.deepEqual(
    disagree.ok ? disagree.value.list.map((breakpoint) => [breakpoint.id, breakpoint.direction]) : [],
    [
      ['bp-1', 'up'],
      ['laptop', 'down'],
    ],
    'the numbers decide, not the stored word',
  );
  assert.equal(failureCode(parseBreakpoints(versionThree([{ id: 'bp-1', value: 100, unit: 'rem' }]))), 'breakpoints-direction', 'version 3 had to say one');
  assert.equal(failureCode(parseBreakpoints({ ...versionThree([]), desktop: { value: 90, unit: 'rem' } })), 'breakpoints-shape', 'version 3 has no desktop');
});

test('version 2 (laptop, tablet, phone) reads as down breakpoints around the default Desktop, with the same widths', () => {
  const versionTwo = { version: 2, laptop: { value: 1101, unit: 'px' }, tablet: rem(48), phone: rem(30.5) };
  const parsed = parseBreakpointsSource(JSON.stringify(versionTwo));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.list.map((breakpoint) => [breakpoint.id, breakpoint.direction, formatBreakpoint(breakpoint.setting)]) : [], [
    ['laptop', 'down', '1101px'],
    ['tablet', 'down', '48rem'],
    ['phone', 'down', '30.5rem'],
  ]);
  assert.equal(failureCode(parseBreakpoints({ ...versionTwo, tablet: rem(100) })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ ...versionTwo, phone: 479 })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...versionTwo, desktop: {} })), 'breakpoints-shape');
});

test('version 1: the old defaults read as the rem defaults, other widths as px one pixel up', () => {
  assert.deepEqual(parseBreakpointsSource(JSON.stringify({ version: 1, laptop: 1023, tablet: 767, phone: 479 })), {
    ok: true,
    value: BREAKPOINT_DEFAULT_CONFIG,
  });
  const parsed = parseBreakpointsSource(JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    resolveBreakpoints(parsed.ok ? parsed.value.list : []).map((breakpoint) => breakpoint.widthPx),
    [1100, 800, 500],
  );
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 700, tablet: 800, phone: 500 })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: '500' })), 'breakpoints-type');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 500.5 })), 'breakpoints-integer');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 10 })), 'breakpoints-range');
});

test('the serializer writes version 4 with Desktop and no direction, byte-stable, and round-trips; an invalid configuration is a programmer error', () => {
  const text = serializeBreakpoints(withUps);
  assert.ok(text.startsWith('{\n  "version": 4,\n  "desktop": {\n    "value": 90,\n    "unit": "rem"\n  },\n  "breakpoints": [\n'));
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes('"direction"'), 'the direction is derived, never written');
  const parsed = parseBreakpointsSource(text);
  assert.equal(parsed.ok, true);
  assert.equal(serializeBreakpoints(parsed.ok ? parsed.value : BREAKPOINT_DEFAULT_CONFIG), text);
  assert.deepEqual(parsed.ok && parsed.value, withUps);
  assert.ok(!/"name":\s*(null|undefined)/.test(text), 'a built-in without a name writes no name');
  assert.equal(
    serializeBreakpoints({ desktop: DESKTOP_DEFAULT, list: [] }),
    '{\n  "version": 4,\n  "desktop": {\n    "value": 90,\n    "unit": "rem"\n  },\n  "breakpoints": []\n}\n',
  );
  assert.throws(
    () => serializeBreakpoints({ desktop: DESKTOP_DEFAULT, list: [...BREAKPOINT_DEFAULT_LIST].reverse() }),
    /Assertion failed: serializeBreakpoints/,
  );
  assert.throws(
    () => serializeBreakpoints({ desktop: rem(64), list: BREAKPOINT_DEFAULT_LIST }),
    /Assertion failed: serializeBreakpoints/,
    'a breakpoint equal to Desktop',
  );
});

test('add inserts by size and derives the side, remove drops, rename and re-value change one breakpoint, ids and names stay unique', () => {
  const large = { id: 'bp-1', name: 'Large', setting: rem(100) };
  const added = withBreakpointAdded(BREAKPOINT_DEFAULT_CONFIG, large);
  assert.deepEqual(
    added.list.map((breakpoint) => [breakpoint.id, breakpoint.direction]),
    [
      ['bp-1', 'up'],
      ['laptop', 'down'],
      ['tablet', 'down'],
      ['phone', 'down'],
    ],
  );
  const between = withBreakpointAdded(BREAKPOINT_DEFAULT_CONFIG, { id: 'bp-3', name: 'Mid', setting: rem(40) });
  assert.deepEqual(
    between.list.map((breakpoint) => breakpoint.id),
    ['laptop', 'tablet', 'bp-3', 'phone'],
  );
  assert.equal(between.list[2]?.direction, 'down');
  assert.equal(checkedConfig(between).ok, true);
  const first = withBreakpointAdded(BREAKPOINT_DEFAULT_CONFIG, { id: 'bp-4', name: 'Wide', setting: { value: 2000, unit: 'px' } });
  assert.equal(first.list[0]?.direction, 'up', 'a number wider than Desktop needs no direction');
  assert.deepEqual(
    withBreakpointRemoved(withUps, 'tablet').list.map((breakpoint) => breakpoint.id),
    ['bp-2', 'bp-1', 'laptop', 'phone'],
  );
  assert.deepEqual(withBreakpointRemoved(BREAKPOINT_DEFAULT_CONFIG, 'nope'), BREAKPOINT_DEFAULT_CONFIG);
  assert.equal(withBreakpointName(BREAKPOINT_DEFAULT_CONFIG, 'phone', 'Mobile').list[2]?.name, 'Mobile');
  assert.equal(withBreakpointSetting(BREAKPOINT_DEFAULT_CONFIG, 'phone', rem(40)).list[2]?.setting.value, 40);
  assert.equal(nextBreakpointId(withUps.list), 'bp-3');
  assert.equal(nextBreakpointId(BREAKPOINT_DEFAULT_LIST), 'bp-1');
  const label = (breakpoint: Breakpoint) => breakpoint.name ?? breakpoint.id;
  assert.equal(uniqueBreakpointName(withUps.list, 'Large', label), 'Large 2');
  assert.equal(uniqueBreakpointName(withUps.list, 'large', label), 'large 2', 'names compare without case');
  assert.equal(uniqueBreakpointName(withUps.list, 'Fresh', label), 'Fresh');
  assert.deepEqual(
    sequenceOf(withUps).map((place) => place.id),
    ['bp-2', 'bp-1', 'desktop', 'laptop', 'tablet', 'phone'],
  );
});

test('equality compares Desktop, ids, names and numbers, not the derived side', () => {
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_CONFIG, { ...BREAKPOINT_DEFAULT_CONFIG, list: [...BREAKPOINT_DEFAULT_LIST] }), true);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_CONFIG, withBreakpointRemoved(BREAKPOINT_DEFAULT_CONFIG, 'phone')), false);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_CONFIG, withBreakpointSetting(BREAKPOINT_DEFAULT_CONFIG, 'phone', { value: 480, unit: 'px' })), false);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_CONFIG, withBreakpointName(BREAKPOINT_DEFAULT_CONFIG, 'phone', 'Mobile')), false);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_CONFIG, withDesktop(BREAKPOINT_DEFAULT_CONFIG, rem(80))), false);
});

test('the metadata transport validates the file before any write', () => {
  assert.doesNotThrow(() => validateMetadata('breakpoints', JSON.stringify(goodFile)));
  assert.doesNotThrow(() => validateMetadata('breakpoints', JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 })));
  assert.throws(() => validateMetadata('breakpoints', JSON.stringify(fileOf([entry('laptop', 48, 'rem'), entry('tablet', 64, 'rem')]))), /must be larger/);
  assert.throws(() => validateMetadata('breakpoints', 'not json'), /not valid JSON/);
});
