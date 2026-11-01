// Goal: the page save contract (plan §11 step 0; every save an edit since step
// 10) holds end to end. Reads report the SHA-256 of the exact bytes; an edit
// names the checksum it was authored against, and main refuses it — leaving
// the disk untouched — when it cannot be placed on the bytes the file holds
// now. Opening a page writes nothing; an edit of any page, byte-order mark and
// line endings included, changes exactly its own bytes.
// Method: the wire parsers get one known-good and each known-bad shape; the
// real main-process handlers run in the windowless harness against temporary
// files, with outside edits made directly on disk between read and write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { IPC_PAYLOADS, parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parsePageDiskRead, parsePageEditResult } from '#dist/shared/ipc/pageSave.js';
import { diffCodePatch } from '#dist/shared/engine/codePatch.js';
import { toDigest } from '#dist/shared/core/brand.js';
import type { PageDiskRead } from '#dist/shared/ipc/pageSave.js';
import { parseScanResult } from '#dist/shared/properties/projectScan.js';
import { toRecord } from '#dist/shared/core/record.js';
import { atomicDirectoryOf } from '#dist/electron/documents/atomicDirectory.js';
import { pageEditError } from '#dist/electron/documents/pageRequests.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const FIXTURES = path.resolve('test/fixtures/round-trip');
const page = {
  source: '<h1>Hi</h1>\n',
  editable: true,
  model: {
    imports: [],
    frontmatterLead: '',
    extraFrontmatter: '',
    extraFrontmatterSpaced: false,
    frontmatterLayout: { extra: '', slots: [] },
    hadFrontmatter: false,
    trailingBlank: 0,
    nodes: [],
  },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-save-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof fixture>;

function temporaries(directory: string): readonly string[] {
  const staging = atomicDirectoryOf(path.join(directory, 'page.astro'));
  return fs.existsSync(staging) ? fs.readdirSync(staging) : [];
}

test('Digest accepts exactly 64 lowercase hex characters', () => {
  assert.equal(toDigest('a'.repeat(64)), 'a'.repeat(64));
  for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.throws(() => toDigest(bad), /Digest: expected 64 lowercase hex characters/);
  }
});

test('edit payloads require a well-formed authored checksum', () => {
  const base = 'b'.repeat(64);
  const edit = { tag: 'revert', hunks: [{ span: { start: 0, end: 1 }, text: 'x' }] };
  const payload = { pagePath: '/p.md', edit };
  const parsed = parseIpcPayload('page:edit', { ...payload, authoredChecksum: base });
  assert.equal(parsed.authoredChecksum, base);
  assert.throws(() => parseIpcPayload('page:edit', payload), /Expected digest string/);
  assert.throws(() => parseIpcPayload('page:edit', { ...payload, authoredChecksum: 42 }), /digest/);
  assert.throws(() => parseIpcPayload('page:edit', { ...payload, authoredChecksum: 'B'.repeat(64) }), /Digest: expected 64 lowercase hex characters/);
});

test('the whole-file channels are retired: every save is an edit through page:edit', () => {
  // Step 8: `page:writeRaw` wrote the code editor's whole text; the code editor
  // sends a byte diff through the page's actor. Step 10: `page:write` saved a
  // Markdown page's whole model and `page:serialize` printed it for review;
  // Markdown gestures are splices too, previewed as splices.
  for (const retired of ['page:writeRaw', 'page:write', 'page:serialize']) {
    assert.equal(Object.hasOwn(IPC_PAYLOADS, retired), false, retired);
  }
  assert.equal(Object.hasOwn(IPC_PAYLOADS, 'page:edit'), true);
});

/** Save `next` as the code editor does: the patch from the text it read. */
async function saveCode(harness: Harness, file: string, read: PageDiskRead, next: string) {
  const hunks = diffCodePatch(read.source, next);
  assert.ok(hunks.ok, 'the text is inside the bounds');
  const edit = { tag: 'code-patch', hunks: hunks.value };
  const payload = { pagePath: file, authoredChecksum: read.checksum, edit };
  return parsePageEditResult(await harness.invoke('page:edit', payload));
}

test('page read and edit replies parse only with a valid checksum', () => {
  const checksum = 'c'.repeat(64);
  assert.equal(parsePageDiskRead({ ...page, checksum }).checksum, checksum);
  assert.throws(() => parsePageDiskRead(page), /PageDiskRead\.checksum: expected string/);
  assert.throws(() => parsePageDiskRead({ ...page, checksum: 'c'.repeat(63) }), /PageDiskRead\.checksum: Digest/);
  // An edit's reply carries the inverse Undo submits (step 9).
  const written = parsePageEditResult({ ok: true, ...page, checksum, inverse: [] });
  assert.equal(written.ok && written.value.checksum, checksum);
  assert.throws(() => parsePageEditResult({ ok: true, ...page, inverse: [] }), /PageDiskRead\.checksum/);
  assert.throws(() => parsePageEditResult({ ok: true, ...page, checksum }), /PageEdited\.inverse: expected array/);
  assert.throws(() => parsePageEditResult(jsonNull), /PageEditResult: expected object/);
  assert.throws(() => parsePageEditResult({ ok: 'yes' }), /PageEditResult\.ok/);
});

