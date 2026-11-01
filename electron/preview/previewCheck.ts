// Main's half of the preview token (plan §9, step 7): is every file a canvas
// rendering came from still the bytes its stamp names? The disk is the truth —
// the watcher is a hint, and a document actor's snapshot can be older than the
// file (plan §2) — so each stamped file is read and hashed here, on demand, for
// the one event that asks. A rendering names at most previewManifestFilesMax
// files, each read only when it is inside sourceBytesMax.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toDigest, type Digest } from '../../shared/core/brand';
import { LIMITS } from '../../shared/core/limits';
import { judgePreviewRender, type PreviewRender, type PreviewVerdict, type StampedFileState } from '../../shared/page/previewToken';

/** Judge `render` against the files under `projectPath` now. */
export function checkPreviewRender(projectPath: string, render: PreviewRender): PreviewVerdict {
  assert(render.stamps.length <= LIMITS.previewManifestFilesMax, 'A parsed render is bounded');
  const root = path.resolve(projectPath);
  const current = new Map<string, StampedFileState>();
  for (const stamp of render.stamps) {
    current.set(stamp.file, stampedFileState(root, stamp.file));
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
function stampedFileState(root: string, file: string): StampedFileState {
  const target = path.resolve(root, ...file.split('/'));
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { tag: 'missing' };
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, 'r');
  } catch {
    return { tag: 'missing' };
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      return { tag: 'missing' };
    }
    if (LIMITS.sourceBytesMax < stats.size) {
      return { tag: 'over-limit' };
    }
    const bytes = fs.readFileSync(descriptor);
    if (LIMITS.sourceBytesMax < bytes.length) {
      return { tag: 'over-limit' }; // It grew between the stat and the read.
    }
    return { tag: 'present', checksum: toDigest(createHash('sha256').update(bytes).digest('hex')) };
  } finally {
    fs.closeSync(descriptor);
  }
}
