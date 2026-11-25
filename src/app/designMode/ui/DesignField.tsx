// One style field of the inspector: a label you can drag sideways to scrub a number (Shift for steps of ten),
// and a text box that takes any CSS value. Empty shows the computed value, dimmed, as the placeholder. A scrub
// changes the frame live and is one undo step when the pointer comes up.
import { capturePointer, roundedCss } from './designPointer';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import TipAnchor from '../../../ui/TipAnchor';
import { beginLive, bump, cancelLive, commitFrame, isLive, selectedElements } from '../runtime/designSession';
import { setInlineStyle } from '../model/designDom';
import { styleSelection } from '../runtime/designGestures';

export interface FieldProps {
  readonly label: string;
  readonly property: string;
  /** The inline value the selection has (the first element's), or '' when none. */
  readonly value: string;
  /** The computed value, shown when there is no inline one. */
  readonly computed: string;
  readonly scrubTip: string;
  /** The unit a scrubbed bare number gets. */
  readonly unit?: string;
  readonly wide?: boolean;
}

function scrubbable(text: string): { readonly amount: number; readonly unit: string } | undefined {
  const match = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  return { amount: Number(match[1]), unit: match[2] ?? '' };
}

function liveStyle(property: string, value: string): void {
  const selected = selectedElements();
  for (const element of selected?.elements ?? []) {
    setInlineStyle(element, property, value);
  }
  bump();
}

export function DesignField({ label, property, value, computed, scrubTip, unit = 'px', wide = false }: FieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (text: string) => {
    if (text.trim() !== value) {
      styleSelection(property, text.trim());
    }
  };
  const onScrubStart = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const selected = selectedElements();
    const start = scrubbable(value === '' ? computed : value);
    if (selected === undefined || start === undefined || !beginLive(selected.frame)) {
      return;
    }
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    const originX = event.clientX;
    const target = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const step = moveEvent.shiftKey ? 10 : 1;
      const amount = Math.round((start.amount + Math.round((moveEvent.clientX - originX) / 2) * step) * 100) / 100;
      const next =
        String(amount) +
        (start.unit === '' && unit !== '' && property !== 'opacity' && property !== 'font-weight' && property !== 'z-index' && property !== 'line-height'
          ? unit
          : start.unit);
      setDraft(next);
      liveStyle(property, next);
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', cancel);
      if (isLive()) {
        commitFrame(selected.frame, () => undefined);
      }
    };
    const cancel = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', cancel);
      cancelLive();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', cancel);
  };
  return (
    <label className={`dm-field${wide ? ' is-wide' : ''}`}>
      <TipAnchor text={scrubTip}>
        <span className="dm-field-label" onPointerDown={onScrubStart}>
          {label}
        </span>
      </TipAnchor>
      <input
        className="dm-field-input"
        value={draft}
        placeholder={roundedCss(computed)}
        spellCheck={false}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(event.currentTarget.value);
          } else if (event.key === 'Escape') {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
