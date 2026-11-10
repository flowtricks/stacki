import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { TrailingSlash } from '../../editor/pageState';
import { componentPreviewURL, type ComponentPreviewMessage, type PreviewLayout } from './paletteModel';
import { useShotImage, type ShotAccess } from './componentShotSource';
import { usePreviewMessages, useResolvedPreviewURL } from './previewSource';

// The picture of a component in the insert grid. Where the desktop app has photographed the component
// on one of the project's pages (componentShotSource.ts) that photograph is shown. Otherwise, and while
// it is unreadable, the card falls back to the project's own preview route, rendered at the width the
// component is built for and scaled down to the card: a section renders 1440 logical pixels wide, a
// block 640. Either way it is a picture, not a control: no pointer, no focus, hidden from assistive technology.

/**
 * Every live frame uses the route's page layout. A block is rendered in a 640 px frame, so "as wide as the
 * frame, top left, unscaled" puts it at the top of the card instead of centred on the popup's 1200 px stage.
 */
export const CARD_PREVIEW_LAYOUT: PreviewLayout = 'page';

/** Logical width a section renders at before it is scaled to its card. */
export const SECTION_PREVIEW_WIDTH = 1440;
/** Logical width a block renders at before it is scaled to its card. */
export const BLOCK_PREVIEW_WIDTH = 640;

type SurfaceScale = { readonly kind: 'unmeasured' } | { readonly kind: 'measured'; readonly scale: number };

type FrameState = { readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'empty' };

type SurfaceStyle = CSSProperties & { '--surface-width': string; '--surface-scale'?: number };

export interface InsertPreviewSource {
  /** Undefined when the component has no file the preview route can address. */
  readonly component: ScanComponent | undefined;
  /** Undefined while the project's dev server is not running. */
  readonly devURL: string | undefined;
  readonly trailingSlash: TrailingSlash;
  readonly resolvePreviewURL?: ((url: string) => Promise<string>) | undefined;
  /** Photographs of components on their pages; absent where the host takes none (the Studio in a browser). */
  readonly shots?: ShotAccess | undefined;
}

export function InsertPreviewSurface({
  source,
  width,
  mounted,
  visible,
  shotFit,
  icon,
  size,
}: {
  readonly source: InsertPreviewSource;
  readonly width: number;
  /** Whether the grid has room for this card's frame right now. */
  readonly mounted: boolean;
  /** Whether the card is on screen; a photograph is only fetched for what is seen. */
  readonly visible: boolean;
  /**
   * How a photograph is drawn. A section always fills the card, whatever width it was photographed at (1440,
   * or 1200 when the desktop width hid it); a block keeps its width in proportion to the card.
   */
  readonly shotFit: 'fill' | 'scale';
  readonly icon: ReactNode;
  readonly size: 'card' | 'large';
}) {
  assert(width > 0, 'A preview renders at a positive width');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scale = useSurfaceScale(surfaceRef, width);
  const style: SurfaceStyle = { '--surface-width': `${width}px` };
  if (scale.kind === 'measured') {
    style['--surface-scale'] = scale.scale;
  }
  const { component, devURL } = source;
  const photo = useShotImage(source.shots, component?.path, { wanted: visible });
  let content: ReactNode;
  if (photo.kind === 'ready') {
    // A photograph of the component on its page, drawn at the card's scale like the live preview: a
    // section fills the card, a narrower block keeps its proportion to it. Never wider than the card,
    // top aligned, cut off at the bottom.
    const shotWidth = component === undefined || shotFit === 'fill' ? undefined : source.shots?.width(component.path);
    const shotStyle: CSSProperties & { '--shot-width'?: number } = shotWidth === undefined ? {} : { '--shot-width': shotWidth };
    content = (
      <img
        className="insert-shot"
        src={photo.url}
        alt=""
        draggable={false}
        tabIndex={-1}
        aria-hidden="true"
        style={shotStyle}
        // A file that is there but cannot be drawn is as good as none: the live preview takes over.
        onError={() => component !== undefined && source.shots?.fail(component.path)}
      />
    );
  } else if (photo.kind === 'loading') {
    content = <PreviewNote icon={icon} reason="loading" />;
  } else if (component === undefined || devURL === undefined) {
    content = <PreviewNote icon={icon} reason="empty" />;
  } else if (mounted && scale.kind === 'measured') {
    const url = componentPreviewURL(devURL, component, source.trailingSlash, { layout: CARD_PREVIEW_LAYOUT });
    content = <InsertPreviewFrame key={url} url={url} name={component.name} icon={icon} resolvePreviewURL={source.resolvePreviewURL} />;
  } else {
    content = <PreviewNote icon={icon} reason="loading" />;
  }
  return (
    <div ref={surfaceRef} className={`insert-surface insert-surface-${size} ${photo.kind === 'ready' ? 'insert-surface-photo' : ''}`} style={style}>
      {content}
    </div>
  );
}

function InsertPreviewFrame({
  url,
  name,
  icon,
  resolvePreviewURL,
}: {
  readonly url: string;
  readonly name: string;
  readonly icon: ReactNode;
  readonly resolvePreviewURL: ((url: string) => Promise<string>) | undefined;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resolved = useResolvedPreviewURL(url, resolvePreviewURL);
  const [reported, setReported] = useState<FrameState>({ kind: 'loading' });
  const receive = useCallback((message: ComponentPreviewMessage): void => {
    setReported({ kind: message.status });
  }, []);
  usePreviewMessages(frameRef, receive);
  const state: FrameState = resolved.kind === 'empty' ? { kind: 'empty' } : reported;
  return (
    <>
      {resolved.kind === 'ready' && (
        <iframe
          ref={frameRef}
          className="insert-frame"
          src={resolved.url}
          title={`${name} preview`}
          tabIndex={-1}
          aria-hidden="true"
          style={{ opacity: state.kind === 'ready' ? 1 : 0 }}
        />
      )}
      {state.kind !== 'ready' && <PreviewNote icon={icon} reason={state.kind} />}
    </>
  );
}

function PreviewNote({ icon, reason }: { readonly icon: ReactNode; readonly reason: 'loading' | 'empty' }) {
  return (
    <div className="insert-surface-note" role={reason === 'loading' ? 'status' : undefined}>
      <span className="insert-surface-note-icon">{icon}</span>
      {reason === 'loading' ? <span className="panel-loading-label">Loading preview…</span> : <span>No preview available</span>}
    </div>
  );
}

/**
 * The factor that fits `width` logical pixels into the surface. Unmeasured until the browser reports
 * a size, which is also all it ever is where there is no ResizeObserver: nothing loads then, and
 * nothing throws.
 */
function useSurfaceScale(surfaceRef: RefObject<HTMLElement>, width: number): SurfaceScale {
  const [scale, setScale] = useState<SurfaceScale>({ kind: 'unmeasured' });
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined && entry.contentRect.width > 0) {
        setScale({ kind: 'measured', scale: entry.contentRect.width / width });
      }
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surfaceRef, width]);
  return scale;
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
