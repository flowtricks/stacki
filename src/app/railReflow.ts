// The rail's 150ms reflow when its order changes: each button slides from where it was to where it is now
// (a FLIP animation), so a drop or a keyboard move reads as a move and not as a jump. The rows are read just
// before the order changes (one read per change, never per frame) and again after React has drawn it.
// Skipped under prefers-reduced-motion and where the platform has no Web Animations (a test DOM).

/** How long the slide takes. */
export const RAIL_REFLOW_MS = 150;

/** Each shown button's top edge by id: the "before" of a reflow. */
export function readRailRows(rail: HTMLElement | undefined): ReadonlyMap<string, number> {
  const rows = new Map<string, number>();
  if (rail !== undefined) {
    for (const button of rail.querySelectorAll<HTMLElement>('[data-rail-id]')) {
      rows.set(button.dataset['railId'] ?? '', button.getBoundingClientRect().top);
    }
  }
  return rows;
}

/** Slides every button that moved from its `before` place to its new one. */
export function animateRailReflow(rail: HTMLElement | undefined, before: ReadonlyMap<string, number>): void {
  if (rail === undefined || prefersReducedMotion()) {
    return;
  }
  for (const button of rail.querySelectorAll<HTMLElement>('[data-rail-id]')) {
    const previousTop = before.get(button.dataset['railId'] ?? '');
    if (previousTop !== undefined && typeof button.animate === 'function') {
      const shiftPx = previousTop - button.getBoundingClientRect().top;
      if (shiftPx !== 0) {
        button.animate([{ transform: `translateY(${shiftPx}px)` }, { transform: 'translateY(0)' }], {
          duration: RAIL_REFLOW_MS,
          easing: 'ease-out',
        });
      }
    }
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
