import { useLayoutEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import type { ReactNode, RefObject } from 'react';
import { panelSpan } from './model/panelBox';

// A layer editor anchored directly below the row it edits (flips above when there's no
// room to drop down), spanning the panel's full width — measured, since the panel is a
// column of the window here rather than the whole of it. Portaled to <body> so it
// overlays everything, and rendered at the panel's own scale: it used to re-apply
// moden's compact 0.75 `zoom`, a wrapper this app doesn't render, which left every
// control in here a quarter smaller than the same control in the panel behind it.
// Closes on outside click / Escape / scroll; the anchor row is excluded from the
// outside-click so clicking it toggles the popover shut instead of instantly reopening.
export default function LayerPopover({
  anchorEl: anchorElement,
  onClose,
  ariaLabel,
  span: placedSpan,
  children,
}: {
  anchorEl: HTMLElement;
  onClose: () => void;
  ariaLabel?: string;
  /** Where it sits across, for an anchor outside the style panel (the preview
   *  toolbar): there is no panel to span, so the caller places it. */
  span?: { readonly left: number; readonly width: number };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Whether the box has to be a scroll container. It is one so a tall layer
  // editor can't run off the screen — and a scroll container clips, which took
  // out the one thing in here that is *meant* to escape: a dropdown's menu. With
  // no room below (there rarely is, this far down the panel) the menu opens
  // upward, lands outside the box, and is clipped away — so the click that meant
  // to pick an option went through to the panel behind and read as a click
  // outside, closing the popover. These editors are three or four rows; the
  // scrolling is for a case that does not happen, and it stays available for the
  // case that does.
  const scrolls = usePopoverOverflow(boxRef);
  // Read once, at mount, so the popover has its real width for the very first
  // layout — the flip decision below measures a height that depends on it.
  const [span] = useState(() => placedSpan ?? panelSpan(anchorElement));
  const top = usePopoverTop(ref, anchorElement);
  return (
    <Popup
      mode="popover"
      anchor={anchorElement}
      onClose={onClose}
      ref={ref}
      className="embed-editor_layer-popover"
      role="dialog"
      label={ariaLabel}
      style={{
        position: 'fixed',
        left: span.left,
        width: span.width,
        top: top ?? 0,
        visibility: top === undefined ? 'hidden' : 'visible',
      }}
    >
      <div ref={boxRef} className={'embed-editor_layer-popover-box u-surface-surface' + (scrolls ? ' is-scrolling' : '')}>
        {children}
      </div>
    </Popup>
  );
}

// The popover's top edge: directly below the anchor row, or flipped above it
// when there is no room to drop down. Undefined until the first measurement.
function usePopoverTop(ref: RefObject<HTMLDivElement>, anchorElement: HTMLElement): number | undefined {
  const [top, setTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const anchorRect = anchorElement.getBoundingClientRect();
    const gap = 6;
    // Rendered height (the zoomed content already collapsed it).
    const height = element.offsetHeight;
    const below = anchorRect.bottom + gap + height <= window.innerHeight;
    setTop(below ? anchorRect.bottom + gap : Math.max(gap, anchorRect.top - gap - height));
  }, [ref, anchorElement]);
  return top;
}

function usePopoverOverflow(boxRef: RefObject<HTMLDivElement>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return undefined;
    }
    const measure = () => setScrolls(box.scrollHeight > window.innerHeight * 0.94);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    // A max-height box can keep the same border size while its contents grow,
    // so ResizeObserver alone misses the exact change that makes it scroll.
    const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(measure);
    mutations?.observe(box, { attributes: true, childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      mutations?.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [boxRef]);
  return scrolls;
}
