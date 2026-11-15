// Goal: `.stacki/breakpoints.json` parses only into three breakpoints (a value in rem or px each) that are in the canvas's
// range and strictly decreasing from laptop to phone once converted to pixels (1rem = 16px); every other shape is an error
// value (never a throw); the one resolver turns `width < X` into the canvas width one pixel below X; typed entries accept
// exactly `64rem`, `64 rem`, `62.5rem`, `1024px` and a bare number (px); and a version 1 pixel file migrates without moving
// any canvas width.
// Method: resolve the defaults (1023/767/479), table-test the resolver for rem, px, decimals and mixed units; parse each good
// and bad typed entry pinning the error code; parse the good version 2 file and each bad shape (not decreasing, equal, zero,
// negative, float px, huge, tiny, wrong types, wrong unit, extra keys, wrong version, not JSON, oversized); migrate version 1
// files (the old defaults, and custom widths); check the serializer is byte-stable and refuses an invalid set; run the
// metadata transport's validator so a bad write never reaches disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKPOINT_DEFAULTS,
  BREAKPOINT_DEFAULT_SETTINGS,
  BREAKPOINT_LIMITS,
  boundaryPx,
  breakpointCondition,
  breakpointsEqual,
  canvasWidthPx,
  firstOutOfOrder,
  formatBreakpoint,
  parseBreakpointEntry,
  parseBreakpoints,
  parseBreakpointsSource,
  resolveBreakpointWidths,
  serializeBreakpoints,
} from '#dist/shared/properties/projectBreakpoints.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const good = {
  version: 2,
  laptop: { value: 1100, unit: 'px' },
  tablet: { value: 48, unit: 'rem' },
  phone: { value: 30.5, unit: 'rem' },
};

function failureCode(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  assert.equal(result.ok, false);
  return result.error?.code ?? '';
}

test('the defaults are 64rem, 48rem and 30rem, which resolve to 1023, 767 and 479', () => {
  assert.deepEqual(BREAKPOINT_DEFAULT_SETTINGS, { laptop: { value: 64, unit: 'rem' }, tablet: { value: 48, unit: 'rem' }, phone: { value: 30, unit: 'rem' } });
  assert.deepEqual(BREAKPOINT_DEFAULTS, { laptop: 1023, tablet: 767, phone: 479 });
  assert.deepEqual(parseBreakpointsSource(undefined), { ok: true, value: BREAKPOINT_DEFAULT_SETTINGS });
  const { laptop, tablet, phone } = BREAKPOINT_DEFAULT_SETTINGS;
  assert.deepEqual([formatBreakpoint(laptop), formatBreakpoint(tablet), formatBreakpoint(phone)], ['64rem', '48rem', '30rem']);
  assert.equal(breakpointCondition(BREAKPOINT_DEFAULT_SETTINGS.laptop), 'width < 64rem');
});

test('the resolver is the boundary one pixel down, in whole pixels, for either unit', () => {
  assert.equal(canvasWidthPx({ value: 64, unit: 'rem' }), 1023);
  assert.equal(canvasWidthPx({ value: 48, unit: 'rem' }), 767);
  assert.equal(canvasWidthPx({ value: 30, unit: 'rem' }), 479);
  assert.equal(canvasWidthPx({ value: 1024, unit: 'px' }), 1023);
  assert.equal(canvasWidthPx({ value: 62.5, unit: 'rem' }), 999);
  assert.equal(canvasWidthPx({ value: 30.03, unit: 'rem' }), 480);
  assert.equal(boundaryPx({ value: 62.5, unit: 'rem' }), 1000);
  assert.deepEqual(resolveBreakpointWidths({ laptop: { value: 1100, unit: 'px' }, tablet: { value: 48, unit: 'rem' }, phone: { value: 400, unit: 'px' } }), {
    laptop: 1099,
    tablet: 767,
    phone: 399,
  });
});

test('typed entries: rem, px, spaces, decimals and a bare number (px)', () => {
  const entries: ReadonlyArray<readonly [string, unknown]> = [
    ['64rem', { value: 64, unit: 'rem' }],
    ['64 rem', { value: 64, unit: 'rem' }],
    [' 62.5rem ', { value: 62.5, unit: 'rem' }],
    ['62.5REM', { value: 62.5, unit: 'rem' }],
    ['1024px', { value: 1024, unit: 'px' }],
    ['1024 px', { value: 1024, unit: 'px' }],
    ['1024', { value: 1024, unit: 'px' }],
  ];
  for (const [text, expected] of entries) {
    assert.deepEqual(parseBreakpointEntry(text), { ok: true, value: expected }, text);
  }
});

