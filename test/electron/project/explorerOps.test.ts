// Goal: the Files panel's disk operations stay inside the project and never lose bytes. Paths that climb, links that
// lead out, `.git` and `.stacki/io` are refused for writes; listings show every dotfile and dot-folder, `.git`
// included; taken names are never overwritten without an answer; a case-only rename works on any disk; a save keeps the
// byte-order mark and the line breaks of lines it did not touch and is refused when the file changed since it was read;
// deleting goes to a Trash (here a folder of the test's own) and never follows a link.
// Method: a fresh temporary project per case, the real operations from dist/electron/project/explorerOps.js, and the
// disk read back after each one. Links are made only where the platform allows it (Windows needs a privilege).
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { explorerRoot, resolveEntry } from '#dist/electron/project/explorerPaths.js';
import {
  createEntry,
  findEntries,
  freeCopyName,
  importEntries,
  listFolder,
  readExplorerFile,
  renameEntry,
  transferEntries,
  trashEntries,
  writeExplorerFile,
} from '#dist/electron/project/explorerOps.js';
import { toExplorerPath } from '#dist/shared/ipc/fileExplorer.js';

const at = toExplorerPath;

function project(): { readonly root: string; readonly trash: string; readonly cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-files-'));
  const root = path.join(base, 'site');
  const trash = path.join(base, 'trash');
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git/objects'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.mkdirSync(trash);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), 'name: CI\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '<h1>Hi</h1>\n');
  return { root, trash, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function opened(root: string) {
  const answer = explorerRoot(root, root);
  assert.ok(answer.ok);
  return answer.value;
}

function disk(trash: string) {
  let count = 0;
  return {
    trash: async (absolute: string) => {
      count += 1;
      fs.renameSync(absolute, path.join(trash, `${count}-${path.basename(absolute)}`));
    },
  };
}

function linksAllowed(root: string): boolean {
  try {
    fs.symlinkSync(root, path.join(root, '.probe-link'));
    fs.unlinkSync(path.join(root, '.probe-link'));
    return true;
  } catch {
    return false;
  }
}

test('only the open project is served', () => {
  const site = project();
  try {
    assert.equal(explorerRoot(site.root, undefined).ok, false);
    const other = explorerRoot(site.root, path.join(site.root, 'src'));
    assert.ok(!other.ok && other.error.code === 'not-open');
  } finally {
    site.cleanup();
  }
});

test('listings hold every dotfile and dot-folder, .git included, folders first', () => {
  const site = project();
  try {
    const listed = listFolder(opened(site.root), at(''));
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.value.entries.map((entry) => entry.name),
      ['.git', '.github', 'src', '.env', 'package.json'],
    );
    const git = listFolder(opened(site.root), at('.git'));
    assert.ok(git.ok, '.git is readable');
    assert.deepEqual(
      git.value.entries.map((entry) => entry.name),
      ['objects', 'HEAD'],
    );
  } finally {
    site.cleanup();
  }
});

test('a folder past the listing bound reports its total', () => {
  const site = project();
  try {
    fs.mkdirSync(path.join(site.root, 'many'));
    for (let index = 0; index < 5_010; index += 1) {
      fs.writeFileSync(path.join(site.root, 'many', `f${index}`), '');
    }
    const listed = listFolder(opened(site.root), at('many'));
    assert.ok(listed.ok);
    assert.equal(listed.value.entries.length, 5_000);
    assert.equal(listed.value.totalCount, 5_010);
    assert.equal(listed.value.entries[2]?.name, 'f2', 'natural order: f2 before f10');
  } finally {
    site.cleanup();
  }
});

test('.git and .stacki/io are read-only: no write, create, rename, move into or trash', async () => {
  const site = project();
  try {
    const root = opened(site.root);
    const head = readExplorerFile(root, at('.git/HEAD'));
    assert.ok(head.ok && head.value.kind === 'text');
    assert.equal(writeExplorerFile(root, { file: at('.git/HEAD'), text: 'x', byteOrderMark: false, base: head.value.checksum }).ok, false);
    const create = createEntry(root, at('.git'), 'x', 'file');
    assert.ok(!create.ok && create.error.code === 'protected');
    const rename = renameEntry(root, at('.git'), 'git');
    assert.ok(!rename.ok && rename.error.code === 'protected');
    const into = await transferEntries(root, { sources: [at('.env')], target: at('.git'), mode: 'move', collision: 'refuse' }, disk(site.trash));
    assert.ok(!into.ok && into.error.code === 'protected');
    const trashed = await trashEntries(root, [at('.git')], disk(site.trash));
    assert.ok(!trashed.ok && trashed.error.code === 'protected');
    const named = createEntry(root, at(''), '.GIT', 'directory');
    assert.ok(!named.ok, 'a differently cased .git is refused too');
    const io = createEntry(root, at('.stacki'), 'io', 'directory');
    assert.ok(!io.ok && io.error.code !== 'filesystem');
    assert.ok(fs.existsSync(path.join(site.root, '.git/HEAD')));
    assert.ok(fs.existsSync(path.join(site.root, '.env')));
  } finally {
    site.cleanup();
  }
});

