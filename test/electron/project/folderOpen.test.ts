// Goal: a folder handed to Stacki from outside (the app's icon, the command line, a second launch, a window
// drop) is opened only when the disk says it is a folder, and none is lost or opened twice while the window
// cannot listen.
// Method: `inspectFolderPath` and `folderOpenChoice` run against real temporary folders: a folder, a file, a
// missing path, a link to a folder, a dangling link, a loop of links, a relative path, NUL, an over-long path.
// The queue is driven through its states: folders that arrive before the take (before the app is ready),
// after it, while the page reloads, duplicates, and one past the bound. The launch-argument reader is checked
// on packaged, development and Linux-launcher argument lists, switches and its own bound. Nothing touches a
// real project: every folder is made under the system's temporary folder and removed after.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFolderOpenQueue, folderOpenChoice, inspectFolderPath, launchFolderArguments } from '#dist/electron/project/folderOpen.js';
import { FOLDER_OPEN_LIMITS } from '#dist/shared/ipc/folderOpen.js';
import { BOUNDARY_LIMITS } from '#dist/shared/core/boundary.js';

// The real path: macOS puts the temporary folder behind a link (/var → /private/var).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-folder-open-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const folder = path.join(root, 'site');
fs.mkdirSync(folder);
const file = path.join(root, 'notes.txt');
fs.writeFileSync(file, 'notes');
const astro = path.join(root, 'blog');
fs.mkdirSync(astro);
fs.writeFileSync(path.join(astro, 'package.json'), JSON.stringify({ name: 'blog', dependencies: { astro: '^5.0.0' } }));
const plain = path.join(root, 'shop');
fs.mkdirSync(plain);
fs.writeFileSync(path.join(plain, 'index.html'), '<!doctype html><title>Shop</title>');

test('a folder is accepted as itself', () => {
  assert.deepEqual(inspectFolderPath(folder), { ok: true, value: folder });
  assert.deepEqual(inspectFolderPath(folder + path.sep), { ok: true, value: folder });
});

test('a file, a missing path and a path through a file are refused', () => {
  assert.deepEqual(inspectFolderPath(file), { ok: false, error: 'notFolder' });
  assert.deepEqual(inspectFolderPath(path.join(root, 'gone')), { ok: false, error: 'missing' });
  assert.deepEqual(inspectFolderPath(path.join(file, 'inside')), { ok: false, error: 'missing' });
});

test('a link to a folder opens its target; a dangling link and a loop of links are refused', () => {
  const link = path.join(root, 'site-link');
  fs.symlinkSync(folder, link);
  assert.deepEqual(inspectFolderPath(link), { ok: true, value: folder });
  const fileLink = path.join(root, 'notes-link');
  fs.symlinkSync(file, fileLink);
  assert.deepEqual(inspectFolderPath(fileLink), { ok: false, error: 'notFolder' });
  const dangling = path.join(root, 'dangling');
  fs.symlinkSync(path.join(root, 'nowhere'), dangling);
  assert.deepEqual(inspectFolderPath(dangling), { ok: false, error: 'missing' });
  const loopFirst = path.join(root, 'loop-a');
  const loopSecond = path.join(root, 'loop-b');
  fs.symlinkSync(loopSecond, loopFirst);
  fs.symlinkSync(loopFirst, loopSecond);
  assert.deepEqual(inspectFolderPath(loopFirst), { ok: false, error: 'unreadable' });
});

test('a relative, empty, NUL-holding or over-long path is refused before the disk is asked', () => {
  const untouched = {
    lstat: () => assert.fail('the disk is not asked'),
    realpath: () => assert.fail('the disk is not asked'),
    stat: () => assert.fail('the disk is not asked'),
  };
  assert.deepEqual(inspectFolderPath('site', untouched), { ok: false, error: 'unreadable' });
  assert.deepEqual(inspectFolderPath('', untouched), { ok: false, error: 'unreadable' });
  assert.deepEqual(inspectFolderPath('/a\0b', untouched), { ok: false, error: 'unreadable' });
  assert.deepEqual(inspectFolderPath('/' + 'a'.repeat(BOUNDARY_LIMITS.pathLengthMax), untouched), { ok: false, error: 'unreadable' });
});

test('a disk that refuses access is unreadable, not missing', () => {
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const system = {
    lstat: () => ({ isSymbolicLink: () => false }),
    realpath: () => {
      throw denied;
    },
    stat: () => ({ isDirectory: () => true }),
  };
  assert.deepEqual(inspectFolderPath('/locked', system), { ok: false, error: 'unreadable' });
});

