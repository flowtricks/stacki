// The one way a custom tooltip (`.rail-tooltip`) is drawn: every tip names its control by that control's box and is
// placed from it by `fitTooltip` once the tip's own size is known. Why one component: tips used to place themselves
// from a point and a CSS transform, which cannot know the tip's size, so a tip under a control at the bottom of the
// window was cut off and one beside a narrow panel ran off its edge. One shared path keeps the clamp, the flip and the
// arrow the same for the rail, the tiles, the menus and the settings hints.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { fitTooltip, type TooltipAnchor, type TooltipSide } from './delayedTooltip';

interface FittedTooltipProps {
  readonly anchor: TooltipAnchor;
  readonly preferred?: TooltipSide;
  // Extra classes after `rail-tooltip`: the variant's own width and layer.
  readonly className?: string;
  readonly id?: string;
  readonly role?: 'tooltip';
  readonly hidden?: boolean;
  readonly children: ReactNode;
}

export default function FittedTooltip({ anchor, preferred = 'below', className, id, role, hidden, children }: FittedTooltipProps) {
  const element = useRef<HTMLDivElement>(null);
  // A layout effect runs before the browser paints, so the tip is never seen at its unfitted place. The position is
  // written to the element directly: it depends on a size that is only known after render, and state would paint twice.
  // It runs after every render because the text, and so the size, can change while the anchor stays the same.
  useLayoutEffect(() => {
    const node = element.current;
    assert(node !== null, 'FittedTooltip: the tip is mounted');
    // Measured at the corner, where nothing narrows it: a fixed box near the right edge would wrap and report a width
    // smaller than the one it needs.
    node.style.left = '0px';
    node.style.top = '0px';
    const box = node.getBoundingClientRect();
    const fit = fitTooltip({
      anchor,
      preferred,
      tip: { width: box.width, height: box.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    node.style.left = `${fit.left}px`;
    node.style.top = `${fit.top}px`;
    node.style.setProperty('--tip-arrow', `${fit.arrowOffset}px`);
    node.dataset['side'] = fit.side;
  });
  return (
    <div
      ref={element}
      className={className === undefined ? 'rail-tooltip' : `rail-tooltip ${className}`}
      data-fitted="true"
      data-side={preferred}
      id={id}
      role={role}
      aria-hidden={hidden}
    >
      {children}
    </div>
  );
}
