import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { PlayIcon } from '../../../vendor/stacki/src/ui/Icons';
import { request, routeFor, type Project } from '../project/projectClient';
import { parsePreviewTarget } from './usePreview';
import { replaceFrameAddress, useFrameAddress } from './frameAddress';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { canvasRouteFor, chooseTemplateEntry, useCanvasRoute } from '../pages/templateEntryStore';
import { addressFollowsPreview } from '../project/pageAddress';
import { parseCanvasNavigation } from '../../../vendor/stacki/shared/properties/canvasInteraction';
import { previewBase, previewFrameRoute, previewLandedPage, previewNeedsRoute, previewUnderBase, type PreviewOpening } from './previewRoute';

interface Options {
  readonly project: Project;
  readonly previewFile: string;
  readonly open: (file: string) => void;
  readonly report: (error: unknown) => void;
}

/**
 * A host page may open the editor in preview: `<meta name="studio-opens-in-preview" content="true">`.
 * The static demo does (demo/main.ts), so a visitor meets the finished site first; Studio
 * itself and Desktop open in the designer view.
 */
export const OPENS_IN_PREVIEW_META = 'studio-opens-in-preview';

function opensInPreview(): boolean {
  return document.querySelector(`meta[name="${OPENS_IN_PREVIEW_META}"]`)?.getAttribute('content') === 'true';
}

export function useInteractivePreview(options: Options) {
  const [active, setActive] = useState(opensInPreview);
  const [target, setTarget] = useState<PreviewTarget>();
  const frame = useRef<HTMLIFrameElement>(null);
  // The route the frame shows, base and query taken off; undefined until it loads.
  const shown = useRef<string | undefined>(undefined);
  const opening = useRef<PreviewOpening | undefined>(undefined);
  const requests = useRef(0);
  const current = useRef(options);
  current.current = options;
  // What the page switcher asks for: the page's route, or a template's chosen entry
  // (read when the template opens; until then there is nothing to load).
  const wanted = useCanvasRoute(options.previewFile, active);
  const exit = () => {
    setActive(false);
    setTarget(undefined);
    shown.current = undefined;
    opening.current = undefined;
  };
  useEffect(() => {
    if (!active) {
      return;
    }
    // Where the frame is now, read live: on back and forward the tab moves the frame and
    // the address together, and the address reopens its page before the frame reports.
    // Reloading the frame then would cut its own transition short.
    if (!previewNeedsRoute(liveRoute(frame.current, opening.current) ?? shown.current, wanted)) {
      return;
    }
    const route = wanted;
    const controller = new AbortController();
    void request('/studio/api/preview-url?mode=interactive&page=' + encodeURIComponent(route), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]),
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          const next = parsePreviewTarget(value);
          opening.current = { url: next.url, route };
          shown.current = route;
          requests.current += 1;
          setTarget({ ...next, request: requests.current });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          exit();
          current.current.report(error);
        }
      });
    return () => controller.abort();
  }, [active, wanted]);
  // A link followed in the preview opens the page it landed on, so the switcher and
  // the address name what the preview shows; the preview itself stays where it is.
  const landed = (path: string) => {
    const opened = opening.current;
    if (opened === undefined) {
      return;
    }
    const route = previewFrameRoute(path, opened);
    shown.current = route;
    const page = previewLandedPage(current.current.project.pages, route, routeFor);
    if (page === undefined) {
      return; // Not one of the project's pages: the switcher keeps what it had.
    }
    const movesFile = page.file !== current.current.previewFile;
    const movesEntry = page.entry !== undefined && canvasRouteFor(page.file) !== page.entry;
    if (!movesFile && !movesEntry) {
      return;
    }
    // The frame's navigation already made the history entry; the address takes it over.
    addressFollowsPreview(route);
    if (page.entry !== undefined) {
      chooseTemplateEntry(page.file, page.entry);
    }
    if (movesFile) {
      current.current.open(page.file);
    }
  };
  // The site's pages, so the frame knows a path that is none of them and sends a
  // download route to a new tab (frameInteraction.ts installPreviewLinks).
  const loaded = () => {
    const opened = opening.current;
    if (opened === undefined || target === undefined) {
      return;
    }
    const base = previewBase(opened);
    if (frame.current !== null && returnUnderBase(frame.current, base)) {
      return; // The page loading under the base reports itself.
    }
    const pages = { type: 'avb:site-pages', base, routes: current.current.project.pages.map(routeFor) };
    frame.current?.contentWindow?.postMessage(pages, target.origin);
  };
  usePreviewEvents(active, target?.origin, frame, landed, exit);
  return { active, target, frame, loaded, toggle: () => (active ? exit() : setActive(true)) };
}

