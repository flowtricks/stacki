// Goal: the update popup's progress model never shows a number that is wrong, and the update channels refuse anything that is not
// the declared shape. The bar only moves forward, stays between 0% and 100%, and a download of unknown length is honest about it.
// Method: advanceProgress is fed the reports electron-updater can produce (ordinary, NaN, negative, infinite, past the total, going
// backwards, total changing or absent) and each result is checked against the invariants; the parsers get one known-good value per
// state and each known-bad shape (wrong kind, mismatched percent, transferred above total, oversized text, unknown enum value).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceProgress,
  megabytesOf,
  nextUpdateHidden,
  NO_DOWNLOAD_PROGRESS,
  parseDownloadProgress,
  parseUpdateAction,
  parseUpdateEvent,
  parseUpdateState,
  percentOf,
  progressChangesDisplay,
  UPDATE_BYTES_MAX,
} from '#dist/shared/ipc/updateState.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const MEGABYTE = 1024 * 1024;

test('percent is a floor held between 0 and 100, and 0 while the total is unknown', () => {
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentOf(99, 100), 99);
  assert.equal(percentOf(100, 100), 100);
  assert.equal(percentOf(199, 200), 99, 'floored: 100% only when every byte is in');
  assert.equal(percentOf(500, 100), 100, 'bytes past the total cannot pass 100%');
  assert.equal(percentOf(50, undefined), 0);
  assert.throws(() => percentOf(Number.NaN, 100), /safe integer/);
  assert.throws(() => percentOf(-1, 100), /not negative/);
  assert.throws(() => percentOf(1.5, 100), /safe integer/);
  assert.throws(() => percentOf(1, 0), /positive/);
});

test('progress advances with the updater and ignores reports that are not byte counts', () => {
  let progress = advanceProgress(NO_DOWNLOAD_PROGRESS, { transferred: 25 * MEGABYTE, total: 100 * MEGABYTE });
  assert.deepEqual(progress, { transferredBytes: 25 * MEGABYTE, totalBytes: 100 * MEGABYTE, percent: 25 });

  const hostile: readonly unknown[] = [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'ten', undefined, {}, UPDATE_BYTES_MAX + 1];
  for (const bad of hostile) {
    const after = advanceProgress(progress, { transferred: bad, total: bad });
    assert.deepEqual(after, progress, `a report of ${String(bad)} changes nothing`);
  }

  progress = advanceProgress(progress, { transferred: 60 * MEGABYTE, total: 100 * MEGABYTE });
  assert.equal(progress.percent, 60);
});

test('the bar and the bytes never go backwards, and never pass the total', () => {
  const start = advanceProgress(NO_DOWNLOAD_PROGRESS, { transferred: 80, total: 100 });
  const regressed = advanceProgress(start, { transferred: 10, total: 100 });
  assert.equal(regressed.transferredBytes, 80);
  assert.equal(regressed.percent, 80);

  const over = advanceProgress(start, { transferred: 400, total: 100 });
  assert.equal(over.transferredBytes, 100);
  assert.equal(over.percent, 100);

  const shrunkenTotal = advanceProgress(start, { transferred: 90, total: 95 });
  assert.ok(shrunkenTotal.percent >= 80, 'a smaller total never lowers the percent');
});

test('an unknown total stays 0% and keeps counting bytes; a later total fills the bar in', () => {
  let progress = advanceProgress(NO_DOWNLOAD_PROGRESS, { transferred: 5 * MEGABYTE, total: Number.NaN });
  assert.deepEqual(progress, { transferredBytes: 5 * MEGABYTE, totalBytes: undefined, percent: 0 });
  progress = advanceProgress(progress, { transferred: 6 * MEGABYTE, total: 0 });
  assert.equal(progress.totalBytes, undefined, 'a total of 0 is "unknown", not a zero-byte download');
  assert.equal(progress.transferredBytes, 6 * MEGABYTE);
  progress = advanceProgress(progress, { transferred: 6 * MEGABYTE, total: 12 * MEGABYTE });
  assert.equal(progress.percent, 50);
  const remembered = advanceProgress(progress, { transferred: 7 * MEGABYTE, total: Number.NaN });
  assert.equal(remembered.totalBytes, 12 * MEGABYTE, 'a known total is remembered when a report omits it');
});

test('the counter shows megabytes to one decimal and only asks for a redraw when it would change', () => {
  assert.equal(megabytesOf(0), 0);
  assert.equal(megabytesOf(Math.round(48.2 * MEGABYTE)), 48.2);
  assert.equal(megabytesOf(Math.round(52.44 * MEGABYTE)), 52.4);
  assert.throws(() => megabytesOf(-1), /not negative/);
  assert.throws(() => megabytesOf(Number.NaN), /safe integer/);

  const base = advanceProgress(NO_DOWNLOAD_PROGRESS, { transferred: 10 * MEGABYTE, total: 1000 * MEGABYTE });
  const sameTenth = advanceProgress(base, { transferred: 10 * MEGABYTE + 1000, total: 1000 * MEGABYTE });
  assert.equal(progressChangesDisplay(base, sameTenth), false);
  const nextTenth = advanceProgress(base, { transferred: 10.2 * MEGABYTE, total: 1000 * MEGABYTE });
  assert.equal(progressChangesDisplay(base, nextTenth), true);
  const nextPercent = advanceProgress(base, { transferred: 20 * MEGABYTE, total: 1000 * MEGABYTE });
  assert.equal(progressChangesDisplay(base, nextPercent), true);
});

