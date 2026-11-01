// Clip path: the row's glyph for the shape in use, and the modal the shape
// editor opens in, loaded only when it is (EffectsSection.tsx).

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { displayOf } from './model/styleDisplay';
import { type Props, EffLabel } from './EffectsKit';

// ─────────────────────────── Section ───────────────────────────

// ─────────────────────────── Clip path ───────────────────────────

// The full clip-path editor is large (~340 KB); lazy-load it so it only enters the
// bundle when the popup opens. It's fully self-contained (reads the selected element
// and writes `clip-path` to its native class style itself — no props).
export const ClipPathEditor = lazy(() => import('./clipPath/ClipPath'));

export const ClipCloseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
export const ClipEditIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10.5 2.5 13.5 5.5 6 13l-3.5.5L3 10l7.5-7.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

export const CLIP_GLYPH_SHAPE_PATH = 'M8 .5c.4 4.3 2.8 6.8 7.5 7.5-4.7.7-7.1 3.2-7.5 7.5-.4-4.3-2.8-6.8-7.5-7.5' + 'C5.2 7.3 7.6 4.8 8 .5Z';

// Canonical shape glyphs mirroring the editor's preset picker, so the trigger reads at
// a glance. Local (not imported from the editor) to keep that module out of the bundle.
export function ClipGlyph({ type }: { type: string }) {
  const cls = 'embed-editor_clip-trigger-glyph';
  switch (type) {
    case 'None':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 12 12 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'Polygon':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" />
        </svg>
      );
    case 'Inset':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="2.5" fill="currentColor" />
        </svg>
      );
    case 'Circle':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="4.75" fill="currentColor" />
        </svg>
      );
    case 'Ellipse':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <ellipse cx="8" cy="8" rx="6" ry="4.25" fill="currentColor" />
        </svg>
      );
    case 'Shape':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <path d={CLIP_GLYPH_SHAPE_PATH} fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 8Q5 4 8 8T13.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
  }
}

// A cheap classifier for the trigger label — names the shape without pulling the huge
// editor module (and its full parser) into the main bundle.
export function clipPathType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'none') {
    return 'None';
  }
  if (normalized.startsWith('polygon')) {
    return 'Polygon';
  }
  if (normalized.startsWith('circle')) {
    return 'Circle';
  }
  if (normalized.startsWith('ellipse')) {
    return 'Ellipse';
  }
  if (normalized.startsWith('inset') || normalized.startsWith('rect') || normalized.startsWith('xywh')) {
    return 'Inset';
  }
  if (normalized.startsWith('path')) {
    return 'Path';
  }
  if (normalized.startsWith('shape')) {
    return 'Shape';
  }
  if (normalized.startsWith('url')) {
    return 'SVG';
  }
  if (normalized.startsWith('var')) {
    return 'Variable';
  }
  return 'Custom';
}

// The editor in a full-panel modal, portaled to <body> and rendered at the panel's
// own scale (it used to re-apply moden's compact zoom — see embedEditor.css). The
// editor's clip-path writes are routed to the panel's selected selector via
// setProp/clearProp (so its own class picker is hidden).
export function ClipPathModal({ props, onClose }: { props: Props; onClose: () => void }) {
  const { onApply, onClear } = useSettledClipPath(props);
  return (
    <Popup
      className="embed-editor_clip-modal u-surface-page"

      label="Clip path"
      onClose={onClose}
    >
      {({ close }) => (
        <>
          <div className="embed-editor_clip-modal-head">
            <span className="embed-editor_clip-modal-title">Clip path</span>
            <div className="embed-editor_clip-modal-actions">
              {/* Portal target for the editor's shortcut-help control (it renders nothing
                when this is absent). Provided here since it's no longer a hosted tool. */}
              <div id="clip-path_header-shortcuts" />
              <button type="button" className="embed-editor_bg-modal-close" onClick={close} aria-label="Close">
                <ClipCloseIcon />
              </button>
            </div>
          </div>
          <div className="embed-editor_clip-modal-body">
            <Suspense fallback={<div className="embed-editor_clip-loading">Loading editor…</div>}>
              <ClipPathEditor onApply={onApply} onClear={onClear} hideClassPicker />
            </Suspense>
          </div>
        </>
      )}
    </Popup>
  );
}

// Stream fast previews as the shape is dragged; commit authoritatively (with the
// panel's native→embed fallback) once edits settle, so a drag doesn't fire a read-back
// per frame. Any un-committed edit is flushed when the popup closes before it settles.
export function useSettledClipPath({ setProp, liveSetProp, clearProp }: Props) {
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const commit = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (pending.current !== undefined) {
      setProp('clip-path', pending.current, false);
      pending.current = undefined;
    }
  };
  // The unmount flush calls the latest render's commit, through a ref, so the effect
  // runs once.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => () => commitRef.current(), []);
  const onApply = (value: string) => {
    liveSetProp('clip-path', value, false);
    pending.current = value;
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(commit, 350);
  };
  const onClear = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    pending.current = undefined;
    clearProp('clip-path');
  };
  return { onApply, onClear };
}

// The Clip row: the label (blue/clear/provenance like every other prop) + a button
// showing the current clip-path type. Clicking opens the visual editor popup.
export function ClipPathRow({ props }: { props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read('clip-path'));
  const raw = display.present ? display.value : displayOf(read('-webkit-clip-path')).value;
  const [open, setOpen] = useState(false);
  const type = clipPathType(raw);
  return (
    <div className="embed-editor_size-row">
      <EffLabel label="Clip" prop="clip-path" props={props} />
      <button type="button" className="embed-editor_clip-trigger" disabled={busy} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="embed-editor_clip-trigger-type">
          <ClipGlyph type={type} />
          <span className="embed-editor_clip-trigger-label">{type}</span>
        </span>
        <ClipEditIcon />
      </button>
      {open ? <ClipPathModal props={props} onClose={() => setOpen(false)} /> : undefined}
    </div>
  );
}
