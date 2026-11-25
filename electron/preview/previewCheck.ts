// Main's half of the preview token (plan §9, step 7): is every file a canvas
// rendering came from still the bytes its stamp names? The disk is the truth —
// the watcher is a hint, and a document actor's snapshot can be older than the
// file (plan §2) — so each stamped file is read and hashed here, on demand, for
// the one event that asks. A rendering names any number of files, each read
// whole whatever its size: the check is as large as the files the page used.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toDigest, type Digest } from '../../shared/core/brand';
import { judgePreviewRender, type PreviewRender, type PreviewVerdict, type StampedFileState } from '../../shared/page/previewToken';

/**
 * Judge `render` against the files under `projectPath` now. Asynchronous and
 * streamed: each file is hashed a chunk at a time, so a page or component of
 * any size yields to the main process's loop between chunks instead of
 * stalling every window while it is read whole.
 */
export async function checkPreviewRender(projectPath: string, render: PreviewRender): Promise<PreviewVerdict> {
  const root = path.resolve(projectPath);
  const current = new Map<string, StampedFileState>();
  // One file at a time, in manifest order: the first stale file decides the
  // verdict, and reading in parallel would hold many large files open at once.
  for (const stamp of render.stamps) {
    current.set(stamp.file, await stampedFileState(root, stamp.file));
  }
  assert(current.size === render.stamps.length, 'One state per stamped file');
  return judgePreviewRender(render, current, sha256Text);
}

/** The token of a canonical manifest: SHA-256 of its UTF-8 bytes. */
export function sha256Text(text: string): Digest {
  return toDigest(createHash('sha256').update(text, 'utf8').digest('hex'));
}

// A stamp names a project-relative path, but the page's own code can forge a
// comment, so a path that resolves outside the project reads as missing rather
// than as a file of the user's somewhere else on disk.
async function stampedFileState(root: string, file: string): Promise<StampedFileState> {
  const target = path.resolve(root, ...file.split('/'));
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { tag: 'missing' };
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(target, 'r');
  } catch {
    return { tag: 'missing' };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { tag: 'missing' };
    }
    const hash = createHash('sha256');
    // An explicit chunk size, not the stream default: 1 MiB keeps a 24 MB file to
    // a couple of dozen turns of the loop while one turn stays under a few milliseconds.
    for await (const chunk of handle.createReadStream({ highWaterMark: HASH_CHUNK_BYTES, autoClose: false })) {
      assert(chunk instanceof Buffer, 'A file stream without an encoding yields buffers');
      hash.update(chunk);
    }
    return { tag: 'present', checksum: toDigest(hash.digest('hex')) };
  } finally {
    await handle.close();
  }
}

const HASH_CHUNK_BYTES = 1024 * 1024;