test('a download progress value parses only when its parts agree', () => {
  const good = { transferredBytes: 50, totalBytes: 200, percent: 25 };
  assert.deepEqual(parseDownloadProgress(good), good);
  assert.deepEqual(parseDownloadProgress({ transferredBytes: 7, percent: 0 }), { transferredBytes: 7, totalBytes: undefined, percent: 0 });
  const bad: readonly unknown[] = [
    undefined,
    'x',
    { ...good, percent: 26 },
    { ...good, percent: 101 },
    { ...good, percent: -1 },
    { ...good, percent: Number.NaN },
    { ...good, transferredBytes: 300 },
    { ...good, transferredBytes: -1 },
    { ...good, transferredBytes: 1.5 },
    { ...good, totalBytes: 0 },
    { ...good, totalBytes: UPDATE_BYTES_MAX + 1 },
    { ...good, totalBytes: '200' },
    { transferredBytes: 7, percent: 3 },
  ];
  for (const input of bad) {
    assert.throws(() => parseDownloadProgress(input), Error, JSON.stringify(input));
  }
});

test('every update state parses, and malformed ones are refused', () => {
  const progress = { transferredBytes: 1, totalBytes: 4, percent: 25 };
  const good = [
    { kind: 'idle' },
    { kind: 'downloading', version: '1.4.10', progress },
    { kind: 'downloading', progress },
    { kind: 'ready', version: '1.4.10' },
    { kind: 'notice', notice: 'latest', version: '1.4.9' },
    { kind: 'notice', notice: 'development', version: '1.4.9' },
    { kind: 'notice', notice: 'alreadyChecking', version: '1.4.9' },
    { kind: 'error', stage: 'check', detail: 'HttpError: 403' },
    { kind: 'error', stage: 'download', detail: '' },
  ];
  for (const input of good) {
    // JSON drops an absent version, so the round trip is the whole comparison.
    assert.equal(JSON.stringify(parseUpdateState(input)), JSON.stringify(input));
  }
  const bad: readonly unknown[] = [
    undefined,
    'ready',
    {},
    { kind: 'unknown' },
    { kind: 'downloading', version: '1', progress: { ...progress, percent: 99 } },
    { kind: 'downloading', version: '', progress },
    { kind: 'downloading', version: 'v'.repeat(65), progress },
    { kind: 'downloading', version: 3, progress },
    { kind: 'ready' },
    { kind: 'ready', version: '' },
    { kind: 'notice', notice: 'nope', version: '1' },
    { kind: 'error', stage: 'install', detail: 'x' },
    { kind: 'error', stage: 'check' },
  ];
  for (const input of bad) {
    assert.throws(() => parseUpdateState(input), Error, JSON.stringify(input));
  }
  assert.equal(parseUpdateState({ kind: 'error', stage: 'check', detail: 'e'.repeat(5000) }).kind, 'error');
  const parsed = parseUpdateState({ kind: 'error', stage: 'check', detail: 'e'.repeat(5000) });
  assert.ok(parsed.kind === 'error' && parsed.detail.length === 200, 'a long detail is cut to the bound');
});

test('an update event carries a boolean reveal and a valid state', () => {
  assert.deepEqual(parseUpdateEvent({ state: { kind: 'ready', version: '2.0.0' }, reveal: true }), {
    state: { kind: 'ready', version: '2.0.0' },
    reveal: true,
  });
  for (const input of [
    undefined,
    {},
    { state: { kind: 'ready', version: '2' } },
    { state: { kind: 'ready', version: '2' }, reveal: 'yes' },
    { state: { kind: 'x' }, reveal: false },
  ]) {
    assert.throws(() => parseUpdateEvent(input), Error, JSON.stringify(input));
  }
});

test('a hidden download stays hidden while it advances, and news shows it again', () => {
  const downloading = { kind: 'downloading', version: '1', progress: NO_DOWNLOAD_PROGRESS } as const;
  assert.equal(nextUpdateHidden({ state: downloading, reveal: false }, { hidden: true }), true);
  assert.equal(nextUpdateHidden({ state: downloading, reveal: false }, { hidden: false }), false);
  assert.equal(nextUpdateHidden({ state: downloading, reveal: true }, { hidden: true }), false, 'a menu check re-shows it');
  assert.equal(nextUpdateHidden({ state: { kind: 'ready', version: '1' }, reveal: false }, { hidden: true }), false, 'a finished download is never hidden');
  assert.equal(nextUpdateHidden({ state: { kind: 'error', stage: 'download', detail: '' }, reveal: true }, { hidden: true }), false);
});

test('the update channels parse their payloads', () => {
  assert.deepEqual(parseUpdateAction({ action: 'install' }), { action: 'install' });
  assert.deepEqual(parseIpcPayload('update:act', { action: 'retry' }), { action: 'retry' });
  assert.equal(parseIpcPayload('update:read', undefined), undefined);
  for (const input of [undefined, {}, { action: 'quit' }, { action: 1 }, 'install']) {
    assert.throws(() => parseIpcPayload('update:act', input), Error, JSON.stringify(input));
  }
  assert.throws(() => parseIpcPayload('update:read', {}), /Expected no payload/);
});
