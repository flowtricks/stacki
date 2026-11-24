// Goal: a packaged Stacki accepts a folder dropped on its macOS Dock icon. macOS only offers an app a dropped
// folder, and only then sends `open-file` (electron/project/folderOpen.ts), when its Info.plist declares a
// document type for folders; electron-builder writes that from `build.mac.extendInfo` in package.json.
// Method: read package.json and check the declaration: a `CFBundleDocumentTypes` entry for `public.folder`,
// with a role, and ranked `Alternate`, so Stacki is offered folders without claiming to be the app that opens them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { repoPath } = require('../../helpers/sources.js');

const manifest = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8'));

test('the macOS bundle declares that it opens folders', () => {
  const types = manifest.build.mac.extendInfo.CFBundleDocumentTypes;
  assert.ok(Array.isArray(types), 'CFBundleDocumentTypes is a list');
  const folders = types.filter((type) => Array.isArray(type.LSItemContentTypes) && type.LSItemContentTypes.includes('public.folder'));
  assert.equal(folders.length, 1, 'exactly one document type names public.folder');
  const [folder] = folders;
  assert.ok(['Editor', 'Viewer'].includes(folder.CFBundleTypeRole), 'the folder type has a role');
  assert.equal(folder.LSHandlerRank, 'Alternate', 'Stacki never becomes the default app for folders');
  assert.equal(typeof folder.CFBundleTypeName, 'string');
});

test('the declaration sits beside the keys the bundle already had', () => {
  assert.equal(typeof manifest.build.mac.extendInfo.NSMicrophoneUsageDescription, 'string');
  assert.equal(manifest.build.fileAssociations, undefined, 'no file association competes with the folder type');
});
