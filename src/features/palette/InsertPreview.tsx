import { useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { TrailingSlash } from '../../editor/pageState';
import { ComponentPreviewFrame } from './ComponentPreviewPopup';
import { componentPreviewURL } from './paletteModel';

// The picture of a component in the insert grid: the same live rendering the Components panel's
// hover card shows, through the same preview route and frame (ComponentPreviewPopup.tsx). The
// route renders the component with the project's insertion recipe from `.stacki/components.json`
// where it has one, and with its own prop defaults where it does not
// (electron/previewServer/componentPreviewRecipe.ts), then fits it into the frame.

type FrameState = { readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'empty'; readonly reason: string };

/** Why a card has no preview, shown on hover; the route's own reason wins when it gives one. */
export const PREVIEW_REASONS = {
  noServer: 'The project dev server is not running.',
  noFile: 'This component has no file the preview can load.',
  rendered: 'The component rendered nothing.',
} as const satisfies Record<string, string>;

export interface InsertPreviewSource {
  /** Undefined when the component has no file the preview route can address. */
  readonly component: ScanComponent | undefined;
  /** Undefined while the project's dev server is not running. */
  readonly devURL: string | undefined;
  readonly trailingSlash: TrailingSlash;
  readonly resolvePreviewURL?: ((url: string) => Promise<string>) | undefined;
}

/** The address a card loads: exactly the hover card's, so both show the same rendering. */
export function insertPreviewURL(source: InsertPreviewSource): string | undefined {
  const { component, devURL } = source;
  if (component === undefined) {
    return undefined;
  }
  if (devURL === undefined) {
    return undefined;
  }
  const url = componentPreviewURL(devURL, component, source.trailingSlash);
  assert(url.startsWith(devURL.replace(/\/+$/, '')), 'A card preview is served by the project dev server');
  return url;
}

export function InsertPreviewSurface({
  source,
  mounted,
  icon,
  onSettled,
}: {
  readonly source: InsertPreviewSource;
  /** Whether the grid has given this card one of its frames right now. */
  readonly mounted: boolean;
  readonly icon: ReactNode;
  /** The frame has answered: the grid may start the next one. */
  readonly onSettled?: (() => void) | undefined;
}) {
  const url = insertPreviewURL(source);
  let content: ReactNode;
  if (url === undefined) {
    content = <PreviewNote icon={icon} state={{ kind: 'empty', reason: source.component === undefined ? PREVIEW_REASONS.noFile : PREVIEW_REASONS.noServer }} />;
  } else if (mounted) {
    assert(source.component !== undefined, 'A card URL names a component');
    content = <CardFrame key={url} url={url} name={source.component.name} icon={icon} resolvePreviewURL={source.resolvePreviewURL} onSettled={onSettled} />;
  } else {
    content = <PreviewNote icon={icon} state={{ kind: 'loading' }} />;
  }
  return <div className="insert-surface insert-surface-card">{content}</div>;
}

function CardFrame({
  url,
  name,
  icon,
  resolvePreviewURL,
  onSettled,
}: {
  readonly url: string;
  readonly name: string;
  readonly icon: ReactNode;
  readonly resolvePreviewURL: ((url: string) => Promise<string>) | undefined;
  readonly onSettled: (() => void) | undefined;
}) {
  const [state, setState] = useState<FrameState>({ kind: 'loading' });
  const receive = useCallback(
    (reportedURL: string, status: 'ready' | 'empty', reason?: string): void => {
      assert(reportedURL === url, 'A card frame reports its own URL');
      onSettled?.();
      setState(status === 'ready' ? { kind: 'ready' } : { kind: 'empty', reason: reason ?? PREVIEW_REASONS.rendered });
    },
    [url, onSettled],
  );
  return (
    <>
      <ComponentPreviewFrame url={url} name={name} visible={state.kind === 'ready'} surface="card" resolvePreviewURL={resolvePreviewURL} onStatus={receive} />
      {state.kind !== 'ready' && <PreviewNote icon={icon} state={state} />}
    </>
  );
}

function PreviewNote({ icon, state }: { readonly icon: ReactNode; readonly state: Exclude<FrameState, { readonly kind: 'ready' }> }) {
  if (state.kind === 'loading') {
    return (
      <div className="insert-surface-note" role="status">
        <span className="insert-surface-note-icon">{icon}</span>
        <span className="panel-loading-label">Loading preview…</span>
      </div>
    );
  }
  assert(state.reason.length > 0, 'An empty preview says why');
  // The reason is the hover text: the card stays one short line, and the cause is a pointer away.
  return (
    <div className="insert-surface-note" title={state.reason}>
      <span className="insert-surface-note-icon">{icon}</span>
      <span>No preview available</span>
    </div>
  );
}

/**
 * Tells `report` whether the element at `ref` is inside `root`'s scrollport. Where there is no
 * IntersectionObserver the element is never reported visible, so no frame loads.
 */
export function useReportVisibility(
  ref: RefObject<HTMLElement>,
  root: RefObject<HTMLElement>,
  key: string,
  report: (key: string, visible: boolean) => void,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries.at(-1);
        if (latest !== undefined) {
          report(key, latest.isIntersecting);
        }
      },
      { root: root.current, rootMargin: '0px', threshold: 0 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      report(key, false);
    };
  }, [ref, root, key, report]);
}
