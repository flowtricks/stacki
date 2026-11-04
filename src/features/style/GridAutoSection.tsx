// The grid's implicit tracks — grid-auto-columns and grid-auto-rows — with the
// popover each opens, and the modal the grid settings open in
// (GridSettings.tsx).

import { useState } from 'react';
import PanelSheet from './components/PanelSheet';
import type { ReactNode } from 'react';
import { GroupLabel } from './TypographySection';
import { serializeTrackSize, trackLabel, type TrackSize } from './model/gridTemplate';
import { type SetProp, type LabelProps, resolvedValue, CloseIcon } from './GridSettingsKit';
import { TrackIcon, TrackSizeEditor, TrackPopover } from './TrackEditor';

export interface TrackSectionProps {
  title: string;
  prop: string;
  axis: 'column' | 'row';
  setProp: SetProp;
  labels: LabelProps;
}

// The auto-generated track size (grid-auto-columns / grid-auto-rows) — like any other
// track: a single clickable row whose popup edits the value (grid-auto-columns/-rows).
export function AutoSection({ title, prop, axis, setProp, labels }: TrackSectionProps) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels;
  const current = resolvedValue(read, prop) || 'auto';
  const [open, setOpen] = useState(false);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const setSize = (size: TrackSize) => {
    const serialized = serializeTrackSize(size);
    if (serialized && serialized.toLowerCase() !== 'auto') {
      setProp(prop, serialized, false);
    } else {
      clearProp(prop);
    }
  };
  return (
    <section className="embed-editor_grid-section">
      <div className="embed-editor_grid-section-head">
        <span className="embed-editor_grid-section-title">
          <GroupLabel
            label={title}
            props={[prop]}
            read={read}
            busy={busy}
            onClear={() => clearProp(prop)}
            onProvenance={onProvenance}
            onSelectSelector={onSelectSelector}
          />
          <span className="embed-editor_grid-section-count">(0)</span>
        </span>
      </div>
      <div className="embed-editor_grid-track-list">
        <div className="embed-editor_grid-track">
          <div className="embed-editor_grid-track-row">
            <button
              type="button"
              className="embed-editor_grid-track-main"
              onClick={(event) => {
                setOpen((wasOpen) => !wasOpen);
                setAnchorElement(event.currentTarget.closest<HTMLElement>('.embed-editor_grid-track-list') ?? event.currentTarget);
              }}
              disabled={busy}
            >
              <span className="embed-editor_grid-track-glyph" aria-hidden="true">
                <TrackIcon track={current} axis={axis} />
              </span>
              <span className="embed-editor_grid-track-label">{trackLabel(current)}</span>
            </button>
          </div>
        </div>
      </div>
      {open && anchorElement ? (
        <AutoTrackPopover anchorElement={anchorElement} track={current} axis={axis} busy={busy} onChange={setSize} onClose={() => setOpen(false)} />
      ) : undefined}
    </section>
  );
}

// The auto track's size editor, with a note saying what it sizes.
export function AutoTrackPopover({
  anchorElement,
  track,
  axis,
  busy,
  onChange,
  onClose,
}: {
  anchorElement: HTMLElement;
  track: string;
  axis: 'column' | 'row';
  busy: boolean;
  onChange: (size: TrackSize) => void;
  onClose: () => void;
}) {
  const note = axis === 'column' ? 'Define the sizing for all automatically created columns.' : 'Define the sizing for all automatically created rows.';
  return (
    <TrackPopover anchorElement={anchorElement} onClose={onClose}>
      <TrackSizeEditor track={track} busy={busy} onChange={onChange} />
      <div className="embed-editor_grid-popover-note">{note}</div>
      <button type="button" className="embed-editor_grid-popover-ok" onClick={onClose}>
        Ok, got it
      </button>
    </TrackPopover>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <PanelSheet className="style-panel-surface embed-editor_grid-modal u-surface-surface" label="Grid settings" onClose={onClose}>
      {({ close }) => (
        <>
          <div className="embed-editor_grid-modal-head">
            <span className="embed-editor_grid-modal-title">Grid settings</span>
            <button type="button" className="embed-editor_bg-modal-close" onClick={close} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          <div className="embed-editor_grid-modal-body">{children}</div>
        </>
      )}
    </PanelSheet>
  );
}