test('edit refusals parse per code; unknown or malformed ones throw', () => {
  const diskChecksum = 'd'.repeat(64);
  const refusal = { code: 'rejected', reason: 'anchor-moved', message: 'moved', diskChecksum };
  assert.deepEqual(parsePageEditResult({ ok: false, error: refusal }), {
    ok: false,
    error: refusal,
  });
  for (const code of ['missing', 'filesystem', 'write-race', 'uncertain', 'backpressured']) {
    assert.deepEqual(parsePageEditResult({ ok: false, error: { code, message: 'm' } }), {
      ok: false,
      error: { code, message: 'm' },
    });
  }
  const bad = [
    // Step 10: no save is refused as a whole-file `conflict` any more.
    [{ code: 'conflict', message: 'changed', diskChecksum }, /PageWriteFailure\.code: unknown/],
    [{ ...refusal, diskChecksum: 'x' }, /diskChecksum: Digest/],
    [{ ...refusal, reason: 'teapot' }, /unknown rejection reason/],
    [{ code: 'teapot', message: 'm' }, /PageWriteFailure\.code: unknown value/],
    [{ code: 'missing' }, /PageWriteFailure\.message: expected string/],
    [{ code: 'missing', message: 'm'.repeat(9000) }, /PageWriteFailure\.message: exceeds limit/],
    [undefined, /PageEditError: expected object/],
  ] as const;
  for (const [error, message] of bad) {
    assert.throws(() => parsePageEditResult({ ok: false, error }), message);
  }
});

test('a read reports the checksum of the exact bytes on disk', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>é</h1>\n');
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.equal(read.checksum, sha256(fs.readFileSync(file)));
  fs.writeFileSync(file, Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0x0a]));
  await assert.rejects(harness.invoke('page:read', file), /not valid UTF-8/);
});

test('a failed replacement is retryable and reports the filesystem error', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<p>Before</p>\n');
  const before = parsePageDiskRead(await harness.invoke('page:read', file));
  const next = '<p>After</p>\n';
  const rename = context.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EPERM: file temporarily held open'), { code: 'EPERM' });
  });
  const failed = await saveCode(harness, file, before, next);
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, 'filesystem');
  assert.match(failed.error.message, /EPERM/);
  assert.equal(fs.readFileSync(file, 'utf8'), before.source);
  assert.deepEqual(temporaries(path.dirname(file)), []);
  rename.mock.restore();
  assert.ok((await saveCode(harness, file, before, next)).ok);
  assert.equal(fs.readFileSync(file, 'utf8'), next);
});

test('a write race crosses IPC as an uncertain save, not an unsupported gesture', () => {
  const error = pageEditError('/page.astro', {
    tag: 'rejected',
    reason: 'write-race',
    message: 'Another writer changed the file during replacement',
    diskChecksum: toDigest('a'.repeat(64)),
  });
  const parsed = parsePageEditResult({ ok: false, error });
  assert.ok(!parsed.ok);
  assert.equal(parsed.error.code, 'write-race');
});

test('an outside edit between read and write is refused and left on disk', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  // A Markdown gesture on the heading someone rewrote outside Stacki.
  const notes = path.join(harness.root, 'src/pages/notes.md');
  fs.writeFileSync(notes, '# Before\n');
  const before = parsePageDiskRead(await harness.invoke('page:read', notes));
  assert.ok(before.editable);
  const heading = before.model.nodes[0];
  assert.ok(heading?.start !== undefined && heading.end !== undefined);
  fs.writeFileSync(notes, '# Outside\n');
  const target = { path: [0], kind: 'element', span: { start: heading.start, end: heading.end } };
  const level = { tag: 'rename-tag', target, to: 'h2' };
  const payload = { pagePath: notes, authoredChecksum: before.checksum, edit: level };
  const result = parsePageEditResult(await harness.invoke('page:edit', payload));
  assert.equal(!result.ok && result.error.code, 'rejected');
  assert.equal(!result.ok && result.error.code === 'rejected' && result.error.diskChecksum, sha256('# Outside\n'));
  assert.equal(fs.readFileSync(notes, 'utf8'), '# Outside\n', 'the gesture left disk alone');
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>Before</h1>\n');
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  fs.writeFileSync(file, '<h1>Outside</h1>\n');
  // The code editor's save of the same word overlaps the outside edit.
  const code = await saveCode(harness, file, read, '<h1>Mine</h1>\n');
  assert.equal(!code.ok && code.error.code === 'rejected' && code.error.reason, 'merge-conflict');
  assert.equal(!code.ok && code.error.code === 'rejected' && code.error.diskChecksum, sha256('<h1>Outside</h1>\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Outside</h1>\n', 'the patch left disk alone');
  assert.deepEqual(temporaries(path.dirname(file)), []);
});

