import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VariableBlock } from '../../ipc/variablesBridge';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { createScrollLanes, SCROLL_PEERS_MAX } from './variableScroll';

interface ScrollMetrics {
  readonly maximum: number;
  readonly viewport: number;
  readonly gutter: number;
}

export function useVariableSheetScroll(blocks: readonly VariableBlock[], columnCount: number) {
  const lanes = useMemo(createScrollLanes, []);
  // The sheet's heading and scrollbar belong to the tables with the sheet's
  // columns; a table with a count of its own scrolls in a lane of its own.
  const sync = lanes.lane(columnCount);
  const bodyRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<ScrollMetrics>({ maximum: 0, viewport: 0, gutter: 0 });
  useLayoutEffect(() => () => lanes.dispose(), [lanes]);
  useLayoutEffect(() => sync.register(barRef.current ?? undefined), [sync]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return undefined;
    }
    // Only the sheet's lane sizes the scrollbar: a wider table in another lane
    // would otherwise give the bar a range the sheet's tables cannot follow.
    const lane = `[data-scroll-lane="${columnCount}"]`;
    const strips = body.querySelectorAll<HTMLElement>(`.vars-scroll-rows${lane}, .vars-scroll-head${lane}`);
    assert(strips.length <= SCROLL_PEERS_MAX, 'Variable scroll: strip limit exceeded');
    const measure = () => {
      // A hidden editor has no geometry. Preserve its position until it is visible again.
      if (body.clientWidth === 0) {
        return;
      }
      fitHeadings(body);
      const next = measureSheet(body, strips);
      setMetrics((previous) => (previous.maximum === next.maximum && previous.viewport === next.viewport && previous.gutter === next.gutter ? previous : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    for (const strip of strips) {
      observer.observe(strip);
    }
    return () => observer.disconnect();
  }, [blocks, columnCount]);
  useLayoutEffect(() => sync.fit(metrics.maximum), [sync, metrics]);
  return { lanes, sync, bodyRef, barRef, metrics };
}

export function VariableScrollBar({ scroll }: { readonly scroll: ReturnType<typeof useVariableSheetScroll> }) {
  const translate = useTranslate();
  const { metrics, barRef, sync } = scroll;
  return (
    <div className="vars-scrollbar-row" hidden={metrics.maximum <= 0} style={{ paddingRight: metrics.gutter }}>
      <div
        className="vars-horizontal-scroll"
        ref={barRef}
        role="region"
        aria-label={translate('variables.scroll.label')}
        tabIndex={0}
        onScroll={(event) => sync.broadcast(event.currentTarget, event.currentTarget.scrollLeft)}
      >
        <div style={{ width: metrics.viewport + metrics.maximum, height: 1 }} />
      </div>
    </div>
  );
}

// A heading longer than this is cut off rather than widening the page further:
// one very long name would otherwise push every other column off screen.
const HEADING_WIDTH_PX_MAX = 480;
const HEADINGS_MAX = SCROLL_PEERS_MAX * LIMITS.scanEntriesMax;

// Widens the value columns to the page's widest heading. Headings do not wrap
// (see .vars-scroll-head .vars-head), so each one's scrollWidth is its full
// one-line width; widening the columns does not change it, so this settles in
// one pass and the resize it causes measures the same width again.
function fitHeadings(body: HTMLElement) {
  assert(body.clientWidth > 0, 'Variable scroll: visible body is required');
  const headings = body.querySelectorAll<HTMLElement>('.vars-scroll-head .vars-head');
  assert(headings.length <= HEADINGS_MAX, 'Variable scroll: heading limit exceeded');
  let widthPx = 0;
  for (const heading of headings) {
    widthPx = Math.max(widthPx, heading.scrollWidth);
  }
  const fitPx = Math.min(HEADING_WIDTH_PX_MAX, Math.ceil(widthPx));
  assert(fitPx >= 0, 'Variable scroll: heading width must be nonnegative');
  const value = `${fitPx}px`;
  if (body.style.getPropertyValue('--vars-col-fit') !== value) {
    body.style.setProperty('--vars-col-fit', value);
  }
}

function measureSheet(body: HTMLElement, strips: NodeListOf<HTMLElement>): ScrollMetrics {
  assert(body.clientWidth > 0, 'Variable scroll: visible body is required');
  assert(strips.length <= SCROLL_PEERS_MAX, 'Variable scroll: strip limit exceeded');
  let maximum = 0;
  for (const strip of strips) {
    maximum = Math.max(maximum, strip.scrollWidth - strip.clientWidth);
  }
  return {
    maximum,
    viewport: strips[0]?.clientWidth ?? 0,
    gutter: body.offsetWidth - body.clientWidth,
  };
}
