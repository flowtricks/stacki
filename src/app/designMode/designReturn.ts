// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the page the person is on, kept across the
// window's reload into the copy and back.
//
// A project opens on its home page, so each reload would leave the person there. Before one, the page is noted in the
// window's session storage; after it, that page is opened once the editor has opened its own first page, and then
// left alone: whatever the person opens next stays open. Until it is open the canvas takes no picture, so the home
// page the editor passes through never becomes a frame's.
import { useEffect, useRef } from 'react';
import type { ShellView } from '../App';
import { projectRelativePath } from '../../lib/projectPath';
import { noteCanvasChange } from './designCaptureQueue';
import { livePagePath, samePage } from './designLiveCanvas';
import { designView, updateDesignView } from './designStore';

/** A page to come back to: its file, the address the editor showed for it, and that address's path in the preview. */
export interface DesignReturn {
  readonly file: string;
  readonly route: string;
  readonly pagePath: string;
  /** The breakpoint picked in the toolbar, which a reload would reset. */
  readonly device: string;
}

const RETURN_KEY = 'stacki-design-mode-return';
const TEXT_CHARS_MAX = 2_000;
/** Past this the page could not be opened, and the editor is left where it is. */
const RETURN_WAIT_MS_MAX = 30_000;

/**
 * The page the editor shows, as a place to come back to. A component opened from a page counts as that page.
 * Undefined when there is no page of the project's own open (a route a dependency adds, a component opened alone).
 */
export function currentReturn(app: Pick<ShellView, 'project' | 'currentPage' | 'editStack' | 'pageUrlPath' | 'device'>): DesignReturn | undefined {
  const page = app.editStack[0] ?? app.currentPage;
  if (page === undefined || page.kind !== 'page' || page.path.includes('/.stacki/')) {
    return undefined;
  }
  const file = projectRelativePath(app.project.path, page.path, window.avb.platform);
  const route = app.pageUrlPath ?? page.route ?? '/';
  return { file, route, pagePath: livePagePath() ?? route, device: app.device };
}

export function parseReturn(input: unknown): DesignReturn | undefined {
  if (typeof input !== 'object' || !input || !('file' in input) || !('route' in input) || !('pagePath' in input) || !('device' in input)) {
    return undefined;
  }
  const { file, route, pagePath, device } = input;
  const fits = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= TEXT_CHARS_MAX;
  return fits(file) && fits(route) && fits(pagePath) && fits(device) ? { file, route, pagePath, device } : undefined;
}

export function noteReturn(place: DesignReturn | undefined): void {
  try {
    if (place === undefined) {
      sessionStorage.removeItem(RETURN_KEY);
    } else {
      sessionStorage.setItem(RETURN_KEY, JSON.stringify(place));
    }
  } catch {
    // Without storage the editor stays on the home page; nothing else is lost.
  }
}

function takeReturn(): DesignReturn | undefined {
  try {
    const kept = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    const value: unknown = kept === null ? undefined : JSON.parse(kept);
    return parseReturn(value);
  } catch {
    return undefined;
  }
}

interface Pending {
  readonly place: DesignReturn;
  step: 'waiting' | 'asked';
  timer: number | undefined;
}

/** Opens the noted page after a reload, asking for it once. */
export function useReturnToPage(app: ShellView): void {
  const pending = useRef<Pending | 'none' | undefined>(undefined);
  if (pending.current === undefined) {
    const place = takeReturn();
    pending.current = place === undefined ? 'none' : { place, step: 'waiting', timer: undefined };
    if (place !== undefined) {
      // Set while rendering, so nothing is pictured or drawn for the home page the editor opens first.
      queueMicrotask(() => updateDesignView((view) => ({ ...view, returning: 'returning', pagePath: place.pagePath })));
    }
  }
  const { scan, currentPage, editStack, pageUrlPath, selectPage, setLinkedEntry, setDevice } = app;
  useEffect(() => {
    const held = pending.current;
    if (held === undefined || held === 'none') {
      return;
    }
    const finish = (): void => {
      window.clearTimeout(held.timer);
      pending.current = 'none';
      updateDesignView((view) => ({ ...view, returning: 'there' }));
      noteCanvasChange();
    };
    held.timer ??= window.setTimeout(finish, RETURN_WAIT_MS_MAX);
    // The editor opens its own first page after the scan: asking before that would be undone by it.
    if (scan.pages.length === 0 || currentPage === undefined) {
      return;
    }
    const projectPath = app.project.path;
    const target = scan.pages.find((page) => projectRelativePath(projectPath, page.path, window.avb.platform) === held.place.file);
    if (target === undefined) {
      finish();
      return;
    }
    const open = (editStack[0] ?? currentPage).kind === 'page' && (editStack[0] ?? currentPage).path === target.path;
    if (held.step === 'waiting') {
      held.step = 'asked';
      setDevice(held.place.device);
      // A dynamic page opens on its first entry unless the entry wanted is named (as a followed link does).
      if (target.route.includes('[')) {
        setLinkedEntry({ pagePath: target.path, route: held.place.route });
      }
      if (!open) {
        void selectPage(target).catch(() => undefined);
        return;
      }
    }
    if (open && samePage(pageUrlPath ?? '', held.place.route)) {
      finish();
    }
  }, [app.project.path, scan, currentPage, editStack, pageUrlPath, selectPage, setLinkedEntry, setDevice]);
  useEffect(() => {
    // The page the canvas is for follows the editor's once any return is done.
    if (designView().returning === 'there') {
      const pagePath = livePagePath();
      if (pagePath !== undefined) {
        updateDesignView((view) => (view.pagePath === pagePath ? view : { ...view, pagePath }));
      }
    }
  });
}
