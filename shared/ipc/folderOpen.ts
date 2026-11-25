// Opening a folder the person hands Stacki from outside the app: dropped on the window, dropped on the
// app's icon (the Dock on macOS, the program or a shortcut on Windows and Linux), or named on the command
// line. The contract of `project:inspectFolder` (the window drop asks what a folder is), of
// `project:takeOpenedFolders` (the renderer collects the folders that arrived before it could listen) and of
// the `project:folderOpened` push (one that arrives while it listens).
//
// Each answer is what "Open from folder" would have made of the same folder (`SiteFolderChoice` without
// `canceled`), or why the path is not a folder Stacki can open. Main decides from the disk; the renderer only
// routes the answer, so a path the renderer names is never trusted until main has looked at it.
import { list, record } from '../core/boundary';
import { parseSiteFolderChoice, type SiteFolderChoice } from './astroCopy';

export const FOLDER_OPEN_LIMITS = {
  /** Folders held for a window that is not listening yet; one more is refused, not queued. */
  queueMax: 16,
  /** Command-line arguments read for folder paths, at launch or from a second launch. */
  argumentsMax: 64,
  /** Dropped items the window looks at for a folder: the first folder opens, the rest are counted. */
  dropItemsMax: 64,
} as const satisfies Record<string, number>;

/** Why a path cannot be opened. `missing`: nothing is there. `notFolder`: a file. `unreadable`: anything else (no access, a loop of links, a path too long or not absolute). */
export const FOLDER_REJECTIONS = ['missing', 'notFolder', 'unreadable'] as const;
export type FolderRejection = (typeof FOLDER_REJECTIONS)[number];

export type FolderOpenChoice = Exclude<SiteFolderChoice, { readonly kind: 'canceled' }> | { readonly kind: 'rejected'; readonly reason: FolderRejection };

export function parseFolderRejection(input: unknown): FolderRejection {
  const reason = FOLDER_REJECTIONS.find((known) => known === input);
  if (reason === undefined) {
    throw new Error('FolderRejection: unknown value');
  }
  return reason;
}

export function parseFolderOpenChoice(input: unknown): FolderOpenChoice {
  const fields = record(input);
  if (fields['kind'] === 'rejected') {
    return { kind: 'rejected', reason: parseFolderRejection(fields['reason']) };
  }
  const choice = parseSiteFolderChoice(input);
  if (choice.kind === 'canceled') {
    throw new Error('FolderOpenChoice.kind: a folder that arrived is never canceled');
  }
  return choice;
}

export function parseFolderOpenChoices(input: unknown): readonly FolderOpenChoice[] {
  const choices = list(parseFolderOpenChoice)(input);
  if (choices.length > FOLDER_OPEN_LIMITS.queueMax) {
    throw new Error('FolderOpenChoices: exceeds limit');
  }
  return choices;
}