// A link clicked before the page's scripts ran (a quick click during a load) is
// followed as written, from the site root: off the static demo's copy and onto the
// live site it was baked from, which the editor cannot address. The frame is put back
// on the same page under the base, replacing the entry the stray load made. True when
// it was moved.
function returnUnderBase(element: HTMLIFrameElement, base: string): boolean {
  if (base === '') {
    return false; // Pages served at the site root: every same-origin page is one.
  }
  let pathname: string;
  let address: URL;
  try {
    address = new URL(element.contentWindow?.location.href ?? '');
    pathname = address.pathname;
  } catch {
    return false; // Another origin, or nothing loaded: nothing to put back.
  }
  if (pathname === base || pathname.startsWith(`${base}/`)) {
    return false;
  }
  assert(base.startsWith('/'), 'A preview base is a site path');
  address.pathname = previewUnderBase(pathname, base);
  replaceFrameAddress(element, address.href);
  return true;
}

// The route the frame shows right now, when the editor can read its location (the same
// origin, as Studio and the demo serve it); undefined otherwise.
function liveRoute(element: HTMLIFrameElement | null, opened: PreviewOpening | undefined): string | undefined {
  if (element === null || opened === undefined) {
    return undefined;
  }
  try {
    const path = element.contentWindow?.location.pathname;
    return path === undefined || !path.startsWith('/') ? undefined : previewFrameRoute(path, opened);
  } catch {
    return undefined; // Another origin: the frame's own reports are what the editor has.
  }
}

interface PreviewTarget {
  readonly url: string;
  readonly origin: string;
  /** Which load this is: a page picked again after a link moved the frame is a new request. */
  readonly request: number;
}

function usePreviewEvents(active: boolean, origin: string | undefined, frame: RefObject<HTMLIFrameElement>, landed: (path: string) => void, exit: () => void) {
  // The latest callbacks, without re-adding the listeners each render.
  const handlers = useRef({ landed, exit });
  handlers.current = { landed, exit };
  useEffect(() => {
    if (!active) {
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      handlers.current.exit();
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) {
        return;
      }
      const value = event.data;
      if (!value || typeof value !== 'object' || !('type' in value)) {
        return;
      }
      if (value.type === 'studio:exit-preview') {
        handlers.current.exit();
      }
      const path = parseCanvasNavigation(value);
      if (path !== undefined) {
        handlers.current.landed(path);
      }
      if (value.type === 'studio:interaction') {
        window.dispatchEvent(new Event('studio:interaction'));
      }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('message', receive);
    };
  }, [active, origin, frame]);
}

export type InteractivePreviewState = ReturnType<typeof useInteractivePreview>;

// The preview's frame. A page picked in the switcher replaces the frame's history entry
// (frameAddress.ts): the address's own entry is the one back steps to.
function PreviewFrame({ preview, target }: { readonly preview: InteractivePreviewState; readonly target: PreviewTarget }) {
  const translate = useTranslate();
  const src = useFrameAddress(preview.frame, target.url, target.request);
  return <iframe ref={preview.frame} src={src} title={translate('preview.studio.frameTitle')} onLoad={preview.loaded} />;
}

export function PreviewButton({ preview }: { readonly preview: InteractivePreviewState }) {
  const translate = useTranslate();
  const label = preview.active ? translate('preview.studio.exit') : translate('preview.studio.start');
  return (
    <button
      type="button"
      className={`titlebar-btn preview-btn ${preview.active ? 'on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={preview.active}
      onClick={preview.toggle}
    >
      <PlayIcon size={15} />
    </button>
  );
}

export function PreviewWorkspace({ preview, children }: { readonly preview: InteractivePreviewState; readonly children: ReactNode }) {
  const translate = useTranslate();
  return (
    <div className="studio-workspace">
      <div
        className="studio-workspace-panels"
        ref={(element) => {
          if (element) {
            element.inert = preview.active;
          }
        }}
      >
        {children}
      </div>
      {preview.active && (
        <div className="preview-mode">
          {preview.target ? (
            <PreviewFrame preview={preview} target={preview.target} />
          ) : (
            <div role="status">
              <span className="panel-loading-label">{translate('preview.studio.loading')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
