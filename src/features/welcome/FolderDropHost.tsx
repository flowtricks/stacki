// Folders from outside the app, wherever the window is: dropped on the window, or handed over by the app's
// icon, the command line or a second launch (shared/ipc/folderOpen.ts). The welcome screen and the project
// window each mount one host and decide what an answer does there (`onChoice`): an Astro project opens, a
// plain website is offered an Astro copy, websites found inside the folder are offered to choose from
// (nestedSites.ts), anything else is a toast, exactly as "Open from folder".
//
// The drop: while a drag that may carry a folder (folderDrop.ts) is over the window and no drop target under
// the pointer has taken it (the media browser, the AI composer and the terminal call preventDefault first),
// the window shows a full-window fill and takes the drop. The listeners sit on `window` in the bubble phase,
// so every target inside, React's included, has had its say by the time they run. The overlay never takes the
// pointer, and while it shows the canvas frames stop taking it too, so the drag stays in this document.
import { useEffect, useRef, useState } from 'react';
import { FolderOpenIcon } from '../../ui/Icons';
import { windowHeld } from '../../ui/busyLock';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FOLDER_OPEN_LIMITS, type FolderOpenChoice } from '../../../shared/ipc/folderOpen';
import { droppedFolders, folderRejectionMessageKey, mayCarryFolder, type DroppedFolders } from './folderDrop';
import { inspectFolder, subscribeOpenedFolders, takeOpenedFolders } from './welcomeBridge';
import type { AstroCopySource } from './AstroCopyDialog';
import { askNestedSites } from './nestedSites';
import type { NestedSitesChoice, SiteSearchReach } from '../../../shared/ipc/astroCopy';
import type { Translator } from '../../lib/i18n/localeContext';

/** How long the overlay outlives the last `dragover`: the browser repeats it while the pointer rests, so a gap means the drag left. */
const DRAG_IDLE_MS = 200;
/** On the root element while the overlay shows: frames stop taking the pointer (styles.css). */
const DRAGGING_CLASS = 'folder-drag-active';

type ShowToast = (message: string, kind: 'success' | 'error' | 'info') => void;

export interface FolderRoutes {
  /** An Astro project at this path. */
  readonly open: (projectPath: string) => void;
  /** A plain website: offer the Astro copy. */
  readonly offerCopy: (source: AstroCopySource) => void;
  readonly showToast: ShowToast;
}

/** What an answer does, the same on both screens but for what opening means there. */
export function useFolderChoiceRoute(routes: FolderRoutes): (choice: FolderOpenChoice) => void {
  const translate = useTranslate();
  return (choice) => {
    switch (choice.kind) {
      case 'astro':
        routes.open(choice.projectPath);
        return;
      case 'plainWebsite':
        routes.offerCopy({ sourcePath: choice.sourcePath, parentPath: choice.parentPath, name: choice.name, homePath: choice.homePath });
        return;
      case 'nestedSites':
        void routeNestedSites(choice, routes, translate);
        return;
      case 'notWebsite':
        routes.showToast(translate(notWebsiteMessageKey(choice.searched)), 'error');
        return;
      case 'rejected':
        routes.showToast(translate(folderRejectionMessageKey(choice.reason)), 'error');
        return;
      default: {
        const exhaustive: never = choice;
        return exhaustive;
      }
    }
  };
}

/** What "isn't a website" says: honest about a folder too large to have been searched in full. */
export function notWebsiteMessageKey(searched: SiteSearchReach): 'welcome.notWebsite' | 'welcome.notWebsite.partial' {
  return searched === 'all' ? 'welcome.notWebsite' : 'welcome.notWebsite.partial';
}

