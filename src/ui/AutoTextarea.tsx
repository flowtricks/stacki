import type { TextareaHTMLAttributes } from 'react';
interface AutoTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly minRows?: number;
  /** The tallest it grows; longer text scrolls inside it. */
  readonly heightPxMax?: number;
}
import { useLayoutEffect, useRef } from 'react';
import { assert } from '../../shared/core/assert';

// A long value (a sermon transcript) would otherwise push every field after it
// off screen; past this height the text scrolls inside the field instead.
const HEIGHT_PX_MAX = 360;

// Textarea that grows and shrinks to fit its content, up to a height past
// which it scrolls. Height tracks the value on every change (and on width
// changes via ResizeObserver, since wrapping depends on width).
export default function AutoTextarea({
  value,
  minRows: rowsMin = 2,
  heightPxMax = HEIGHT_PX_MAX,
  style,
  ...props
}: AutoTextareaProps) {
  assert(Number.isFinite(heightPxMax), 'A textarea height bound is a number');
  assert(heightPxMax > 0, 'A textarea height bound is positive');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => fitTextarea(ref.current ?? undefined, heightPxMax), [value, heightPxMax]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(() => fitTextarea(element, heightPxMax));
    ro.observe(element);
    return () => ro.disconnect();
  }, [heightPxMax]);

  return (
    <textarea
      ref={ref}
      rows={rowsMin}
      value={value}
      style={{ overflowX: 'hidden', resize: 'none', ...style }}
      {...props}
    />
  );
}

// The height its text needs, up to the bound; past it, a scrollbar.
function fitTextarea(element: HTMLTextAreaElement | undefined, heightPxMax: number): void {
  if (element === undefined) {
    return;
  }
  element.style.height = 'auto';
  // +2 accounts for the 1px top/bottom borders (border-box sizing).
  const fullPx = element.scrollHeight + 2;
  element.style.height = Math.min(fullPx, heightPxMax) + 'px';
  // Owned here, not in the style prop, so a re-render never resets it.
  element.style.overflowY = fullPx > heightPxMax ? 'auto' : 'hidden';
}
