import TipAnchor from '../../ui/TipAnchor';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { fitSnapshot } from '../../../shared/properties/previewSnapshot';
import { tileView, type TileUnavailable } from '../../../shared/properties/previewTile';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { ORIGIN_TOKEN, type PreviewSnapshotStore } from './previewSnapshotStore';
import { tileId, useTileState } from './previewTiles';
import type { HeldSnapshot } from './snapshotPersistence';

// The picture of a component in the insert grid. It is a snapshot, rendered once through the project's
// preview route and kept (previewSnapshotStore.ts), so a tile never loads when it scrolls into view and
// never unloads when it scrolls out: every tile of the grid stays mounted, the browser skips painting the
// ones off screen (content-visibility on the card), and the pictures are the same ones the next opening
// of the palette finds. A tile that has no picture yet shows a skeleton of its final size, and a tile that
// is known to have none says why and offers to try again.

export interface InsertPreviewSource {
  /** Undefined when the component has no file the preview route can address. */
  readonly component: ScanComponent | undefined;
  /** Undefined while the project's dev server is not running. */
  readonly devURL: string | undefined;
  readonly store: PreviewSnapshotStore | undefined;
}

/** The tiles whose picture has been shown once this session: they appear without the fade a first picture gets. */
const shownTiles = new Set<string>();

export function InsertPreviewSurface({ source, icon }: { readonly source: InsertPreviewSource; readonly icon: ReactNode }) {
  const { component, store, devURL } = source;
  const id = component === undefined ? undefined : tileId(component);
  const state = useTileState(store, id);
  let content: ReactNode;
  if (component === undefined) {
    content = <PreviewNote icon={icon} reason={{ kind: 'no-file' }} onRetry={undefined} />;
  } else if (devURL === undefined && state.kind !== 'ready') {
    content = <PreviewNote icon={icon} reason={{ kind: 'no-server' }} onRetry={undefined} />;
  } else {
    assert(id !== undefined, 'A tile with a component has an id');
    const view = tileView(state);
    if (view === 'picture') {
      const held = store?.snapshot(id);
      content = held === undefined ? <PreviewSkeleton /> : <SnapshotPicture id={id} held={held} devURL={devURL} name={component.name} />;
    } else if (view === 'unavailable' && state.kind === 'unavailable') {
      content = <PreviewNote icon={icon} reason={state.reason} onRetry={() => store?.retry(id)} />;
    } else {
      content = <PreviewSkeleton />;
    }
  }
  return <div className="insert-surface insert-surface-card">{content}</div>;
}

/** The empty tile: a shimmer the size of the tile it will become, so nothing moves when the picture arrives. */
function PreviewSkeleton() {
  const translate = useTranslate();
  return <div className="insert-skeleton" role="status" aria-label={translate('palette.preview.loading')} />;
}

function SnapshotPicture({
  id,
  held,
  devURL,
  name,
}: {
  readonly id: string;
  readonly held: HeldSnapshot;
  readonly devURL: string | undefined;
  readonly name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const [loaded, setLoaded] = useState(shownTiles.has(id));
  const origin = devURL === undefined ? '' : new URL(devURL).origin;
  const fit = size === undefined ? undefined : fitSnapshot(held.box, size);
  return (
    <div ref={ref} className="insert-snapshot" data-loaded={loaded}>
      {fit !== undefined && (
        <div className="insert-snapshot-clip" style={{ left: fit.x, top: fit.y, width: held.box.width * fit.scale, height: held.box.height * fit.scale }}>
          <iframe
            className="insert-snapshot-frame"
            title={`${name} preview`}
            tabIndex={-1}
            aria-hidden
            // No scripts: a snapshot is a picture. Same origin so the dev server's fonts and images load as on the page.
            sandbox="allow-same-origin"
            srcDoc={held.html.split(ORIGIN_TOKEN).join(origin)}
            style={{
              width: 1200,
              height: held.box.top + held.box.height,
              transform: `translate(${-held.box.left * fit.scale}px, ${-held.box.top * fit.scale}px) scale(${fit.scale})`,
            }}
            onLoad={() => {
              shownTiles.add(id);
              setLoaded(true);
            }}
          />
        </div>
      )}
      {!loaded && <PreviewSkeleton />}
    </div>
  );
}

function useElementSize(ref: RefObject<HTMLElement>): { readonly width: number; readonly height: number } | undefined {
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (width: number, height: number): void => {
      if (width > 0 && height > 0) {
        setSize((current) => (current !== undefined && current.width === width && current.height === height ? current : { width, height }));
      }
    };
    measure(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect;
      // A tile is 16:10 whatever its width, so the width alone is enough to know its height.
      measure(rect?.width ?? element.clientWidth, rect?.height || (rect === undefined ? element.clientHeight : Math.round(rect.width * 0.625)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** The sentence a tile's tooltip gives for why it has no picture. */
export function unavailableText(reason: TileUnavailable, translate: Translator): string {
  switch (reason.kind) {
    case 'no-server':
      return translate('palette.preview.noServer');
    case 'no-file':
      return translate('palette.preview.noFile');
    case 'needs-props':
      return translate('palette.preview.needsProps', { names: reason.names.join(', ') });
    case 'threw':
      return translate('palette.preview.threw', { message: reason.message });
    case 'client-only':
      return translate('palette.preview.clientOnly');
    case 'rendered-nothing':
      return translate('palette.preview.rendered');
    case 'timeout':
      return translate('palette.preview.timeout');
    case 'too-large':
      return translate('palette.preview.tooLarge');
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function PreviewNote({ icon, reason, onRetry }: { readonly icon: ReactNode; readonly reason: TileUnavailable; readonly onRetry: (() => void) | undefined }) {
  const translate = useTranslate();
  const text = unavailableText(reason, translate);
  assert(text.length > 0, 'An empty preview says why');
  // The reason is the tile's tooltip (hover and focus): the tile stays one short line, and the cause is a pointer away.
  return (
    <TipAnchor text={text}>
      <div className="insert-surface-note">
        <span className="insert-surface-note-icon">{icon}</span>
        <span>{translate('palette.preview.unavailable')}</span>
        {onRetry !== undefined && (
          <button
            type="button"
            className="insert-surface-retry"
            // A click on the retry is not a click on the card: it must not insert the component.
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {translate('palette.preview.retry')}
          </button>
        )}
      </div>
    </TipAnchor>
  );
}

/**
 * Tells `report` whether the element at `ref` is inside `root`'s scrollport, with a screen of margin either
 * side so a tile just below the fold counts as visible and is rendered first. Where there is no
 * IntersectionObserver nothing is reported visible; the tiles then render in grid order.
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
      { root: root.current, rootMargin: '200px 0px', threshold: 0 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      report(key, false);
    };
  }, [ref, root, key, report]);
}