// Websites inside the folder: the person picks, then the pick opens as any folder of its kind would.
async function routeNestedSites(choice: NestedSitesChoice, routes: FolderRoutes, translate: Translator): Promise<void> {
  if (choice.searched === 'part') {
    routes.showToast(translate('welcome.nested.partial'), 'info');
  }
  const answer = await askNestedSites(choice, translate);
  switch (answer.kind) {
    case 'open':
      routes.open(answer.projectPath);
      return;
    case 'copy':
      routes.offerCopy(answer.offer);
      return;
    case 'canceled':
      return;
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

export function FolderDropHost({ onChoice, showToast }: { readonly onChoice: (choice: FolderOpenChoice) => void; readonly showToast: ShowToast }) {
  const translate = useTranslate();
  const [dragging, setDragging] = useState(false);
  // The latest handlers, so the window listeners are added once and never act on a stale screen.
  const latest = useRef({ onChoice, showToast, translate });
  latest.current = { onChoice, showToast, translate };

  useEffect(() => listenForOpenedFolders((choice) => latest.current.onChoice(choice)), []);

  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      clearTimeout(idle);
      idle = undefined;
      setDragging(false);
    };
    const onDragOver = (event: DragEvent): void => {
      const transfer = event.dataTransfer;
      if (transfer === null) {
        return;
      }
      if (event.defaultPrevented) {
        stop(); // A drop target under the pointer takes this drag.
        return;
      }
      if (windowHeld()) {
        return;
      }
      if (!mayCarryFolder([...transfer.types], transfer.items)) {
        return;
      }
      event.preventDefault();
      transfer.dropEffect = 'copy';
      setDragging(true);
      clearTimeout(idle);
      idle = setTimeout(stop, DRAG_IDLE_MS);
    };
    const onDrop = (event: DragEvent): void => {
      stop();
      const transfer = event.dataTransfer;
      if (transfer === null) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (windowHeld()) {
        return;
      }
      if (!mayCarryFolder([...transfer.types], transfer.items)) {
        return;
      }
      event.preventDefault();
      const dropped = droppedFolders([...transfer.items].slice(0, FOLDER_OPEN_LIMITS.dropItemsMax).map(readDropItem));
      void openDropped(dropped, latest.current);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', stop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', stop);
      clearTimeout(idle);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (dragging) {
      root.classList.add(DRAGGING_CLASS);
    } else {
      root.classList.remove(DRAGGING_CLASS);
    }
    return () => root.classList.remove(DRAGGING_CLASS);
  }, [dragging]);

  if (!dragging) {
    return undefined;
  }
  return (
    <div className="folder-drop-overlay" aria-hidden="true">
      <FolderOpenIcon size={28} />
      <div className="folder-drop-title">{translate('welcome.drop.title')}</div>
      <div className="folder-drop-hint">{translate('welcome.drop.hint')}</div>
    </div>
  );
}

// The first dropped folder opens; the rest are named in one toast. The path is the platform's, and main
// checks what is there before anything opens.
async function openDropped(
  dropped: DroppedFolders,
  handlers: { readonly onChoice: (choice: FolderOpenChoice) => void; readonly showToast: ShowToast; readonly translate: ReturnType<typeof useTranslate> },
): Promise<void> {
  const [first, ...rest] = dropped.folders;
  if (first === undefined) {
    if (dropped.otherCount > 0) {
      handlers.showToast(handlers.translate('welcome.drop.notFolder'), 'error');
    }
    return;
  }
  const folderPath = window.avb.getFilePath(first);
  if (folderPath === undefined || folderPath.length === 0) {
    handlers.showToast(handlers.translate('welcome.drop.unreadable'), 'error');
    return;
  }
  const result = await inspectFolder(folderPath);
  if (!result.ok) {
    handlers.showToast(result.error, 'error');
    return;
  }
  if (rest.length > 0) {
    handlers.showToast(handlers.translate('welcome.drop.skipped', { count: rest.length }), 'info');
  }
  handlers.onChoice(result.value);
}

function readDropItem(item: DataTransferItem): { readonly file: File | undefined; readonly isDirectory: boolean } {
  if (item.kind !== 'file') {
    return { file: undefined, isDirectory: false };
  }
  return { file: item.getAsFile() ?? undefined, isDirectory: item.webkitGetAsEntry()?.isDirectory === true };
}

// ---------------------------------------------------------------------------
// The inbox: folders main hands over. Listened to once for the life of the page, from the first host that
// mounts, so a folder that arrives while one screen gives way to the other waits here instead of being lost.
// ---------------------------------------------------------------------------

let inboxStarted = false;
let inboxHandler: ((choice: FolderOpenChoice) => void) | undefined;
let inboxWaiting: readonly FolderOpenChoice[] = [];

function listenForOpenedFolders(handler: (choice: FolderOpenChoice) => void): () => void {
  inboxHandler = handler;
  if (!inboxStarted) {
    inboxStarted = true;
    // Listen first, then take what waited: main sends a folder itself only after the take.
    subscribeOpenedFolders(receiveOpenedFolder);
    // A reply that is not the contract's shape is logged as the update popup's read is: the window still works.
    takeOpenedFolders().then(
      (result) => {
        if (result.ok) {
          result.value.forEach(receiveOpenedFolder);
        } else {
          console.warn('[folder-open] the folders handed to Stacki could not be read:', result.error);
        }
      },
      (error: unknown) => console.error('[folder-open] the folders handed to Stacki could not be read:', error),
    );
  }
  const waiting = inboxWaiting;
  inboxWaiting = [];
  waiting.forEach(handler);
  return () => {
    if (inboxHandler === handler) {
      inboxHandler = undefined;
    }
  };
}

/** Hands a folder's answer to the screen on show, as for a folder that arrives from outside: File > Open Project uses it. */
export function receiveOpenedFolder(choice: FolderOpenChoice): void {
  if (inboxHandler !== undefined) {
    inboxHandler(choice);
    return;
  }
  if (inboxWaiting.length < FOLDER_OPEN_LIMITS.queueMax) {
    inboxWaiting = [...inboxWaiting, choice];
  } else {
    console.warn('[folder-open] too many folders are waiting for a screen; this one was not opened');
  }
}
