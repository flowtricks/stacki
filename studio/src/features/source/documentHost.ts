// What Desktop's edit pipeline reads from its document host, for Studio's browser:
// the shapes an edit is built in (electron/documents/documentReports.ts) and the
// projector that turns bytes into snapshots (NODE_PROJECTOR in
// electron/documents/documentDisk.ts). Studio vendors Desktop's request drafting
// (editRequests.ts) and its in-memory batch planner (editPreview.ts) with their
// `./documentActors` and `./documentDisk` imports pointed here
// (scripts/shared-source.json), because those modules also hold the disk, the
// lock and node:crypto, none of which a browser has or a plan needs.
//
// The projector is Desktop's: the same parsers, the same single-splice shortcut,
// and SHA-256 checksums, so a batch rebases through its own commits exactly as
// main rebases them.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { toDigest, type Digest, type FilePath } from '../../../vendor/stacki/shared/core/brand';
import { decodeUtf8, type ByteString } from '../../../vendor/stacki/shared/core/span';
import type { Projector } from '../../../vendor/stacki/shared/engine/documentActor';
import type { Intent } from '../../../vendor/stacki/shared/engine/intent';
import type { Plan } from '../../../vendor/stacki/shared/engine/planner';
import { projectValueSplice } from '../../../vendor/stacki/shared/engine/projectionPatch';
import { parsePageResult } from '../../../vendor/stacki/shared/page/pageNode';
import { createLazySnapshot, createSnapshot, type Snapshot } from '../../../vendor/stacki/shared/page/snapshot';
import { projectOpaqueDocument, projectPage, type Projection } from '../../../vendor/stacki/shared/page/sourceProjection';
import { parsePage } from '../../../vendor/stacki/electron/parse/astroParser';
import { parseMarkdownPage } from '../../../vendor/stacki/electron/parse/markdownParser';
import { sha256Bytes } from '../../shared/sha256';

/** The anchor and operation of an intent, built against the snapshot it names. */
export type IntentDraft = Pick<Intent, 'anchor' | 'operation'>;

/** What an edit is built against: the bytes it was authored on, the bytes now,
 * and what lies between them. */
export interface EditBase {
  readonly authored: Snapshot;
  readonly current: Snapshot;
  readonly history: 'unchanged' | 'own-commits' | 'outside';
}

/** A built edit, and which of the two snapshots it names. */
export interface BuiltEdit {
  readonly draft: IntentDraft;
  readonly basis: 'authored' | 'current';
}

const hashBytes = (bytes: ByteString): Digest => toDigest(sha256Bytes(bytes));

/** Bytes → projection, through the parser the file's kind takes. */
export function projectDocument(file: FilePath, bytes: ByteString): Projection {
  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) {
    return { tag: 'parse-error', byteLength: bytes.length, diagnostics: [{ message: decoded.error.message, near: undefined }] };
  }
  const text = decoded.value;
  const projection = /\.astro$/i.test(file)
    ? projectPage(text, parsePageResult(parsePage(text, { locs: true })))
    : /\.mdx?$/i.test(file)
      ? projectPage(text, parsePageResult(parseMarkdownPage(text, { mdx: /\.mdx$/i.test(file) })))
      : projectOpaqueDocument(text);
  assert(projection.byteLength === bytes.length, 'The projection measures the bytes it read');
  return projection;
}

export const NODE_PROJECTOR: Projector = {
  hash: hashBytes,
  snapshot: (file, bytes) => createLazySnapshot({ path: file, bytes }, (own) => projectDocument(file, own), hashBytes),
  candidate: (file: FilePath, base: Snapshot, plan: Plan, bytes: ByteString) => {
    const [splice, ...others] = plan.splices;
    if (splice !== undefined && others.length === 0) {
      if (plan.candidate === 'must-parse') {
        const patched = projectValueSplice(base.projection, base.bytes, splice);
        if (patched !== undefined) {
          return createSnapshot({ path: file, bytes, projection: patched }, hashBytes);
        }
      }
    }
    return createLazySnapshot({ path: file, bytes }, (own) => projectDocument(file, own), hashBytes);
  },
};