test('a save keeps the byte-order mark and untouched CRLF lines, and refuses a stale base', () => {
  const site = project();
  try {
    const file = path.join(site.root, 'notes.txt');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
    const root = opened(site.root);
    const read = readExplorerFile(root, at('notes.txt'));
    assert.ok(read.ok && read.value.kind === 'text');
    assert.equal(read.value.byteOrderMark, true);
    assert.equal(read.value.text, 'a\r\nb\r\n', 'the mark is a flag, the text keeps its breaks');
    const written = writeExplorerFile(root, { file: at('notes.txt'), text: 'a\r\nB\r\n', byteOrderMark: true, base: read.value.checksum });
    assert.ok(written.ok);
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.subarray(3).toString('utf8'), 'a\r\nB\r\n');
    assert.equal(written.value.checksum, createHash('sha256').update(bytes).digest('hex'));
    const stale = writeExplorerFile(root, { file: at('notes.txt'), text: 'lost', byteOrderMark: true, base: read.value.checksum });
    assert.ok(!stale.ok && stale.error.code === 'conflict');
    assert.equal(fs.readFileSync(file).subarray(3).toString('utf8'), 'a\r\nB\r\n', 'a stale save writes nothing');
  } finally {
    site.cleanup();
  }
});

test('binary, oversized and media files are never opened as text', () => {
  const site = project();
  try {
    fs.writeFileSync(path.join(site.root, 'blob.bin'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(site.root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    fs.writeFileSync(path.join(site.root, 'photo.png'), Buffer.from([0x89, 0x50]));
    const root = opened(site.root);
    const kinds = ['blob.bin', 'latin1.txt', 'photo.png'].map((name) => {
      const read = readExplorerFile(root, at(name));
      assert.ok(read.ok);
      return read.value.kind;
    });
    assert.deepEqual(kinds, ['binary', 'binary', 'media']);
    const folder = readExplorerFile(root, at('src'));
    assert.ok(!folder.ok && folder.error.code === 'not-file');
  } finally {
    site.cleanup();
  }
});

test('names are never overwritten; a case-only rename works', () => {
  const site = project();
  try {
    const root = opened(site.root);
    const taken = createEntry(root, at(''), '.env', 'file');
    assert.ok(!taken.ok && taken.error.code === 'exists');
    assert.equal(fs.readFileSync(path.join(site.root, '.env'), 'utf8'), 'SECRET=1\n');
    fs.writeFileSync(path.join(site.root, 'other.txt'), 'other');
    const clash = renameEntry(root, at('other.txt'), '.env');
    assert.ok(!clash.ok && clash.error.code === 'exists');
    const made = createEntry(root, at('src'), 'card.astro', 'file');
    assert.ok(made.ok);
    const cased = renameEntry(root, at('src/card.astro'), 'Card.astro');
    assert.ok(cased.ok);
    assert.deepEqual(
      fs.readdirSync(path.join(site.root, 'src')).filter((name) => name.toLowerCase() === 'card.astro'),
      ['Card.astro'],
    );
  } finally {
    site.cleanup();
  }
});

test('moves and copies ask about taken names, keep both or replace through the Trash', async () => {
  const site = project();
  try {
    const root = opened(site.root);
    fs.mkdirSync(path.join(site.root, 'target'));
    fs.writeFileSync(path.join(site.root, 'target/.env'), 'OLD=1\n');
    const asked = await transferEntries(root, { sources: [at('.env')], target: at('target'), mode: 'move', collision: 'refuse' }, disk(site.trash));
    assert.ok(!asked.ok && asked.error.code === 'collision');
    assert.deepEqual(asked.error.names, ['.env']);
    const both = await transferEntries(root, { sources: [at('.env')], target: at('target'), mode: 'copy', collision: 'keep-both' }, disk(site.trash));
    assert.ok(both.ok);
    assert.equal(both.value.placed[0]?.to, 'target/.env copy');
    const replaced = await transferEntries(root, { sources: [at('.env')], target: at('target'), mode: 'move', collision: 'replace' }, disk(site.trash));
    assert.ok(replaced.ok);
    assert.equal(fs.readFileSync(path.join(site.root, 'target/.env'), 'utf8'), 'SECRET=1\n');
    assert.deepEqual(fs.readdirSync(site.trash), ['1-.env'], 'the replaced file went to the Trash');
    const itself = await transferEntries(root, { sources: [at('src')], target: at('src/pages'), mode: 'move', collision: 'refuse' }, disk(site.trash));
    assert.ok(!itself.ok && itself.error.code === 'into-itself');
    const duplicate = await transferEntries(root, { sources: [at('src/pages')], target: at('src'), mode: 'copy', collision: 'keep-both' }, disk(site.trash));
    assert.ok(duplicate.ok);
    assert.ok(fs.existsSync(path.join(site.root, 'src/pages copy/index.astro')));
    assert.equal(freeCopyName(path.join(site.root, 'src'), 'pages'), 'pages copy 2');
  } finally {
    site.cleanup();
  }
});

test('an import copies outside files in and leaves the originals', async () => {
  const site = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-files-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'logo.svg'), '<svg/>');
    const imported = await importEntries(
      opened(site.root),
      { sources: [path.join(outside, 'logo.svg')], target: at('src'), collision: 'refuse' },
      disk(site.trash),
    );
    assert.ok(imported.ok);
    assert.equal(fs.readFileSync(path.join(site.root, 'src/logo.svg'), 'utf8'), '<svg/>');
    assert.ok(fs.existsSync(path.join(outside, 'logo.svg')));
    const relative = await importEntries(opened(site.root), { sources: ['relative.txt'], target: at('src'), collision: 'refuse' }, disk(site.trash));
    assert.ok(!relative.ok);
  } finally {
    site.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a link that leads out is listed but never read, written, expanded or followed by a delete', async (context) => {
  const site = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-files-outside-'));
  try {
    if (!linksAllowed(site.root)) {
      context.skip('this platform does not allow symbolic links here');
      return;
    }
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(outside, path.join(site.root, 'escape'));
    fs.symlinkSync(path.join(site.root, 'src'), path.join(site.root, 'inside'));
    const root = opened(site.root);
    const listed = listFolder(root, at(''));
    assert.ok(listed.ok);
    const kinds = Object.fromEntries(listed.value.entries.map((entry) => [entry.name, entry.kind]));
    assert.equal(kinds['escape'], 'link-outside');
    assert.equal(kinds['inside'], 'link-directory');
    const read = readExplorerFile(root, at('escape/secret.txt'));
    assert.ok(!read.ok && read.error.code === 'outside');
    assert.equal(listFolder(root, at('escape')).ok, false);
    const create = createEntry(root, at('escape'), 'planted.txt', 'file');
    assert.ok(!create.ok);
    assert.ok(!fs.existsSync(path.join(outside, 'planted.txt')), 'nothing was written outside');
    const trashed = await trashEntries(root, [at('escape')], disk(site.trash));
    assert.ok(trashed.ok);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside', 'trashing the link left its target');
    const throughInside = resolveEntry(root, at('inside/pages'));
    assert.ok(throughInside.ok, 'a link inside the project is followed');
  } finally {
    site.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('trash takes the outermost of nested picks and never unlinks', async () => {
  const site = project();
  try {
    const trashed = await trashEntries(opened(site.root), [at('src'), at('src/pages/index.astro')], disk(site.trash));
    assert.ok(trashed.ok);
    assert.equal(trashed.value.count, 1);
    assert.ok(fs.existsSync(path.join(site.trash, '1-src/pages/index.astro')));
  } finally {
    site.cleanup();
  }
});

test('find reaches dotfiles and dot-folders by name and skips the inside of .git', () => {
  const site = project();
  try {
    fs.writeFileSync(path.join(site.root, '.git/ci-hook'), '');
    const found = findEntries(opened(site.root), 'ci');
    assert.ok(found.ok);
    assert.deepEqual(
      found.value.matches.map((match) => match.path),
      ['.github/workflows/ci.yml'],
    );
    const env = findEntries(opened(site.root), '.ENV');
    assert.ok(env.ok);
    assert.equal(env.value.matches[0]?.path, '.env');
  } finally {
    site.cleanup();
  }
});
