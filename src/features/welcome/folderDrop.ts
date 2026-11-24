// Dropping a folder on the window, the pure half: which drags may carry a folder from outside the app, and
// which dropped items are folders. FolderDropHost.tsx owns the events, the overlay and the opening.
//
// What a drag holds is only known for sure on drop. While it moves, the browser shows each item's kind and
// type and nothing more: a folder from Finder or Explorer is a `file` item with no type. A typed file (an
// image, a PDF) is left to the drop targets that take files (the media browser, the AI composer, the
// terminal), and a drag from inside the app (a component, a Navigator row, text, a page image) carries
// string items or no `Files` at all, so it never shows the overlay. On drop, `webkitGetAsEntry` says which
// items really are folders; main still checks the path itself (electron/project/folderOpen.ts).
import { assert } from '../../../shared/core/assert';
import { FOLDER_OPEN_LIMITS, type FolderRejection } from '../../../shared/ipc/folderOpen';

/** What a drag shows of one item while it moves. */
export type DragItemShape = Pick<DataTransferItem, 'kind' | 'type'>;

/** What a drop shows of one item, read off the platform's item where the drop is handled. */
export interface DropItemShape {
  readonly file: File | undefined;
  readonly isDirectory: boolean;
}

/** The folders among the dropped items, in drop order and bounded, and how many items were not folders. */
export interface DroppedFolders {
  readonly folders: readonly File[];
  readonly otherCount: number;
}

/** Whether a drag may carry a folder from outside the app: the system's file drag, and only untyped file items. */
export function mayCarryFolder(types: readonly string[], items: Iterable<DragItemShape>): boolean {
  if (!types.includes('Files')) {
    return false;
  }
  let seen = 0;
  for (const item of items) {
    if (item.kind !== 'file') {
      return false;
    }
    if (item.type !== '') {
      return false;
    }
    seen += 1;
    if (seen < FOLDER_OPEN_LIMITS.dropItemsMax) {
      continue;
    }
    break;
  }
  assert(seen <= FOLDER_OPEN_LIMITS.dropItemsMax, 'mayCarryFolder: bounded by the drop limit');
  return seen > 0;
}

/** The dropped folders. Read during the drop event itself: the browser empties the items once it returns. */
export function droppedFolders(items: Iterable<DropItemShape>): DroppedFolders {
  const folders: File[] = [];
  let otherCount = 0;
  let seen = 0;
  for (const item of items) {
    seen += 1;
    if (seen > FOLDER_OPEN_LIMITS.dropItemsMax) {
      break;
    }
    if (item.file === undefined) {
      otherCount += 1;
    } else if (item.isDirectory) {
      folders.push(item.file);
    } else {
      otherCount += 1;
    }
  }
  assert(folders.length + otherCount <= FOLDER_OPEN_LIMITS.dropItemsMax, 'droppedFolders: bounded by the drop limit');
  return { folders, otherCount };
}

/** The toast for a path main refused. */
export function folderRejectionMessageKey(reason: FolderRejection): 'welcome.drop.missing' | 'welcome.drop.notFolder' | 'welcome.drop.unreadable' {
  switch (reason) {
    case 'missing':
      return 'welcome.drop.missing';
    case 'notFolder':
      return 'welcome.drop.notFolder';
    case 'unreadable':
      return 'welcome.drop.unreadable';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
