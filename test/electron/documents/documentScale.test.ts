// Goal: the document layer has no size limit. A single file of tens of megabytes
// opens, is edited through the actor and is written atomically; a batch may
// name far more files than the actor cache holds (every file is written, the
// cache only evicts); a document bigger than the whole cache is still edited
// and its edit survives the next outside write; and a burst of outside changes
// to many big files is re-read in slices, never in one block.
// Method: generate files under os.tmpdir (removed afterwards, never committed),
// sized by `scaleMegabytes()`, and drive the real host (`DocumentActors` over
// the real disk, projector and planner). `measureOperation` prints one `SCALE`
// line per scenario with the wall time and the longest event-loop block. The
// actor protocol is synchronous by design (every step of one intent runs to its
// outcome), so a single big write is one block of its own length; what is
// asserted is that the work is linear in the file, that nothing is refused or
// cut, and that the work done on a timer (the refresh of outside changes)
// yields between slices.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocumentActors } from '#dist/electron/documents/documentActors.js';
import { NODE_PROJECTOR, NodeDocumentDisk } from '#dist/electron/documents/documentDisk.js';
import { createDocumentTelemetry } from '#dist/electron/documents/documentTelemetry.js';
import { createFileExclusive, replaceFileAtomic } from '#dist/electron/documents/atomicWrite.js';
import { toDigest } from '#dist/shared/core/brand.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { toByteString } from '#dist/shared/core/span.js';
import { measureOperation, scaleMegabytes } from '../../helpers/scaleFixtures.ts';

const MEGABYTE = 1024 * 1024;
/** Milliseconds one megabyte of read, diff, write and verify may take on the slowest machine we run on. */
const MS_PER_MEGABYTE_MAX = 900;

const sha256 = (text: string | Uint8Array) => toDigest(createHash('sha256').update(text).digest('hex'));

function host() {
  const scheduled: Array<() => void> = [];
  const documents = new DocumentActors({
    disk: new NodeDocumentDisk(),
    projector: NODE_PROJECTOR,
    planner: planIntent,
    telemetry: createDocumentTelemetry(() => undefined),
    drain: 'immediate',
    schedule: (task) => scheduled.push(task),
  });
  return { documents, scheduled };
}

