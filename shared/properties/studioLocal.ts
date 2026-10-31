// Where Studio keeps what it writes into a project for itself: drafts and their
// history, uploads, publishing state, and its update backups. All of it lives
// under `.stacki/studio/`, which ignores its own contents (`*` in its
// `.gitignore`), so the rest of `.stacki/` — shared project settings — stays
// tracked. Older Studios wrote `.studio-state/` and `.stacki-studio/` at the
// project root; the move to here is studioLocalMove.ts.

import { assert } from '../core/assert';

export const STUDIO_LOCAL_DIRECTORY = '.stacki/studio';
/** Drafts, the draft workspace's history, uploads and publishing state. */
export const STUDIO_STATE_DIRECTORY = '.stacki/studio/state';
/** The updater's staging, backups and lock. */
export const STUDIO_UPDATES_DIRECTORY = '.stacki/studio/updates';
/** Where each lived before, by where it lives now: moved once, on start. */
export const STUDIO_LEGACY_DIRECTORIES: Readonly<Record<string, string>> = {
  [STUDIO_STATE_DIRECTORY]: '.studio-state',
  [STUDIO_UPDATES_DIRECTORY]: '.stacki-studio',
};

/**
 * Whether a project-relative POSIX path is Studio's own local state — never
 * site content, so never copied, published or committed. Older layouts count.
 */
export function isStudioLocalPath(file: string): boolean {
  assert(!file.includes('\\'), 'Studio paths are POSIX paths');
  if (file === STUDIO_LOCAL_DIRECTORY || file.startsWith(STUDIO_LOCAL_DIRECTORY + '/')) {
    return true;
  }
  const legacy = Object.values(STUDIO_LEGACY_DIRECTORIES);
  assert(legacy.length === 2, 'Two older Studio folders are recognised');
  return file.split('/').some((part) => legacy.includes(part));
}
