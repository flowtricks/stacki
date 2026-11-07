// Goal: the cache meta read from disk and the entries received over IPC are parsed before anyone trusts them.
// Methodology: a good meta passes intact; then each field is broken one at a time, and each bound is
// crossed at its edge. Entry lists and image data URLs get the same treatment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPONENT_SHOT_LIMITS,
  SHOT_DATA_URL_CHARS_MAX,
  parseComponentShotEntries,
  parseComponentShotImage,
  parseComponentShotMeta,
} from '#dist/shared/properties/componentShots.js';

const jsonNull: unknown = JSON.parse('null');
const shot = { component: '/p/src/components/Hero.astro', file: '0123456789abcdef.jpg', width: 1440, height: 900 };
const meta = { version: 1, fingerprint: 'a'.repeat(40), capturedAt: 1_700_000_000_000, shots: [shot] };

test('a good meta passes intact, and a run that never completed has an empty fingerprint', () => {
  assert.deepEqual(parseComponentShotMeta(structuredClone(meta)), meta);
  assert.equal(parseComponentShotMeta({ ...meta, fingerprint: '' }).fingerprint, '');
  assert.deepEqual(parseComponentShotMeta({ ...meta, shots: [] }).shots, []);
});

test('negative space: every wrong meta shape fails', () => {
  const bad: Array<[string, unknown]> = [
    ['not an object', jsonNull],
    ['a string', 'meta'],
    ['an array', []],
    ['unknown version', { ...meta, version: 2 }],
    ['version missing', { ...meta, version: undefined }],
    ['fingerprint not a string', { ...meta, fingerprint: 5 }],
    ['fingerprint not hexadecimal', { ...meta, fingerprint: 'xyz' }],
    ['fingerprint too long', { ...meta, fingerprint: 'a'.repeat(65) }],
    ['capturedAt negative', { ...meta, capturedAt: -1 }],
    ['capturedAt fractional', { ...meta, capturedAt: 1.5 }],
    ['shots not a list', { ...meta, shots: {} }],
    ['shot not an object', { ...meta, shots: [jsonNull] }],
    ['component empty', { ...meta, shots: [{ ...shot, component: '' }] }],
    ['component with NUL', { ...meta, shots: [{ ...shot, component: 'a\0b' }] }],
    ['file with a path in it', { ...meta, shots: [{ ...shot, file: '../0123456789abcdef.jpg' }] }],
    ['file with the wrong extension', { ...meta, shots: [{ ...shot, file: '0123456789abcdef.png' }] }],
    ['file too short', { ...meta, shots: [{ ...shot, file: 'abc.jpg' }] }],
    ['width zero', { ...meta, shots: [{ ...shot, width: 0 }] }],
    ['width past the photograph width', { ...meta, shots: [{ ...shot, width: COMPONENT_SHOT_LIMITS.widthPx + 1 }] }],
    ['height zero', { ...meta, shots: [{ ...shot, height: 0 }] }],
    ['height past the bound', { ...meta, shots: [{ ...shot, height: COMPONENT_SHOT_LIMITS.heightMax + 1 }] }],
    ['height fractional', { ...meta, shots: [{ ...shot, height: 10.5 }] }],
    ['duplicate component', { ...meta, shots: [shot, { ...shot, file: 'fedcba9876543210.jpg' }] }],
  ];
  for (const [what, input] of bad) {
    assert.throws(() => parseComponentShotMeta(input), Error, what);
  }
});

test('bounds: the edge passes and one past it fails', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ ...shot, component: `/p/src/components/C${at}.astro`, file: at.toString(16).padStart(16, '0') + '.jpg' }));
  assert.equal(parseComponentShotMeta({ ...meta, shots: many(COMPONENT_SHOT_LIMITS.componentsMax) }).shots.length, COMPONENT_SHOT_LIMITS.componentsMax);
  assert.throws(() => parseComponentShotMeta({ ...meta, shots: many(COMPONENT_SHOT_LIMITS.componentsMax + 1) }), /too many/);
  assert.equal(
    parseComponentShotMeta({ ...meta, shots: [{ ...shot, height: COMPONENT_SHOT_LIMITS.heightMax }] }).shots[0]?.height,
    COMPONENT_SHOT_LIMITS.heightMax,
  );
});

test('entries keep a component and its size, and nothing else', () => {
  assert.deepEqual(parseComponentShotEntries([{ component: shot.component, width: 1440, height: 900, file: 'ignored' }]), [
    { component: shot.component, width: 1440, height: 900 },
  ]);
  for (const input of [
    jsonNull,
    {},
    [jsonNull],
    [{ component: '', width: 1, height: 1 }],
    [{ component: 'a', width: 0, height: 1 }],
    [{ component: 'a', width: 1 }],
  ]) {
    assert.throws(() => parseComponentShotEntries(input), Error);
  }
});

test('an image is a JPEG data URL within the bound, or absent', () => {
  assert.equal(parseComponentShotImage(undefined), undefined);
  assert.equal(parseComponentShotImage('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA');
  assert.throws(() => parseComponentShotImage('data:image/png;base64,AAAA'), /not a JPEG/);
  assert.throws(() => parseComponentShotImage(7), Error);
  assert.throws(() => parseComponentShotImage(jsonNull), Error);
  assert.throws(() => parseComponentShotImage('data:image/jpeg;base64,' + 'A'.repeat(SHOT_DATA_URL_CHARS_MAX)), /exceeds/);
});
