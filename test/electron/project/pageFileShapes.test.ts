// Goal: Stacki reads and edits page files however they are encoded or protected. Line endings
// (CRLF) and a byte-order mark survive an edit byte for byte; an empty page, a binary page and a
// dangling link read as a result and never as a crash; a read-only page refuses the edit with a
// specific failure and leaves the file as it was; a page the process may not read is a failure
// result, not an exception.
// Method: generated pages in a temporary project; the real page:read and page:edit handlers run
// in the windowless harness. An edit is a code patch (the code window's save): one hunk
// replacing a known word, so the bytes that must not change are every byte outside it.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { buildProject, removeProject, permissionsEnforced } from '../../helpers/projectFixtures.ts';
import { parsePageDiskRead } from '#dist/shared/ipc/pageSave.js';
import { toRecord } from '#dist/shared/core/record.js';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pageshapes-user-'));
const harness = mainHarness(userData);
test.after(() => {
  harness.dispose();
  fs.rmSync(userData, { recursive: true, force: true });
});

const base = { 'package.json': '{"dependencies":{"astro":"5"}}' };

/** Replaces the first `from` in the page's bytes with `to` through the code editor's save path. */
async function patch(file: string, from: string, to: string): Promise<unknown> {
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  const bytes = fs.readFileSync(file);
  const start = bytes.indexOf(from);
  assert.ok(start >= 0, `${from} is in the page`);
  return harness.invoke('page:edit', {
    pagePath: file,
    authoredChecksum: read.checksum,
    edit: { tag: 'code-patch', hunks: [{ span: { start, end: start + Buffer.byteLength(from) }, expected: from, text: to }] },
  });
}

test('CRLF line endings and the bytes around an edit are kept exactly', async (context) => {
  const original = '---\r\nconst a = 1;\r\n---\r\n<h1 class="x">Hi</h1>\r\n<p>Tail</p>\r\n';
  const built = buildProject({ ...base, 'src/pages/crlf.astro': original });
  context.after(() => removeProject(built.root));
  const file = path.join(built.root, 'src/pages/crlf.astro');
  const result = toRecord(await patch(file, 'Hi', 'Yo'));
  assert.equal(result?.['ok'], true, JSON.stringify(result));
  assert.equal(fs.readFileSync(file, 'utf8'), original.replace('Hi', 'Yo'));
});

test('a byte-order mark and its CRLF lines survive an edit', async (context) => {
  const original = '﻿---\r\n---\r\n<h1>Hi</h1>\r\n';
  const built = buildProject({ ...base, 'src/pages/bom.astro': original });
  context.after(() => removeProject(built.root));
  const file = path.join(built.root, 'src/pages/bom.astro');
  const result = toRecord(await patch(file, 'Hi', 'Yo'));
  assert.equal(result?.['ok'], true, JSON.stringify(result));
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the mark is still the first three bytes');
  assert.equal(bytes.toString('utf8'), original.replace('Hi', 'Yo'));
});

test('empty, binary and dangling pages read as results, never as crashes', async (context) => {
  const built = buildProject({
    ...base,
    'src/pages/empty.astro': '',
    'src/pages/binary.astro': new Uint8Array([0, 255, 0, 254, 1, 2, 0xc3]),
    'src/pages/lone.md': '',
    'src/pages/gone.astro': { symlink: 'missing.astro' },
  });
  context.after(() => removeProject(built.root));
  for (const name of ['empty.astro', 'binary.astro', 'lone.md']) {
    const settled = await Promise.allSettled([harness.invoke('page:read', path.join(built.root, 'src/pages', name))]);
    const outcome = settled[0];
    assert.ok(outcome !== undefined);
    if (outcome.status === 'fulfilled') {
      assert.doesNotThrow(() => parsePageDiskRead(outcome.value), name);
    } else {
      // A refusal is an Error with a message that names the file, not an unhandled crash.
      assert.ok(outcome.reason instanceof Error, name);
      assert.ok(outcome.reason.message.length > 0, name);
    }
  }
  await assert.rejects(harness.invoke('page:read', path.join(built.root, 'src/pages/gone.astro')), /ENOENT|no such file|missing/i);
});

test('a read-only page refuses an edit with a specific failure and is left untouched', async (context) => {
  if (!permissionsEnforced()) {
    context.skip('permission bits are not enforced for this user');
    return;
  }
  const original = '<h1>Hi</h1>\n';
  const built = buildProject({ ...base, 'src/pages/locked.astro': { text: original, mode: 0o444 } });
  context.after(() => removeProject(built.root));
  const file = path.join(built.root, 'src/pages/locked.astro');
  const result = toRecord(await patch(file, 'Hi', 'Yo'));
  assert.equal(result?.['ok'], false, 'the edit is refused');
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'the file is unchanged');
  assert.match(JSON.stringify(result), /read-only|read only|permission|EACCES|locked/i, 'the failure says why');
});

test('a page the process may not read is a failure, not an unhandled exception', async (context) => {
  if (!permissionsEnforced()) {
    context.skip('permission bits are not enforced for this user');
    return;
  }
  const built = buildProject({ ...base, 'src/pages/nope.astro': { text: '<p/>', mode: 0o000 } });
  context.after(() => removeProject(built.root));
  await assert.rejects(harness.invoke('page:read', path.join(built.root, 'src/pages/nope.astro')), /EACCES|permission/i);
});
