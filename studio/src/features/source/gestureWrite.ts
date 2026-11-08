// A Desktop edit gesture, written to a Studio page the way Desktop writes it. The
// gesture states its requests against the page's parse (src/editor/pageEdits.ts,
// sendGesture); main drafts each into a planner intent (editRequests.ts) and
// plans the batch in memory, rebasing each through the ones before it
// (editPreview.ts, previewEdits). Studio vendors those three, so the order of
// attempts is the same:
//
//   1. the gesture's own requests (a rename-tag, a rename-binding, a set-frontmatter);
//   2. refused as unsupported, the smallest changed nodes restated (replace-node),
//      with the frontmatter first when it changed;
//   3. refused again, the whole predicted page, mapped onto the bytes by its
//      semantic hunks only (replace-page).
//
// A batch is all or nothing, as page:editBatch is: a refusal leaves the page as
// it was and says why. Studio's document is shared text, so the result is the
// page's new text, which the caller hands to the shared document.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { toByteString } from '../../../vendor/stacki/shared/core/span';
import { EDIT_BATCH_EDITS_MAX, type Edit } from '../../../vendor/stacki/shared/engine/editRequest';
import { describeRejection, type RejectionReason } from '../../../vendor/stacki/shared/engine/intent';
import { parsePageResult } from '../../../vendor/stacki/shared/page/pageNode';
import { parsePage } from '../../../vendor/stacki/electron/parse/astroParser';
import { previewEdits } from '../../../vendor/stacki/electron/documents/editPreview';
import { nodeRefIn, replacementPageRequest, replacementRequests, type EditGesture, type PageOrigin } from '../../../vendor/stacki/src/editor/pageEdits';
import type { EditorModel } from '../../../vendor/stacki/src/editor/pageView';
import { NODE_PROJECTOR } from './documentHost';

/** Every Studio page is planned as the .astro it is parsed as (source.ts parses
 * every document that way, so the node ids the panel names are that parse's). */
const PAGE_FILE = '/studio/source.astro';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The page as a gesture states its requests against it. */
export function pageOrigin(source: string): PageOrigin & { readonly model: EditorModel } {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  if (!parsed.editable) {
    throw new Error('Fix the page syntax before changing it here.');
  }
  const checksum = NODE_PROJECTOR.hash(toByteString(encoder.encode(source)));
  return { checksum, source, model: parsed.model };
}

/** The page `source` with `gesture` written, or an error saying why it cannot be. */
export function writeGesture(source: string, gesture: EditGesture): string {
  const origin = pageOrigin(source);
  const refOf = (id: string) => nodeRefIn(origin, id);
  const specialized = gesture.request(refOf, origin);
  if (specialized !== undefined && specialized.length > 0) {
    const sent = planned(source, specialized);
    if (sent.ok) {
      return sent.text;
    }
    if (sent.reason !== 'unsupported-operation' || specialized.every((edit) => edit.tag === 'replace-node')) {
      throw new Error(refusal(sent.reason));
    }
  }
  const predicted = gesture.apply(origin.model);
  if (predicted === origin.model) {
    return source; // Already as asked: nothing to write, and no failure to report.
  }
  const replacements = replacementRequests(origin, predicted, refOf);
  if (replacements !== undefined && replacements.length > 0) {
    const sent = planned(source, replacements);
    if (sent.ok) {
      return sent.text;
    }
    if (sent.reason !== 'unsupported-operation') {
      throw new Error(refusal(sent.reason));
    }
  }
  const page = planned(source, [replacementPageRequest(predicted)]);
  if (page.ok) {
    return page.text;
  }
  throw new Error(refusal(page.reason));
}

type Planned = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: RejectionReason };

function planned(source: string, edits: readonly Edit[]): Planned {
  assert(edits.length > 0, 'A write states at least one request');
  if (edits.length > EDIT_BATCH_EDITS_MAX) {
    return { ok: false, reason: 'resource-limit' };
  }
  const bytes = toByteString(encoder.encode(source));
  const result = previewEdits(PAGE_FILE, bytes, NODE_PROJECTOR.hash(bytes), edits);
  if (!result.ok) {
    return { ok: false, reason: result.error };
  }
  return { ok: true, text: decoder.decode(result.value.bytes) };
}

/** What the panel says for a refused write: the planner's own reason, and where to go. */
function refusal(reason: RejectionReason): string {
  return `${describeRejection(reason)} Make this change in Code.`;
}
