// Goal: the apps failure paths carry a message reference beside their English sentence, and the wire parsers keep a good reference and drop
// a bad one without failing the value that carried it (docs/i18n-playbook.md section 7).
// Method: pure calls. A broken app-folder row, a failed share outcome and an update outcome are parsed with a good reference, a bad one and none;
// `appsFailure` is called with a ReferencedError and a plain Error.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppFolderBroken } from '#dist/shared/properties/appFolders.js';
import { appsFailure, parseAppUpdateOutcome } from '#dist/shared/properties/apps.js';
import { parseAppShareOutcome } from '#dist/shared/properties/appPublish.js';
import { ReferencedError } from '#dist/shared/properties/i18n/referencedError.js';

const LINK_REF = { key: 'apps.error.folderIsLink' };

test('a broken folder row keeps a good reference, drops a bad one, and still parses without one', () => {
  assert.deepEqual(parseAppFolderBroken({ folder: 'x', message: 'This is a link.', messageRef: LINK_REF }), {
    folder: 'x',
    message: 'This is a link.',
    messageRef: LINK_REF,
  });
  assert.deepEqual(parseAppFolderBroken({ folder: 'x', message: 'Why', messageRef: { key: 'not a key' } }), { folder: 'x', message: 'Why' });
  assert.deepEqual(parseAppFolderBroken({ folder: 'x', message: 'Why', messageRef: 7 }), { folder: 'x', message: 'Why' });
  assert.deepEqual(parseAppFolderBroken({ folder: 'x', message: 'Why' }), { folder: 'x', message: 'Why' });
  assert.throws(() => parseAppFolderBroken({ folder: 'x', message: '', messageRef: LINK_REF }));
});

test('a failed update outcome keeps a good reference and drops a bad one', () => {
  const failed = { kind: 'failed', id: 'heat-map', message: 'Gone.' };
  assert.deepEqual(parseAppUpdateOutcome({ ...failed, messageRef: { key: 'apps.error.noLongerListed' } }), {
    ...failed,
    messageRef: { key: 'apps.error.noLongerListed' },
  });
  assert.deepEqual(parseAppUpdateOutcome({ ...failed, messageRef: { key: 'nope' } }), failed);
});

test('a failed share outcome pairs its created list with references only when every one parses and lines up', () => {
  const base = { kind: 'failed', step: 'add-topic', message: 'Nope.', created: ['A', 'B'] };
  const refs = [
    { key: 'apps.share.created.topic', params: { topic: 't', repository: 'r' } },
    { key: 'apps.share.created.releaseWithoutAsset', params: { tag: 'v1' } },
  ];
  assert.deepEqual(parseAppShareOutcome({ ...base, createdRefs: refs, messageRef: LINK_REF }), { ...base, createdRefs: refs, messageRef: LINK_REF });
  assert.deepEqual(parseAppShareOutcome({ ...base, createdRefs: [refs[0]] }), base);
  assert.deepEqual(parseAppShareOutcome({ ...base, createdRefs: [refs[0], { key: 'nope' }] }), base);
  assert.deepEqual(parseAppShareOutcome(base), base);
});

test('appsFailure carries the reference of a ReferencedError and only the message of any other error', () => {
  const referenced = appsFailure(new ReferencedError('apps.error.notInstalled', { id: 'x' }));
  assert.equal(referenced.message, 'The app "x" is not installed.');
  assert.deepEqual(referenced.messageRef, { key: 'apps.error.notInstalled', params: { id: 'x' } });
  assert.deepEqual(appsFailure(new Error('Plain')), { message: 'Plain' });
});