test('an accepted folder is classified as "Open from folder" classifies it', () => {
  assert.deepEqual(folderOpenChoice(astro), { kind: 'astro', projectPath: astro });
  assert.deepEqual(folderOpenChoice(plain), { kind: 'plainWebsite', sourcePath: plain, parentPath: root, name: 'shop-astro', homePath: os.homedir() });
  assert.deepEqual(folderOpenChoice(folder), { kind: 'notWebsite', folderPath: folder });
  assert.deepEqual(folderOpenChoice(file), { kind: 'rejected', reason: 'notFolder' });
  assert.deepEqual(folderOpenChoice(path.join(root, 'gone')), { kind: 'rejected', reason: 'missing' });
});

test('folders that arrive before the window listens wait, in order, and are taken once', () => {
  const delivered: string[] = [];
  const queue = createFolderOpenQueue((arrived) => delivered.push(arrived));
  assert.equal(queue.listening(), false);
  assert.equal(queue.add('/a'), 'queued');
  assert.equal(queue.add('/b'), 'queued');
  assert.equal(queue.add('/a'), 'duplicate');
  assert.deepEqual(delivered, []);
  assert.deepEqual(queue.take(), ['/a', '/b']);
  assert.equal(queue.listening(), true);
  assert.deepEqual(queue.take(), [], 'a second take finds nothing left');
});

test('a folder that arrives while the window listens is sent at once, and a reload holds again', () => {
  const delivered: string[] = [];
  const queue = createFolderOpenQueue((arrived) => delivered.push(arrived));
  queue.take();
  assert.equal(queue.add('/a'), 'delivered');
  assert.equal(queue.add('/a'), 'delivered', 'dropped twice on purpose: both reach the window, which decides');
  assert.deepEqual(delivered, ['/a', '/a']);
  queue.hold();
  assert.equal(queue.listening(), false);
  assert.equal(queue.add('/b'), 'queued');
  assert.deepEqual(delivered, ['/a', '/a'], 'nothing is sent into a page that is going away');
  assert.deepEqual(queue.take(), ['/b']);
});

test('the queue holds at most its bound and refuses the next one', () => {
  const queue = createFolderOpenQueue(() => assert.fail('nothing is delivered while holding'));
  for (let index = 0; index < FOLDER_OPEN_LIMITS.queueMax; index += 1) {
    assert.equal(queue.add(`/folder-${index}`), 'queued');
  }
  assert.equal(queue.add('/one-more'), 'full');
  assert.equal(queue.take().length, FOLDER_OPEN_LIMITS.queueMax);
});

test('an empty path is a programmer error', () => {
  const queue = createFolderOpenQueue(() => undefined);
  assert.throws(() => queue.add(''), /Assertion failed: FolderOpenQueue.add: a path/);
});

test('launch arguments: the program is skipped, switches are left out, paths are read from the working folder', () => {
  assert.deepEqual(launchFolderArguments(['/Applications/Stacki', '/Users/me/site'], { skip: 1, workingDirectory: '/tmp' }), ['/Users/me/site']);
  assert.deepEqual(launchFolderArguments(['electron', '.', 'site', '--inspect'], { skip: 2, workingDirectory: '/Users/me' }), ['/Users/me/site']);
  assert.deepEqual(launchFolderArguments(['Stacki', '-psn_0_12345', '--enable-sandbox', ''], { skip: 1, workingDirectory: '/tmp' }), []);
  assert.deepEqual(launchFolderArguments(['stacki', pathToFileURL('/home/me/my site').href], { skip: 1, workingDirectory: '/tmp' }), ['/home/me/my site']);
  assert.deepEqual(launchFolderArguments(['stacki', 'https://example.com/site'], { skip: 1, workingDirectory: '/tmp' }), []);
  assert.deepEqual(launchFolderArguments(['electron', '.'], { skip: 2, workingDirectory: '/tmp' }), []);
});

test('launch arguments are read up to their bound, and skip is a whole, non-negative count', () => {
  const many = ['stacki', ...Array.from({ length: FOLDER_OPEN_LIMITS.argumentsMax + 10 }, (_, index) => `/f${index}`)];
  assert.equal(launchFolderArguments(many, { skip: 1, workingDirectory: '/' }).length, FOLDER_OPEN_LIMITS.argumentsMax);
  assert.throws(() => launchFolderArguments([], { skip: -1, workingDirectory: '/' }), /not negative/);
  assert.throws(() => launchFolderArguments([], { skip: 0.5, workingDirectory: '/' }), /integer/);
});