test('typed entries that are not a width are refused with the code that says what to fix', () => {
  for (const text of ['', '   ', 'rem', 'abc', '64em', '64vw', '-64rem', '+64rem', '.5rem', '1e3', '1,024px', '64rem;', '64 rem rem', '64rem 48rem', '0x40']) {
    assert.equal(failureCode(parseBreakpointEntry(text)), 'breakpoints-syntax', JSON.stringify(text));
  }
  assert.equal(failureCode(parseBreakpointEntry('1000.5px')), 'breakpoints-pxWhole');
  assert.equal(failureCode(parseBreakpointEntry('1000.5')), 'breakpoints-pxWhole');
  assert.equal(failureCode(parseBreakpointEntry('62.55555rem')), 'breakpoints-syntax');
  assert.equal(failureCode(parseBreakpointEntry('9'.repeat(BREAKPOINT_LIMITS.entryCharsMax + 1))), 'breakpoints-syntax');
});

test('typed entries outside the canvas range are refused, and the limits themselves are accepted', () => {
  for (const text of ['0', '0rem', '280px', '17rem', '1px', '7682px', '481rem', '99999px']) {
    assert.equal(failureCode(parseBreakpointEntry(text)), 'breakpoints-range', text);
  }
  assert.equal(parseBreakpointEntry('281px').ok, true);
  assert.equal(parseBreakpointEntry('7681px').ok, true);
  assert.equal(canvasWidthPx({ value: BREAKPOINT_LIMITS.boundaryPxMin, unit: 'px' }), 280);
  assert.equal(canvasWidthPx({ value: BREAKPOINT_LIMITS.boundaryPxMax, unit: 'px' }), 7680);
});

test('the known-good file parses and keeps its values and units, mixed units included', () => {
  const parsed = parseBreakpointsSource(JSON.stringify(good));
  assert.deepEqual(parsed, { ok: true, value: { laptop: good.laptop, tablet: good.tablet, phone: good.phone } });
});

test('rows that do not decrease are refused, by pixels, whatever the units', () => {
  assert.equal(failureCode(parseBreakpoints({ ...good, laptop: { value: 700, unit: 'px' } })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ ...good, laptop: { value: 48, unit: 'rem' } })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ ...good, laptop: { value: 768, unit: 'px' } })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 768, unit: 'px' } })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 48, unit: 'rem' } })), 'breakpoints-order');
  const settings = { laptop: { value: 48, unit: 'rem' }, tablet: { value: 768, unit: 'px' }, phone: { value: 30, unit: 'rem' } } as const;
  assert.equal(firstOutOfOrder(settings), 'tablet');
  assert.equal(firstOutOfOrder(BREAKPOINT_DEFAULT_SETTINGS), undefined);
  assert.equal(firstOutOfOrder({ ...BREAKPOINT_DEFAULT_SETTINGS, phone: { value: 800, unit: 'px' } }), 'phone');
});

test('bad values in a version 2 file are refused', () => {
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 0, unit: 'rem' } })), 'breakpoints-range');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: -30, unit: 'rem' } })), 'breakpoints-range');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 479.5, unit: 'px' } })), 'breakpoints-pxWhole');
  assert.equal(failureCode(parseBreakpoints({ ...good, laptop: { value: 1e15, unit: 'px' } })), 'breakpoints-range');
  assert.equal(failureCode(parseBreakpoints({ ...good, laptop: { value: Number.POSITIVE_INFINITY, unit: 'px' } })), 'breakpoints-type');
  assert.equal(failureCode(parseBreakpoints({ ...good, laptop: { value: Number.NaN, unit: 'px' } })), 'breakpoints-type');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: '30', unit: 'rem' } })), 'breakpoints-type');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 30, unit: 'em' } })), 'breakpoints-unit');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 30 } })), 'breakpoints-unit');
});

