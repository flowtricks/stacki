// Design mode (experimental, removable: docs/design-mode/REMOVE.md): one frame on the canvas: its name over it, its
// document, and the outlines of what is hovered and selected in it.
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { DESIGN_SESSION_LIMITS, type DesignFrameView, type DesignPlace } from '../../../shared/ipc/designSession';
import type { DesignNodeAt, DesignSnapshot } from '../../../shared/ipc/designSnapshot';
import { DesignFrameDocument, type FrameMeasure } from './DesignFrameDocument';
import { nodeBox } from './designFrameDom';
import type { SnapGuide } from './designElementMath';
import { EMPTY_FRAME, frameWidthPx, type DesignEdge } from './designFrameWidth';
import { parsePreviewWidth } from '../../features/preview/previewViewport';
import { useDesignWords } from './i18n/designWords';

/** The picked element's resize handles: its right edge, its bottom edge and their corner. */
const HANDLES = ['e', 's', 'se'] as const;

/** The frame's own resize handles: its two sides. */
const EDGES: readonly DesignEdge[] = ['w', 'e'];

export interface DesignTileProps {
  readonly frame: DesignFrameView;
  readonly at: DesignPlace;
  readonly zoom: number;
  readonly snapshot: DesignSnapshot | undefined;
  readonly mark: 'none' | 'active' | 'selected';
  readonly hover: DesignNodeAt | undefined;
  readonly picked: DesignNodeAt | undefined;
  /** While an element here is being resized: the size it is drawn at. */
  readonly size?: { readonly width: number; readonly height: number } | undefined;
  /** While the frame's side is being dragged: the width it is drawn at. */
  readonly resizing?: number | undefined;
  /** A width typed for the frame. Without it the frame cannot be resized. */
  readonly onWidth?: ((widthPx: number) => void) | undefined;
  /** Snap lines of an element being dragged in this frame. */
  readonly guides?: readonly SnapGuide[];
  /** A copy being dragged, not yet a frame. */
  readonly ghost?: boolean;
  readonly hidden?: boolean;
  readonly renaming: boolean;
  readonly onRenamed: (name: string | undefined) => void;
  readonly onRename: () => void;
}

export function DesignFrameTile(props: DesignTileProps) {
  const words = useDesignWords();
  const { frame, snapshot, zoom } = props;
  const [measure, setMeasure] = useState<FrameMeasure | undefined>(undefined);
  const widthPx = props.resizing ?? frameWidthPx(frame, snapshot);
  const floorPx = Math.max(EMPTY_FRAME.heightPx, snapshot?.viewportHeightPx ?? 0);
  const heightPx = measure?.heightPx ?? floorPx;
  const resizable = props.onWidth !== undefined && props.ghost !== true;
  const classes = ['dm-tile', `is-${props.mark}`, props.ghost === true ? 'is-ghost' : ''];
  // The label and the outlines keep their size on screen at every zoom.
  const style: CSSProperties & Record<'--dm-line' | '--dm-zoom', string> = {
    left: props.at.x,
    top: props.at.y,
    width: widthPx,
    visibility: props.hidden === true ? 'hidden' : 'visible',
    '--dm-line': `${String(1.5 / zoom)}px`,
    '--dm-zoom': String(zoom),
  };
  return (
    <div className={classes.join(' ')} style={style} data-dm-tile={frame.id} data-dm-ghost={props.ghost === true ? '' : undefined}>
      <div className="dm-title" data-dm-part="title" style={{ fontSize: 12 / zoom, height: 24 / zoom, gap: 8 / zoom, width: widthPx }}>
        {props.renaming ? (
          <RenameField name={frame.name} zoom={zoom} onDone={props.onRenamed} />
        ) : (
          <span className="dm-title-name" onDoubleClick={props.onRename}>
            {frame.name}
          </span>
        )}
        {frame.changedFiles > 0 && <span className="dm-title-changes">{words('frame.changes', { count: frame.changedFiles })}</span>}
        {resizable && !props.renaming && props.mark !== 'none' && <WidthField widthPx={widthPx} zoom={zoom} onWidth={props.onWidth} />}
      </div>
      <div className="dm-body" data-dm-part="body" style={{ width: widthPx, height: heightPx }}>
        {snapshot === undefined ? (
          <div className="dm-skeleton ui-skeleton" aria-label={words('frame.loading')} />
        ) : (
          <DesignFrameDocument html={snapshot.html} title={frame.name} widthPx={widthPx} heightPx={heightPx} floorPx={floorPx} onMeasure={setMeasure} />
        )}
        {/* Before the outlines, so a picked element's handle on the page's edge stays the one pressed there. */}
        {resizable &&
          EDGES.map((edge) => (
            <div key={edge} className={`dm-edge is-${edge}`} data-dm-part="edge" data-dm-edge={edge}>
              <span className="dm-edge-grip" style={{ top: Math.min(heightPx, floorPx) / 2 }} />
            </div>
          ))}
        {props.resizing !== undefined && (
          <div className="dm-size dm-width" style={{ fontSize: 11 / zoom, padding: `${String(2 / zoom)}px ${String(6 / zoom)}px` }}>
            {`${String(props.resizing)} px`}
          </div>
        )}
        {measure !== undefined && <Outline measure={measure} node={props.hover} kind="hover" />}
        {measure !== undefined && <Outline measure={measure} node={props.picked} kind="picked" />}
        {props.size !== undefined && (
          <div className="dm-size" style={{ fontSize: 11 / zoom, padding: `${String(2 / zoom)}px ${String(6 / zoom)}px` }}>
            {`${String(props.size.width)} × ${String(props.size.height)}`}
          </div>
        )}
        {props.guides?.map((guide) => (
          <div
            key={`${guide.axis}${String(guide.at)}`}
            className={`dm-guide is-${guide.axis}`}
            style={guide.axis === 'x' ? { left: guide.at } : { top: guide.at }}
          />
        ))}
      </div>
    </div>
  );
}

