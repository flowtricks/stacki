// Design mode (experimental, removable: docs/design-mode/REMOVE.md): one frame on the canvas: its name over it, its
// document, and the outlines of what is hovered and selected in it.
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { DESIGN_SESSION_LIMITS, type DesignFrameView, type DesignPlace } from '../../../shared/ipc/designSession';
import type { DesignNodeAt, DesignSnapshot } from '../../../shared/ipc/designSnapshot';
import { DesignFrameDocument, type FrameMeasure } from './DesignFrameDocument';
import { nodeBox } from './designFrameDom';
import { useDesignWords } from './i18n/designWords';

/** A frame with no document yet is drawn this large. */
export const EMPTY_FRAME = { widthPx: 1_440, heightPx: 900 } as const;

export interface DesignTileProps {
  readonly frame: DesignFrameView;
  readonly at: DesignPlace;
  readonly zoom: number;
  readonly snapshot: DesignSnapshot | undefined;
  readonly mark: 'none' | 'active' | 'selected';
  readonly hover: DesignNodeAt | undefined;
  readonly picked: DesignNodeAt | undefined;
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
  const widthPx = snapshot === undefined || snapshot.viewportWidthPx < 1 ? EMPTY_FRAME.widthPx : snapshot.viewportWidthPx;
  const heightPx = measure?.heightPx ?? Math.max(EMPTY_FRAME.heightPx, snapshot?.viewportHeightPx ?? 0);
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
        {frame.changedFiles > 0 && <span className="dm-title-note">{words('frame.changes', { count: frame.changedFiles })}</span>}
      </div>
      <div className="dm-body" data-dm-part="body" style={{ width: widthPx, height: heightPx }}>
        {snapshot === undefined ? (
          <div className="dm-skeleton ui-skeleton" aria-label={words('frame.loading')} />
        ) : (
          <DesignFrameDocument html={snapshot.html} title={frame.name} widthPx={widthPx} heightPx={heightPx} onMeasure={setMeasure} />
        )}
        {measure !== undefined && <Outline measure={measure} node={props.hover} kind="hover" />}
        {measure !== undefined && <Outline measure={measure} node={props.picked} kind="picked" />}
      </div>
    </div>
  );
}

function Outline({ measure, node, kind }: { readonly measure: FrameMeasure; readonly node: DesignNodeAt | undefined; readonly kind: 'hover' | 'picked' }) {
  const box = node === undefined ? undefined : nodeBox(measure.document, node);
  if (box === undefined) {
    return undefined;
  }
  return <div className={`dm-outline is-${kind}`} data-dm-outline={kind} style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />;
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
