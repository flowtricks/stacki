// Goal: the window drop shows its overlay only for a drag that may carry a folder from outside the app, never
// for a drag from inside it or for a typed file another drop target takes, and opens only real folders.
// Method: the pure decisions in src/features/welcome/folderDrop.ts run on plain item shapes: a Finder folder
// (an untyped file item), typed files, in-app drags (string items, custom types, no `Files`), mixtures, and
// lists past the drop bound; then the dropped items as `webkitGetAsEntry` reports them, and each refusal's toast.
const test = require('node:test');
const assert = require('node:assert/strict');
const drop = require('../../helpers/rendererModule')('src/features/welcome/folderDrop.ts');
const { FOLDER_OPEN_LIMITS } = require('../../helpers/rendererModule')('shared/ipc/folderOpen.ts');

const folderItem = { kind: 'file', type: '' };

test('a folder from the system shows the overlay', () => {
  assert.equal(drop.mayCarryFolder(['Files'], [folderItem]), true);
  assert.equal(drop.mayCarryFolder(['Files'], [folderItem, folderItem]), true);
});

test('in-app drags and typed files do not', () => {
  assert.equal(drop.mayCarryFolder(['text/plain'], [{ kind: 'string', type: 'text/plain' }]), false, 'text');
  assert.equal(drop.mayCarryFolder(['application/x-stacki-component'], [{ kind: 'string', type: 'application/x-stacki-component' }]), false, 'a component');
  assert.equal(
    drop.mayCarryFolder(
      ['Files', 'text/uri-list', 'text/html'],
      [
        { kind: 'string', type: 'text/uri-list' },
        { kind: 'file', type: 'image/png' },
      ],
    ),
    false,
    'a page image',
  );
  assert.equal(drop.mayCarryFolder(['Files'], [{ kind: 'file', type: 'image/png' }]), false, 'an image for the media browser');
  assert.equal(drop.mayCarryFolder(['Files'], [folderItem, { kind: 'file', type: 'application/pdf' }]), false, 'a folder with a typed file');
  assert.equal(drop.mayCarryFolder(['Files'], []), false, 'no items');
  assert.equal(drop.mayCarryFolder([], [folderItem]), false, 'no Files type');
});

test('a drag past the drop bound is judged on its first items only', () => {
  const many = Array.from({ length: FOLDER_OPEN_LIMITS.dropItemsMax + 5 }, (_, index) =>
    index < FOLDER_OPEN_LIMITS.dropItemsMax ? folderItem : { kind: 'string', type: 'text/plain' },
  );
  assert.equal(drop.mayCarryFolder(['Files'], many), true);
});

test('only the dropped folders are kept, in order, and the rest are counted', () => {
  const first = new File([], 'site');
  const second = new File([], 'blog');
  const plain = new File(['x'], 'notes');
  const dropped = drop.droppedFolders([
    { file: first, isDirectory: true },
    { file: plain, isDirectory: false },
    { file: second, isDirectory: true },
    { file: undefined, isDirectory: true },
  ]);
  assert.deepEqual(dropped.folders, [first, second]);
  assert.equal(dropped.otherCount, 2);
  assert.deepEqual(drop.droppedFolders([]), { folders: [], otherCount: 0 });
});

test('a drop past the bound is cut at the bound', () => {
  const many = Array.from({ length: FOLDER_OPEN_LIMITS.dropItemsMax + 3 }, () => ({ file: new File([], 'f'), isDirectory: true }));
  assert.equal(drop.droppedFolders(many).folders.length, FOLDER_OPEN_LIMITS.dropItemsMax);
});

test('each refusal has its own toast', () => {
  assert.equal(drop.folderRejectionMessageKey('missing'), 'welcome.drop.missing');
  assert.equal(drop.folderRejectionMessageKey('notFolder'), 'welcome.drop.notFolder');
  assert.equal(drop.folderRejectionMessageKey('unreadable'), 'welcome.drop.unreadable');
});
