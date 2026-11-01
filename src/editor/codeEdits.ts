// The code editor's save (plan §3.6, §7; step 8). The page's unsaved edits are
// its text; one save sends the byte diff from the baseline that text descends
// from (src/editor/pageEdits.ts, `CodeBaseline`) through `page:edit`, where the page's
// actor splices it like any other edit. Nothing here writes a whole file.
//
// Why a baseline and not the text: the actor maps a patch through an outside
// edit elsewhere in the file and merges it; a whole-file write could only
// overwrite it or refuse. A patch that overlaps an outside change comes back
// `merge-conflict`, and the page shows the conflict notice with that reason —
// the text stays in the editor, unsaved (plan §7, rejection contract).
//
// When a save lands while the user kept typing, the reply may hold more than
// was sent (the merged outside edit). The typing since is then merged into the
// reply's text before the next patch is diffed (`mergeTyping`), so the next
// save never takes the merged edit back out.
import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import { diffCodePatch, mergeTyping } from '../../shared/engine/codePatch';
import type { EditRequest } from '../../shared/engine/editRequest';
import { describeRejection, type RejectionReason, type SourceEdit } from '../../shared/engine/intent';
import type { PageDiskRead, PageEditError, PageEdited } from '../../shared/ipc/pageSave';
import type { Result } from '../../shared/core/result';
import type { CodeBaseline, EditDrafts } from './pageEdits';

/** How one code save ended. */
export type CodeSaveOutcome =
  /** The disk holds the page's text; `last` is the page as it is now, and
   * `inverse` what Undo reverts — undefined when nothing was written (the
   * text was already the disk's). */
  | {
      readonly tag: 'applied';
      readonly last: PageDiskRead;
      readonly inverse: readonly SourceEdit[] | undefined;
    }
  /** The file is not what the text descends from, and the two could not be
   * merged. `baseChecksum` is the base the refusal is relative to. */
  | {
      readonly tag: 'refused';
      readonly reason: RejectionReason | undefined;
      readonly baseChecksum: Digest;
      readonly diskChecksum: Digest;
    }
  /** Not saved now; the text stays unsaved and the next save tries again. */
  | { readonly tag: 'failed'; readonly message: string };

export interface CodeSaveInput {
  readonly path: string;
  /** The page's text: what the disk should hold. */
  readonly text: string;
  /** The bytes the text is a patch of: the code entry's baseline. */
  readonly baseline: CodeBaseline;
  /** The checksum the page's edits name now: the app's last reply's. */
  readonly base: Digest;
  /** The checksum the typing began from, for a refusal's notice. */
  readonly stateBase: Digest;
  /** Where the baseline of typing done during the save is advanced. */
  readonly store: EditDrafts;
  readonly send: (request: EditRequest) => Promise<Result<PageEdited, PageEditError>>;
  /** The page as on disk now, for a baseline the user rebased onto it. */
  readonly read: (path: string) => Promise<PageDiskRead>;
}

/** The patch from, and the target of, one save. */
interface Plan {
  readonly checksum: Digest;
  readonly from: string;
  readonly target: string;
}

export async function sendCode(input: CodeSaveInput): Promise<CodeSaveOutcome> {
  const planned = await planCode(input);
  if (planned.tag !== 'plan') {
    return planned;
  }
  const plan = planned.plan;
  const patch = diffCodePatch(plan.from, plan.target);
  if (!patch.ok) {
    // Past the payload bound: refused whole, never truncated (plan §8).
    return { tag: 'failed', message: describeRejection(patch.error) };
  }
  if (patch.value.length === 0) {
    return unchanged(input, plan); // The disk already holds this text.
  }
  const answer = await input.send({
    pagePath: input.path,
    authoredChecksum: plan.checksum,
    edit: { tag: 'code-patch', hunks: patch.value },
  });
  if (answer.ok) {
    const { checksum, source } = answer.value;
    // Every hunk replaces bytes with other bytes, so an applied patch always
    // leaves a new version; the text it aimed at is in it unless merged away.
    assert(checksum !== plan.checksum, 'An applied patch changes the bytes');
    input.store.codeSaved(input.path, { checksum, source, typedFrom: plan.target });
    return { tag: 'applied', last: answer.value, inverse: answer.value.inverse };
  }
  return codeRefusal(answer.error, plan.checksum);
}

// Where the patch starts and what it aims at: the known baseline, with the
// typing since merged into what the disk holds; or the disk itself, read now.
async function planCode(input: CodeSaveInput): Promise<{ readonly tag: 'plan'; readonly plan: Plan } | CodeSaveOutcome> {
  const baseline = input.baseline;
  switch (baseline.tag) {
    case 'known': {
      const merged = mergeTyping(baseline.typedFrom, input.text, baseline.source);
      if (merged.ok) {
        const plan = { checksum: baseline.checksum, from: baseline.source, target: merged.value };
        return { tag: 'plan', plan };
      }
      if (merged.error === 'resource-limit') {
        return { tag: 'failed', message: describeRejection(merged.error) };
      }
      // The typing and what the last save merged in changed the same text.
      // Its base is the page's own: the bytes before that save, which the
      // saver's base has already advanced past.
      assert(baseline.typedFrom !== baseline.source, 'Only a merged save leaves text to merge');
      assert(input.stateBase !== baseline.checksum, 'The typing began before that save');
      return {
        tag: 'refused',
        reason: 'merge-conflict',
        baseChecksum: input.stateBase,
        diskChecksum: baseline.checksum,
      };
    }
    case 'disk': {
      const disk = await input.read(input.path);
      if (disk.checksum !== input.base) {
        // It moved again since the user chose: ask again, never write over it.
        return {
          tag: 'refused',
          reason: undefined,
          baseChecksum: input.base,
          diskChecksum: disk.checksum,
        };
      }
      const plan = { checksum: disk.checksum, from: disk.source, target: input.text };
      return { tag: 'plan', plan };
    }
    default: {
      const exhaustive: never = baseline;
      return exhaustive;
    }
  }
}

// No hunks: the text is the baseline's. The page is saved when the disk still
// holds that baseline; the read is the page as written.
async function unchanged(input: CodeSaveInput, plan: Plan): Promise<CodeSaveOutcome> {
  const disk = await input.read(input.path);
  if (disk.checksum === plan.checksum) {
    input.store.codeSaved(input.path, {
      checksum: disk.checksum,
      source: disk.source,
      typedFrom: plan.target,
    });
    return { tag: 'applied', last: disk, inverse: undefined };
  }
  return {
    tag: 'refused',
    reason: undefined,
    baseChecksum: plan.checksum,
    diskChecksum: disk.checksum,
  };
}

// Every refusal keeps the text and the baseline: a transient failure is sent
// again as it was; a write that may have landed is too, because its hunks'
// neighbourhood then holds the patch's own bytes and the actor refuses to
// apply it twice (a stale hunk maps only whole, with context).
function codeRefusal(error: PageEditError, authored: Digest): CodeSaveOutcome {
  switch (error.code) {
    case 'rejected': {
      const disk = error.diskChecksum;
      if (disk === undefined || disk === authored) {
        // Nothing changed under the patch: the reason is the patch's own (a
        // size limit), or the file could not be read; not a conflict.
        return { tag: 'failed', message: error.message };
      }
      assert(disk !== authored, 'A conflict names bytes other than the ones patched');
      return { tag: 'refused', reason: error.reason, baseChecksum: authored, diskChecksum: disk };
    }
    case 'missing':
    case 'filesystem':
    case 'backpressured':
    case 'write-race':
    case 'uncertain':
      return { tag: 'failed', message: error.message };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