function Outline({ measure, node, kind }: { readonly measure: FrameMeasure; readonly node: DesignNodeAt | undefined; readonly kind: 'hover' | 'picked' }) {
  const box = node === undefined ? undefined : nodeBox(measure.document, node);
  if (box === undefined) {
    return undefined;
  }
  return (
    <div className={`dm-outline is-${kind}`} data-dm-outline={kind} style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
      {kind === 'picked' && HANDLES.map((handle) => <span key={handle} className={`dm-handle is-${handle}`} data-dm-handle={handle} />)}
    </div>
  );
}

/**
 * The picked or shown frame's width, beside its name. A click turns it into a field: Enter keeps what is typed;
 * Escape, and anything outside the editor's canvas width limits, leave the width as it was.
 */
function WidthField({
  widthPx,
  zoom,
  onWidth,
}: {
  readonly widthPx: number;
  readonly zoom: number;
  readonly onWidth: ((widthPx: number) => void) | undefined;
}) {
  const words = useDesignWords();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const style: CSSProperties = { fontSize: 12 / zoom, height: 22 / zoom, padding: `0 ${String(6 / zoom)}px` };
  if (draft === undefined) {
    return (
      <button type="button" className="dm-title-width" style={style} aria-label={words('frame.width')} onClick={() => setDraft(String(widthPx))}>
        {widthPx}
      </button>
    );
  }
  const finish = (save: 'save' | 'cancel'): void => {
    const next = parsePreviewWidth(draft);
    setDraft(undefined);
    // An untouched field asks for nothing.
    if (save === 'save' && next !== undefined && next !== widthPx) {
      onWidth?.(next);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish('save');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish('cancel');
    }
  };
  return (
    <input
      className="dm-title-input dm-width-input"
      inputMode="numeric"
      aria-label={words('frame.width')}
      value={draft}
      maxLength={4}
      autoFocus
      style={{ ...style, width: 56 / zoom }}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish('save')}
      onKeyDown={onKeyDown}
    />
  );
}

function RenameField({ name, zoom, onDone }: { readonly name: string; readonly zoom: number; readonly onDone: (name: string | undefined) => void }) {
  const words = useDesignWords();
  const [draft, setDraft] = useState(name);
  const finish = (save: 'save' | 'cancel'): void => {
    const next = draft.trim();
    onDone(save === 'save' && next.length > 0 && next !== name ? next.slice(0, DESIGN_SESSION_LIMITS.frameNameCharsMax) : undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish('save');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish('cancel');
    }
  };
  return (
    <input
      className="dm-title-input"
      aria-label={words('frame.renameLabel')}
      value={draft}
      maxLength={DESIGN_SESSION_LIMITS.frameNameCharsMax}
      autoFocus
      style={{ fontSize: 12 / zoom, height: 22 / zoom, width: 200 / zoom, padding: `0 ${String(6 / zoom)}px` }}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish('save')}
      onKeyDown={onKeyDown}
    />
  );
}