test('a write against current bytes lands atomically with its checksum', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>Before</h1>\n');
  fs.chmodSync(file, 0o640);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  const source = '<h1>After</h1>\n';
  const written = await saveCode(harness, file, read, source);
  assert.ok(written.ok, 'the code save applied');
  assert.equal(written.value.checksum, sha256(source));
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'the replacement keeps the mode');
  }
  assert.deepEqual(temporaries(path.dirname(file)), []);
  // The next save names the checksum the last one returned.
  const again = await saveCode(harness, file, written.value, '<h1>Again</h1>\n');
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Again</h1>\n');
});

test('a page deleted since it was read is missing, not a conflict', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/gone.md');
  fs.writeFileSync(file, 'Gone.\n');
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  fs.rmSync(file);
  const code = await saveCode(harness, file, read, 'Still here.\n');
  assert.equal(code.ok, false, 'a code save does not recreate the file either');
  assert.equal(fs.existsSync(file), false, 'a refused write does not recreate the file');
});

test('every round-trip fixture opens as read and takes an edit of its bytes', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const names = fs.readdirSync(FIXTURES).filter((name) => /\.(astro|mdx?)$/.test(name));
  assert.ok(names.filter((name) => name !== 'README.md').length >= 9, 'the corpus is not thin');
  for (const name of names.filter((entry) => entry !== 'README.md')) {
    const original = fs.readFileSync(path.join(FIXTURES, name));
    const file = path.join(harness.root, 'src/pages', name);
    fs.writeFileSync(file, original);
    const read = parsePageDiskRead(await harness.invoke('page:read', file));
    assert.ok(read.editable, `${name} opens in the visual editor`);
    assert.equal(read.checksum, sha256(original));
    assert.ok(fs.readFileSync(file).equals(original), `${name}: opening writes nothing`);
    if (name.endsWith('.astro')) {
      continue; // .astro gestures on these bytes: pageEdit.test.ts.
    }
    // A Markdown page's first heading one level down: `#` becomes `##`, and
    // every other byte — the mark, the line endings — stays.
    const at = read.model.nodes.findIndex((node) => node.kind === 'element' && node.name === 'h1');
    const heading = read.model.nodes[at];
    assert.ok(heading?.start !== undefined && heading.end !== undefined, `${name} has a heading`);
    const span = { start: heading.start, end: heading.end };
    const target = { path: [at], kind: 'element', span };
    const edit = { tag: 'rename-tag', target, to: 'h2' };
    const payload = { pagePath: file, authoredChecksum: read.checksum, edit };
    const written = parsePageEditResult(await harness.invoke('page:edit', payload));
    assert.ok(written.ok, `${name}: the gesture applies`);
    const text = original.toString('utf8');
    const expected = `${text.slice(0, heading.start)}#${text.slice(heading.start)}`;
    assert.equal(fs.readFileSync(file, 'utf8'), expected, `${name}: one byte inserted`);
  }
});

test('a byte-order mark does not hide the frontmatter', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/page-bom-crlf.astro');
  fs.copyFileSync(path.join(FIXTURES, 'page-bom-crlf.astro'), file);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  assert.ok('imports' in read.model);
  assert.deepEqual(
    read.model.imports.map((entry) => entry.name),
    ['Layout'],
  );
  const markdown = path.join(harness.root, 'src/pages/post-bom-crlf.md');
  fs.copyFileSync(path.join(FIXTURES, 'post-bom-crlf.md'), markdown);
  const post = toRecord(toRecord(await harness.invoke('page:read', markdown))?.['model']);
  assert.equal(post?.['mdHasFrontmatter'], true);
  assert.match(String(post?.['extraFrontmatter']), /^title: Shipping the editor/);
});

test('project scans hide save staging while retaining authored empty folders', async () => {
  const harness = fixture();
  try {
    for (const folder of ['.stacki-io', '.stacki/io', 'blog', 'blog/.stacki-io']) {
      fs.mkdirSync(path.join(harness.root, 'src/pages', folder), { recursive: true });
    }
    fs.mkdirSync(path.join(harness.root, '.git/info'), { recursive: true });
    const scan = parseScanResult(await harness.invoke('project:scan', harness.root));
    assert.deepEqual(scan.pageFolders, ['blog']);
    const exclusions = fs.readFileSync(path.join(harness.root, '.git/info/exclude'), 'utf8');
    assert.ok(exclusions.split('\n').includes('.stacki/io/'));
  } finally {
    harness.dispose();
  }
});