test('wrong shapes, extra keys and wrong versions are refused', () => {
  const parsedNull: unknown = JSON.parse('null');
  assert.equal(failureCode(parseBreakpoints(parsedNull)), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints([])), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints('64rem')), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: 479 })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: undefined })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...good, phone: { value: 30, unit: 'rem', note: 'x' } })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...good, desktop: { value: 90, unit: 'rem' } })), 'breakpoints-shape');
  assert.equal(failureCode(parseBreakpoints({ ...good, version: 3 })), 'breakpoints-version');
  assert.equal(failureCode(parseBreakpoints({ laptop: good.laptop, tablet: good.tablet, phone: good.phone })), 'breakpoints-version');
});

test('unreadable and oversized sources are error values, never throws', () => {
  assert.equal(failureCode(parseBreakpointsSource('{ "version": 2, ')), 'breakpoints-unreadable');
  assert.equal(failureCode(parseBreakpointsSource(JSON.stringify({ ...good, note: 'x'.repeat(BREAKPOINT_LIMITS.fileBytesMax) }))), 'breakpoints-limit');
});

test('version 1: exactly the old defaults read as the rem defaults', () => {
  const parsed = parseBreakpointsSource(JSON.stringify({ version: 1, laptop: 1023, tablet: 767, phone: 479 }));
  assert.deepEqual(parsed, { ok: true, value: BREAKPOINT_DEFAULT_SETTINGS });
});

test('version 1: other widths become px entries one pixel up, so no canvas width moves', () => {
  const parsed = parseBreakpointsSource(JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 }));
  assert.deepEqual(parsed, { ok: true, value: { laptop: { value: 1101, unit: 'px' }, tablet: { value: 801, unit: 'px' }, phone: { value: 501, unit: 'px' } } });
  assert.deepEqual(resolveBreakpointWidths(parsed.ok ? parsed.value : BREAKPOINT_DEFAULT_SETTINGS), { laptop: 1100, tablet: 800, phone: 500 });
});

test('version 1: bad files are refused like version 2', () => {
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 700, tablet: 800, phone: 500 })), 'breakpoints-order');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: '500' })), 'breakpoints-type');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 500.5 })), 'breakpoints-integer');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 10 })), 'breakpoints-range');
  assert.equal(failureCode(parseBreakpoints({ version: 1, laptop: 1100, tablet: 800, phone: 500, extra: 1 })), 'breakpoints-shape');
});

test('the serializer writes version 2, byte-stable, and round-trips', () => {
  const text = serializeBreakpoints(BREAKPOINT_DEFAULT_SETTINGS);
  assert.equal(
    text,
    '{\n  "version": 2,\n  "laptop": {\n    "value": 64,\n    "unit": "rem"\n  },\n  "tablet": {\n    "value": 48,\n    "unit": "rem"\n  },\n  "phone": {\n    "value": 30,\n    "unit": "rem"\n  }\n}\n',
  );
  const parsed = parseBreakpointsSource(text);
  assert.equal(parsed.ok, true);
  assert.equal(serializeBreakpoints(parsed.ok ? parsed.value : BREAKPOINT_DEFAULT_SETTINGS), text);
});

test('an invalid set cannot be serialized: that is a programmer error and crashes', () => {
  assert.throws(() => serializeBreakpoints({ ...BREAKPOINT_DEFAULT_SETTINGS, laptop: { value: 10, unit: 'rem' } }), /Assertion failed: serializeBreakpoints/);
  assert.throws(() => serializeBreakpoints({ ...BREAKPOINT_DEFAULT_SETTINGS, phone: { value: 0, unit: 'px' } }), /Assertion failed: serializeBreakpoints/);
});

test('equality compares values and units', () => {
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_SETTINGS, { ...BREAKPOINT_DEFAULT_SETTINGS }), true);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_SETTINGS, { ...BREAKPOINT_DEFAULT_SETTINGS, phone: { value: 480, unit: 'px' } }), false);
  assert.equal(breakpointsEqual(BREAKPOINT_DEFAULT_SETTINGS, { ...BREAKPOINT_DEFAULT_SETTINGS, laptop: { value: 1024, unit: 'px' } }), false);
});

test('the metadata transport validates the file before any write', () => {
  assert.doesNotThrow(() => validateMetadata('breakpoints', JSON.stringify(good)));
  assert.doesNotThrow(() => validateMetadata('breakpoints', JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 })));
  assert.throws(() => validateMetadata('breakpoints', JSON.stringify({ ...good, tablet: { value: 90, unit: 'rem' } })), /tablet must be smaller than laptop/);
  assert.throws(() => validateMetadata('breakpoints', 'not json'), /not valid JSON/);
});
