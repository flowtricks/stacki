// The formatting buttons over a text selection, shared by the Settings Content
// field and the canvas, so both offer the same presses in the same order.
import React from 'react';
import { ElementLinkIcon } from '../../ui/Icons';
import type { FormatState, RichCommand, RichWrapTag } from './richFormat';

interface RichFormatButtonsProps {
  readonly states: FormatState;
  readonly onExec: (command: RichCommand) => void;
  readonly onWrap: (tag: RichWrapTag) => void;
  readonly onLink: () => void;
}

export function RichFormatButtons({ states, onExec, onWrap, onLink }: RichFormatButtonsProps) {
  return (
    <>
      {richButton(<b>B</b>, 'Bold', { active: states.bold }, () => onExec('bold'))}
      {richButton(<i>I</i>, 'Italic', { active: states.italic }, () => onExec('italic'))}
      {richButton(
        <span>
          X<sup>2</sup>
        </span>,
        'Superscript',
        { active: states.superscript },
        () => onExec('superscript'),
      )}
      {richButton(
        <span>
          X<sub>2</sub>
        </span>,
        'Subscript',
        { active: states.subscript },
        () => onExec('subscript'),
      )}
      {richButton(<span className="mono">{'</>'}</span>, 'Code', { active: states.code }, () =>
        onWrap('code'),
      )}
      {/* A span is the hook for everything else: wrap some words, then
          give that node a class and style it like any other. Nothing is
          written on it here — an empty span IS the useful result. */}
      {richButton(
        <span className="mono">span</span>,
        'Wrap in a span',
        { active: states.span },
        () => onWrap('span'),
      )}
      {/* The app's own link icon, not the emoji: an emoji is drawn by
          the system in its own colours and at its own weight, so it sat
          in this row as the one thing that hadn't been designed. */}
      {richButton(<ElementLinkIcon size={14} />, 'Link', { active: states.link }, onLink)}
    </>
  );
}

interface RichLinkFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly onBlur?: (() => void) | undefined;
}

export function RichLinkField(props: RichLinkFieldProps) {
  const { value, onChange, onApply, onCancel } = props;
  return (
    <input
      autoFocus
      onBlur={props.onBlur}
      className="rich-bubble-url"
      placeholder="https://…  (Enter to apply)"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          onApply();
        }
        if (event.key === 'Escape') {
          onCancel();
        }
      }}
    />
  );
}

// Buttons use onMouseDown+preventDefault so the text selection survives.
const richButton = (
  label: React.ReactNode,
  title: string,
  { active }: { readonly active: boolean | undefined },
  onAct: () => void,
) => (
  <button
    key={title}
    type="button"
    className={active ? 'on' : ''}
    title={title}
    onMouseDown={(event) => {
      event.preventDefault();
      onAct();
    }}
  >
    {label}
  </button>
);

/** Where a selection is, in window pixels: its horizontal middle, top and bottom. */
export interface Bubble {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}
export interface BubblePosition {
  readonly left: number;
  readonly top: number;
  readonly below: boolean;
  readonly arrowX: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

// Measure the rendered bubble and keep it inside the window: clamp
// horizontally, flip below the selection when it would hit the titlebar,
// and keep the arrow pointing at the selection midpoint.
export function richBubblePlace(bubble: Bubble, element: HTMLElement): BubblePosition {
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const margin = 8;
  const left = clamp(bubble.x, margin + width / 2, window.innerWidth - margin - width / 2);
  const below = bubble.top - height - 10 < 48;
  const top = below ? bubble.bottom + 10 : bubble.top - 10;
  const arrowX = clamp(bubble.x - (left - width / 2), 12, width - 12);
  return { left, top, below, arrowX };
}
