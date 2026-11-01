import { useEffect, useRef, useState, type ReactNode, type RefObject, type MutableRefObject } from 'react';
import { PreviewIcon } from '../../../vendor/stacki/src/ui/Icons';
import { request, routeFor, type Project } from '../project/projectClient';
import { parsePreviewTarget } from './usePreview';

interface Options {
  readonly project: Project;
  readonly previewFile: string;
  readonly open: (file: string) => void;
  readonly report: (error: unknown) => void;
}

export function useInteractivePreview(options: Options) {
  const [active, setActive] = useState(false);
  const [target, setTarget] = useState<{ url: string; origin: string }>();
  const frame = useRef<HTMLIFrameElement>(null);
  const path = useRef('');
  const current = useRef(options);
  current.current = options;
  const exit = () => {
    setActive(false);
    setTarget(undefined);
    const route = path.current.split(/[?#]/)[0]?.replace(/\/$/, '') || '/';
    const page = current.current.project.pages.find((file) => (routeFor(file).replace(/\/$/, '') || '/') === route);
    if (page && page !== current.current.previewFile) {
      current.current.open(page);
    }
  };
  useEffect(() => {
    if (!active) {
      return;
    }
    const controller = new AbortController();
    path.current = routeFor(current.current.previewFile);
    setTarget(undefined);
    void request('/studio/api/preview-url?mode=interactive&page=' + encodeURIComponent(path.current), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]),
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setTarget(parsePreviewTarget(value));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setActive(false);
          current.current.report(error);
        }
      });
    return () => controller.abort();
  }, [active]);
  usePreviewEvents(active, target?.origin, frame, path, exit);
  return { active, target, frame, toggle: () => (active ? exit() : setActive(true)) };
}

function usePreviewEvents(active: boolean, origin: string | undefined, frame: RefObject<HTMLIFrameElement>, path: MutableRefObject<string>, exit: () => void) {
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
      exit();
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
        exit();
      }
      if (value.type === 'avb:navigated' && 'path' in value && typeof value.path === 'string' && value.path.length <= 4000) {
        path.current = value.path;
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
  }, [active, origin, frame, path, exit]);
}

export type InteractivePreviewState = ReturnType<typeof useInteractivePreview>;

export function PreviewButton({ preview }: { readonly preview: InteractivePreviewState }) {
  const label = preview.active ? 'Exit preview (Esc)' : 'Preview the site';
  return (
    <button
      type="button"
      className={`titlebar-btn preview-btn ${preview.active ? 'on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={preview.active}
      onClick={preview.toggle}
    >
      <PreviewIcon size={15} />
    </button>
  );
}

export function PreviewWorkspace({ preview, children }: { readonly preview: InteractivePreviewState; readonly children: ReactNode }) {
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
            <iframe ref={preview.frame} src={preview.target.url} title="Site preview (interactive)" />
          ) : (
            <div role="status">
              <span className="panel-loading-label">Loading preview…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
