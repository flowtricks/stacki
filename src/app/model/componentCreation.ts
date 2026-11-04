// Creating a component from the selection is one action, so it is one undo
// step: the page edit that put `<Button />` where the markup was, and the file
// src/components/Button.astro that edit imports. The page's half is an
// ordinary edits step (inverse splices, appHistory.ts); the file's half rides
// on it as StepFiles (appTypes.ts), built here.
//
// Order is what keeps the page whole. Undo reverts the page first and deletes
// the file only once every page write is reverted: a page that still imports
// Button.astro is never left without it. Redo writes the file first and
// replays the page after; a page that would not replay takes the file back.

import { assert } from '../../../shared/core/assert';
import type { Digest } from '../../../shared/core/brand';
import type { StepFiles } from '../appTypes';

/** What the file's half needs from the app: main's file calls, a question for
 *  the person, and a rescan so the Components panel shows what is on disk. */
export interface ComponentFileCalls {
  /** Delete the file while it holds the bytes `checksum` names, or anyway when `force`. */
  readonly discard: (request: { readonly checksum: Digest; readonly force: boolean }) => Promise<'deleted' | 'edited' | 'missing'>;
  /** Write the file again, as it was first written; resolves to its checksum. */
  readonly create: () => Promise<Digest>;
  /** The file changed since it was created: may Undo delete it anyway? */
  readonly confirmDelete: () => Promise<boolean>;
  readonly rescan: () => Promise<void>;
}

/** The file half of a component just created, whose file holds `checksum`. */
export function createdComponentFiles(calls: ComponentFileCalls, checksum: Digest): StepFiles {
  // The one piece of state the step keeps: whether the file is on disk, and
  // the bytes it was written with. Only these two closures change it, and
  // each change follows what main answered, so it can't drift from the disk.
  const file: { onDisk: boolean; checksum: Digest } = { onDisk: true, checksum };
  return {
    undo: async () => {
      if (!file.onDisk) {
        return; // Already taken back by an earlier, partial undo.
      }
      let outcome = await calls.discard({ checksum: file.checksum, force: false });
      if (outcome === 'edited') {
        // Somebody changed it since: their edit is not Undo's to throw away
        // unasked. Kept, the page is still restored; only the file stays.
        if (await calls.confirmDelete()) {
          outcome = await calls.discard({ checksum: file.checksum, force: true });
          assert(outcome !== 'edited', 'A forced discard deletes the file');
        }
      }
      file.onDisk = outcome === 'edited';
      await calls.rescan();
    },
    redo: async () => {
      if (file.onDisk) {
        return; // Kept at undo, or never taken back: the file is there to import.
      }
      file.checksum = await calls.create();
      file.onDisk = true;
      await calls.rescan();
    },
  };
}

/** How much of a step's page writes one undo or redo reverted. */
export type PageStep = 'whole' | 'part' | 'none';

export type FilesStepOutcome =
  /** The page stepped as far as `page`, and the files followed it. */
  | { readonly tag: 'stepped'; readonly page: PageStep }
  /** Redo could not write the files back, so the page was not touched. */
  | { readonly tag: 'refused'; readonly message: string }
  /** The page stepped as far as `page`, and then the files' half failed. */
  | { readonly tag: 'files-failed'; readonly page: PageStep; readonly message: string };

/**
 * One undo or redo of a page step that carries files: `revert` reverts its
 * page writes (recording what is left where it belongs) and says how far it
 * got. Without files it is `revert` alone.
 */
export async function stepWithFiles(direction: 'undo' | 'redo', files: StepFiles | undefined, revert: () => Promise<PageStep>): Promise<FilesStepOutcome> {
  if (files === undefined) {
    return { tag: 'stepped', page: await revert() };
  }
  if (direction === 'redo') {
    try {
      await files.redo();
    } catch (error: unknown) {
      return { tag: 'refused', message: messageOf(error) };
    }
    const page = await revert();
    if (page === 'none') {
      // The page refused to replay: the file it would have imported goes again.
      return settled(page, files.undo);
    }
    return { tag: 'stepped', page };
  }
  const page = await revert();
  if (page === 'whole') {
    return settled(page, files.undo);
  }
  // Part of the page still imports the file: it stays until the rest is undone.
  return { tag: 'stepped', page };
}

async function settled(page: PageStep, work: () => Promise<void>): Promise<FilesStepOutcome> {
  try {
    await work();
  } catch (error: unknown) {
    return { tag: 'files-failed', page, message: messageOf(error) };
  }
  return { tag: 'stepped', page };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
