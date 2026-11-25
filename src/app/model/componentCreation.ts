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
    // The file itself asks the person when it was edited since (confirmDelete), so it never refuses a step up front.
    check: async () => undefined,
    undoBeforePage: async () => undefined,
    redoAfterPage: async () => undefined,
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

/** Files work that only undoes and redoes around the page (an audit fix): it never refuses a step, and has nothing to do before or after the page. */
export function plainStepFiles(work: Pick<StepFiles, 'undo' | 'redo'>): StepFiles {
  return { check: async () => undefined, undoBeforePage: async () => undefined, undo: work.undo, redo: work.redo, redoAfterPage: async () => undefined };
}

/** What the stylesheet half of a move needs: a sheet's text as it is now, a write, and the words for sheets changed since. */
export interface StyleSheetCalls {
  readonly read: (path: string) => Promise<string>;
  /** Writes `css` only while the sheet holds exactly `expected`, and throws otherwise (main's actor checks, style:writeFile). */
  readonly write: (path: string, css: string, expected: string) => Promise<void>;
  /** The sentence for sheets that changed since the move (or since its undo), which refuses the step. */
  readonly changed: (rels: readonly string[]) => string;
}

/** One stylesheet a move edits, with its text before and after the move. */
export interface MovedSheet {
  readonly path: string;
  readonly rel: string;
  readonly before: string;
  readonly after: string;
}

/**
 * The stylesheets "Move styles" edited, as a step's files. All or nothing: a step goes ahead only while every sheet
 * holds exactly the text it expects (`check`), and each write is refused by main unless the sheet still does. Copy
 * first, delete last: undo puts the rules back before the page stops using the component (undoBeforePage), and redo
 * takes them out only after the page uses it again (redoAfterPage), so no rule is ever missing between two writes;
 * at worst a crash leaves one written twice. The first move's own clean-up is `redoAfterPage`.
 */
export function movedStyleFiles(sheets: readonly MovedSheet[], calls: StyleSheetCalls): StepFiles {
  assert(sheets.length > 0, 'movedStyleFiles: a move edits at least one sheet');
  assert(
    sheets.every((sheet) => sheet.before !== sheet.after),
    'movedStyleFiles: every sheet the move lists changed',
  );
  // A sheet holding neither of its two texts was edited by someone: that is what refuses a step. One already at
  // the step's target is left alone, so a step run again after a partial one (see StepFiles) writes nothing twice.
  const changedSheets = async (): Promise<readonly string[]> => {
    const changed: string[] = [];
    for (const sheet of sheets) {
      const now = await calls.read(sheet.path);
      if (now !== sheet.before && now !== sheet.after) {
        changed.push(sheet.rel);
      }
    }
    return changed;
  };
  const swap = async (from: 'before' | 'after', to: 'before' | 'after'): Promise<void> => {
    for (const sheet of sheets) {
      if ((await calls.read(sheet.path)) !== sheet[to]) {
        await calls.write(sheet.path, sheet[to], sheet[from]);
      }
    }
  };
  return {
    check: async () => {
      const changed = await changedSheets();
      assert(changed.length <= sheets.length, 'movedStyleFiles: only listed sheets can have changed');
      return changed.length === 0 ? undefined : calls.changed(changed);
    },
    undoBeforePage: () => swap('after', 'before'),
    undo: async () => undefined,
    redo: async () => undefined,
    redoAfterPage: () => swap('before', 'after'),
  };
}

/**
 * Two files halves as one step: `first` is made before `second` and taken back after it. Each half keeps its own
 * order around the page; the checks run both, the first refusal winning.
 */
export function sequencedFiles(first: StepFiles, second: StepFiles): StepFiles {
  return {
    check: async (direction) => (await first.check(direction)) ?? (await second.check(direction)),
    undoBeforePage: async () => {
      await second.undoBeforePage();
      await first.undoBeforePage();
    },
    undo: async () => {
      await second.undo();
      await first.undo();
    },
    redo: async () => {
      await first.redo();
      await second.redo();
    },
    redoAfterPage: async () => {
      await first.redoAfterPage();
      await second.redoAfterPage();
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
  // All or nothing: a file that cannot follow refuses the whole step before anything is written.
  const problem = await files.check(direction);
  if (problem !== undefined) {
    return { tag: 'refused', message: problem };
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
    // Only once the page reads the files again do they give up what it now reads from them.
    return settled(page, files.redoAfterPage);
  }
  try {
    // What the page will read again once reverted comes back first, so it is never missing.
    await files.undoBeforePage();
  } catch (error: unknown) {
    return { tag: 'refused', message: messageOf(error) };
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
