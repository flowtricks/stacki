// Goal: an app's `permissions` (shared/properties/appPermissions.ts) accept
// exactly what docs/apps.md describes: at most 24, ids `^[a-z][a-z0-9-]*$` up to
// 48 characters and unique, labels 1 to 60 characters, descriptions up to 160,
// `default` a required boolean; the manifest carries them, absent is none, and a
// parsed manifest reads back over the wire unchanged.
// Method: a known-good declaration, each bound at its limit and just past it,
// then one bad field at a time, pinning each error.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_PERMISSION_LIMITS, parseAppPermissionDeclarations, parseAppPermissionId } from '#dist/shared/properties/appPermissions.js';
import { parseAppManifest } from '#dist/shared/properties/apps.js';

const RESOLVE = { id: 'resolve-threads', label: 'Resolve threads', description: 'Mark a thread resolved.', default: true };
const DELETE = { id: 'delete-any-comment', label: 'Delete any comment', default: false };
const manifest = (permissions: unknown) => ({
  manifestVersion: 1,
  id: 'feedback-pins',
  name: 'Feedback pins',
  version: '1.0.0',
  entry: 'index.html',
  permissions,
});

test('declarations parse, absent is none, and the manifest carries them', () => {
  assert.deepEqual(parseAppPermissionDeclarations([RESOLVE, DELETE]), [
    { id: 'resolve-threads', label: 'Resolve threads', description: 'Mark a thread resolved.', default: true },
    { id: 'delete-any-comment', label: 'Delete any comment', description: undefined, default: false },
  ]);
  assert.deepEqual(parseAppPermissionDeclarations(undefined), []);
  assert.deepEqual(parseAppManifest(manifest(undefined)).permissions, []);
  const parsed = parseAppManifest(manifest([RESOLVE, DELETE]));
  assert.equal(parsed.permissions.length, 2);
  // The wire drops undefined; the parsed manifest must read back the same.
  const wire: unknown = JSON.parse(JSON.stringify(parsed));
  assert.deepEqual(parseAppManifest(wire).permissions, parsed.permissions);
});

test('the list is bounded at 24 and ids are unique', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `p${index}`, label: `P${index}`, default: false }));
  assert.equal(parseAppPermissionDeclarations(many(APP_PERMISSION_LIMITS.permissionsMax)).length, 24);
  assert.throws(() => parseAppPermissionDeclarations(many(APP_PERMISSION_LIMITS.permissionsMax + 1)), /at most 24 permissions/);
  assert.throws(() => parseAppPermissionDeclarations([RESOLVE, { ...DELETE, id: RESOLVE.id }]), /share an id/);
  assert.throws(() => parseAppPermissionDeclarations('resolve-threads'), /is a list/);
  assert.throws(() => parseAppManifest(manifest({ id: 'x' })), /is a list/);
});

test('ids are lowercase slugs of 1 to 48 characters', () => {
  assert.equal(parseAppPermissionId('a'.repeat(APP_PERMISSION_LIMITS.idCharsMax)).length, 48);
  assert.throws(() => parseAppPermissionId('a'.repeat(APP_PERMISSION_LIMITS.idCharsMax + 1)), /1 to 48 characters/);
  assert.throws(() => parseAppPermissionId(''), /1 to 48 characters/);
  for (const bad of ['Resolve', '1st', '-x', 'with_underscore', 'has space', 'dot.ted', '__proto__']) {
    assert.throws(() => parseAppPermissionId(bad), /must start with a letter/, bad);
  }
  assert.throws(() => parseAppPermissionId(7), /Expected string/);
});

test('label, description and default are each checked', () => {
  const one = (change: Record<string, unknown>) => () => parseAppPermissionDeclarations([{ ...RESOLVE, ...change }]);
  assert.equal(parseAppPermissionDeclarations([{ ...RESOLVE, label: 'l'.repeat(60) }])[0]?.label.length, 60);
  assert.throws(one({ label: 'l'.repeat(APP_PERMISSION_LIMITS.labelCharsMax + 1) }), /label exceeds 60/);
  assert.throws(one({ label: '   ' }), /label is empty/);
  assert.throws(one({ label: undefined }), /Expected string/);
  assert.equal(parseAppPermissionDeclarations([{ ...RESOLVE, description: 'd'.repeat(160) }])[0]?.description?.length, 160);
  assert.throws(one({ description: 'd'.repeat(APP_PERMISSION_LIMITS.descriptionCharsMax + 1) }), /description exceeds 160/);
  assert.throws(one({ description: '' }), /description is empty/);
  assert.throws(one({ default: undefined }), /default is true or false/);
  assert.throws(one({ default: 'true' }), /default is true or false/);
  assert.throws(() => parseAppPermissionDeclarations([1]), /Expected object/);
});
