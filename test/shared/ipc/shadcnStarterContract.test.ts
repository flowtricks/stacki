// Exercise the request and reply parsers as renderer and main receive them.
// Valid codes are resolved by the CLI integration, so these tests cover the wire format.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  parseShadcnPresetReply,
  SHADCN_BASES,
  SHADCN_ICON_LIBRARIES,
  SHADCN_PRESET_CODE_LENGTH_MAX,
  SHADCN_STARTER_DEFAULTS,
} from '#dist/shared/ipc/shadcnStarter.js';

const location = { parentPath: '/sites', name: 'example' };
const request = { ...location, starter: 'shadcn', shadcn: SHADCN_STARTER_DEFAULTS };

test('both starter variants keep their own options', () => {
  assert.deepEqual(parseIpcPayload('project:createStarter', location), location);
  const lumos = { ...location, starter: 'lumos', packageManager: 'pnpm' };
  assert.deepEqual(parseIpcPayload('project:createStarter', lumos), lumos);
  assert.deepEqual(parseIpcPayload('project:createStarter', request), request);
  for (const base of SHADCN_BASES) {
    for (const iconLibrary of SHADCN_ICON_LIBRARIES) {
      const custom = { ...request, shadcn: { base, style: 'nova', iconLibrary, preset: 'b1QGlW', pointer: true, rtl: true } };
      assert.deepEqual(parseIpcPayload('project:createStarter', custom), custom);
    }
  }
  assert.throws(() => parseIpcPayload('project:createStarter', { ...request, starter: 'other' }), /Unknown site starter/);
  assert.throws(() => parseIpcPayload('project:createStarter', { ...request, starter: 'lumos' }), /require the shadcn starter/);
  assert.throws(() => parseIpcPayload('project:createStarter', { ...request, shadcn: undefined }), /Expected object/);
});

test('shadcn rejects paths, names, enum-like values and incorrectly typed switches', () => {
  for (const name of ['', '..', 'nested/site', '--overwrite', 'site&echo', 'a'.repeat(129)]) {
    assert.throws(() => parseIpcPayload('project:createStarter', { ...request, name }), /folder name/);
  }
  for (const parentPath of ['sites', '/sites/../outside', '/sites/\0here', '/a/'.repeat(5000)]) {
    assert.throws(() => parseIpcPayload('project:createStarter', { ...request, parentPath }), /Path/);
  }
  for (const invalid of [
    { base: '--base' },
    { style: '--preset' },
    { iconLibrary: 'unknown', style: 'nova' },
    { pointer: 'true' },
    { rtl: undefined },
    { rtl: 0 },
  ]) {
    assert.throws(() => parseIpcPayload('project:createStarter', { ...request, shadcn: { ...request.shadcn, ...invalid } }));
  }
});

test('preset inspection accepts only bare codes and parses its success and failure replies', () => {
  for (const preset of ['b0', 'a2r6bw', 'b1QGlW']) {
    assert.deepEqual(parseIpcPayload('project:inspectShadcnPreset', { preset }), { preset });
  }
  for (const preset of ['', '--yes', 'nova', 'b0&whoami', 'b0\n', 'https://ui.shadcn.com/init?preset=b0', 'b' + '0'.repeat(SHADCN_PRESET_CODE_LENGTH_MAX)]) {
    assert.throws(() => parseIpcPayload('project:inspectShadcnPreset', { preset }), /preset code/);
  }
  const found = { ok: true, value: { iconLibrary: 'hugeicons', style: 'nova' } };
  const failed = { ok: false, error: { message: 'Invalid preset code' } };
  assert.deepEqual(parseShadcnPresetReply(found), found);
  assert.deepEqual(parseShadcnPresetReply(failed), failed);
  assert.throws(() => parseShadcnPresetReply({ ...found, value: { iconLibrary: 'unknown', style: 'nova' } }));
  assert.throws(() => parseShadcnPresetReply({ ...failed, error: { message: 1 } }));
});