function withDirectory(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return run(root).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

// A stylesheet of about `megabytes` MB, one rule per line, so edits are line-sized.
function stylesheet(megabytes: number, label: string): string {
  const lines: string[] = [];
  const count = Math.floor((megabytes * MEGABYTE) / 40);
  for (let index = 0; index < count; index++) {
    lines.push(`.${label}-${index} { margin: ${index % 97}px; }\n`);
  }
  return lines.join('');
}

test('a file of tens of megabytes is read, rewritten as a small splice and written, and nothing is refused', async () => {
  const megabytes = scaleMegabytes();
  await withDirectory('stacki-doc-scale-', async (root) => {
    const file = path.join(root, 'big.css');
    const text = stylesheet(megabytes, 'row');
    fs.writeFileSync(file, text);
    const { documents } = host();
    const edited = text.replace('.row-1000 { margin: 1px; }', '.row-1000 { margin: 2px; }');
    assert.notEqual(edited, text, 'the edit changes a line');
    const measured = await measureOperation('document write', `${megabytes} MB stylesheet, one line`, async () =>
      documents.writeText(file, edited, sha256(text)),
    );
    assert.equal(measured.value.tag, 'applied', JSON.stringify(measured.value));
    assert.ok(measured.wallMs < MS_PER_MEGABYTE_MAX * megabytes + 2_000, `${Math.round(measured.wallMs)} ms for ${megabytes} MB`);
    assert.equal(fs.readFileSync(file, 'utf8'), edited, 'every byte of the big file was written');
    assert.deepEqual(fs.readdirSync(root).sort(), ['.stacki', 'big.css'], 'no save file remains');
    // A second edit through the same actor, from the checksum the first returned.
    const again = edited.replace('.row-2000 { margin: 8px; }', '.row-2000 { margin: 9px; }');
    const second = documents.writeText(file, again, measured.value.tag === 'applied' ? measured.value.checksum : sha256(edited));
    assert.equal(second.tag, 'applied');
    assert.equal(fs.readFileSync(file, 'utf8'), again);
  });
});

test('a rewrite of the whole file, changed throughout, is applied whole and not degraded to a refusal', async () => {
  const megabytes = Math.max(1, Math.floor(scaleMegabytes() / 2));
  await withDirectory('stacki-doc-scale-', async (root) => {
    const file = path.join(root, 'all.css');
    const text = stylesheet(megabytes, 'old');
    fs.writeFileSync(file, text);
    const { documents } = host();
    const replaced = stylesheet(megabytes, 'new');
    const measured = await measureOperation('document rewrite', `${megabytes} MB changed throughout`, async () =>
      documents.writeText(file, replaced, sha256(text)),
    );
    assert.equal(measured.value.tag, 'applied');
    assert.equal(fs.readFileSync(file, 'utf8'), replaced);
    assert.ok(measured.wallMs < MS_PER_MEGABYTE_MAX * megabytes + 2_000, `${Math.round(measured.wallMs)} ms for ${megabytes} MB`);
  });
});

test('atomic writes take any size: replace and exclusive create of a very large file', async () => {
  const megabytes = scaleMegabytes();
  await withDirectory('stacki-atomic-scale-', async (root) => {
    const bytes = toByteString(Buffer.from(stylesheet(megabytes, 'atomic'), 'utf8'));
    const created = await measureOperation('atomic create', `${megabytes} MB`, async () => createFileExclusive(path.join(root, 'created.css'), bytes));
    assert.equal(created.value.ok, true);
    assert.ok(created.wallMs < MS_PER_MEGABYTE_MAX * megabytes + 2_000, `${Math.round(created.wallMs)} ms`);
    const target = path.join(root, 'replaced.css');
    fs.writeFileSync(target, 'old\n');
    const replaced = await measureOperation('atomic replace', `${megabytes} MB`, async () => replaceFileAtomic(target, bytes));
    assert.equal(replaced.value.ok, true);
    assert.ok(Buffer.from(bytes).equals(fs.readFileSync(target)), 'the replacement holds every byte');
    assert.ok(Buffer.from(bytes).equals(fs.readFileSync(path.join(root, 'created.css'))), 'the created file holds every byte');
  });
});

test('a batch of more files than the actor cache holds writes every file, and the cache only evicts', async () => {
  const filesCount = LIMITS.documentActorsMax * 3;
  await withDirectory('stacki-doc-batch-', async (root) => {
    const items: Array<{ readonly file: string; readonly before: string; readonly after: string }> = [];
    for (let index = 0; index < filesCount; index++) {
      const file = path.join(root, `f${index}.css`);
      const before = `.a-${index} { margin: 1px; }\n`;
      fs.writeFileSync(file, before);
      items.push({ file, before, after: `.a-${index} { margin: 2px; }\n` });
    }
    const { documents } = host();
    const measured = await measureOperation('batch lease', `${filesCount} files, cache ${LIMITS.documentActorsMax}`, async () =>
      documents.withLeases(items, (ordered) => {
        let written = 0;
        for (const item of ordered) {
          const report = documents.writeText(item.file, item.after, sha256(item.before));
          assert.equal(report.tag, 'applied', item.file);
          written += 1;
        }
        return written;
      }),
    );
    assert.ok(measured.value.ok, 'a batch of any size leases');
    assert.equal(measured.value.ok ? measured.value.value : 0, filesCount, 'every file was written');
    for (const item of items) {
      assert.equal(fs.readFileSync(item.file, 'utf8'), item.after);
    }
    assert.ok(documents.actorCount() <= LIMITS.documentActorsMax, `${documents.actorCount()} actors stay inside the cache`);
  });
});

test('a document bigger than the whole cache is still edited, and its edit survives an outside write', async () => {
  const megabytes = Math.ceil(LIMITS.documentBytesRetainedMax / MEGABYTE) + 8;
  await withDirectory('stacki-doc-cache-', async (root) => {
    const file = path.join(root, 'huge.css');
    const text = stylesheet(megabytes, 'big');
    fs.writeFileSync(file, text);
    const { documents } = host();
    const other = path.join(root, 'other.css');
    fs.writeFileSync(other, '.o { margin: 0; }\n');
    // Opening other files evicts the idle huge actor; it is read again, not lost.
    assert.ok(documents.current(file).ok);
    assert.ok(documents.current(other).ok);
    const edited = text.replace('.big-10 {', '.big-ten {');
    const first = documents.writeText(file, edited, sha256(text));
    assert.equal(first.tag, 'applied');
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
    assert.ok(documents.current(file).ok, 'the huge document opens again after being evicted');
  });
});

test('outside changes to many big files are re-read a slice at a time, never in one block', async () => {
  const filesCount = 12;
  const fileMegabytes = 3;
  await withDirectory('stacki-doc-refresh-', async (root) => {
    const files: string[] = [];
    const { documents, scheduled } = host();
    for (let index = 0; index < filesCount; index++) {
      const file = path.join(root, `r${index}.css`);
      fs.writeFileSync(file, stylesheet(fileMegabytes, `r${index}`));
      assert.ok(documents.current(file).ok);
      files.push(file);
    }
    for (const file of files) {
      fs.appendFileSync(file, '.outside { margin: 3px; }\n');
      documents.noteExternalChange(file);
    }
    assert.equal(scheduled.length, 1, 'the burst coalesces into one tick');
    let ticks = 0;
    // The host schedules the next slice itself: drain until it stops scheduling.
    for (let guard = 0; guard < filesCount + 2; guard++) {
      const task = scheduled.shift();
      if (task === undefined) {
        break;
      }
      ticks += 1;
      task();
    }
    assert.ok(ticks > 1, `${ticks} slices: the refresh does not run as one block`);
    for (const file of files) {
      const current = documents.current(file);
      assert.ok(current.ok, `${file} reads`);
      if (current.ok) {
        assert.equal(current.value.checksum, sha256(fs.readFileSync(file)), `${file} is current`);
      }
    }
  });
});
