// Segmented tabs: plain labels over one pill that slides to the active tab
// (segmentIndicator.ts, segmentedTabs.css). The Apps panel's Installed /
// Marketplace switch draws with it, and so does the app UI kit's
// `<stacki-tabs>` (src/features/apps/uiKit/kitElements.tsx), so an app's tabs
// are this component, not a copy of it.
//
// Each tab is as wide as its label plus the same padding, so "Open 1 /
// Resolved / All" reads as three labels, not three equal boxes with the short
// ones swimming in space; the track hugs them. A two-way switch that fills its
// row asks for `layout: 'equal'` instead. Either way the pill measures the
// active tab's own offset and width (segmentIndicator.ts), so it never assumes
// tabs are equal.
import { useRef, type ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { segmentIndicatorStyle, useSegmentIndicator } from './segmentIndicator';
import './segmentedTabs.css';

export interface SegmentedTab<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
}

/** The most tabs a row holds: a handful fit; more is a caller bug. */
const SEGMENTED_TABS_MAX = 16;

/**
 * How the tabs share the row: `content` (the default) sizes each to its label
 * and the track to its tabs; `equal` stretches the track to its container and
 * splits it evenly, for a two-way switch that fills a row.
 */
export const SEGMENTED_TABS_LAYOUTS = ['content', 'equal'] as const;
export type SegmentedTabsLayout = (typeof SEGMENTED_TABS_LAYOUTS)[number];

export function SegmentedTabs<T extends string>({
  tabs,
  value,
  label,
  layout = 'content',
  className,
  onPick,
}: {
  readonly tabs: readonly SegmentedTab<T>[];
  readonly value: T;
  /** The tab list's accessible name. */
  readonly label: string;
  /** `content` (default): each tab as wide as its label. `equal`: the tabs fill the row in equal shares. */
  readonly layout?: SegmentedTabsLayout | undefined;
  /**
   * Extra classes for a caller's hooks: `track` on the row, `indicator` on the
   * pill and `tab` on each tab (the Apps panel keeps its `apps-view-tab*`).
   */
  readonly className?: { readonly track?: string; readonly indicator?: string; readonly tab?: string };
  readonly onPick: (value: T) => void;
}) {
  assert(tabs.length > 0, 'SegmentedTabs: there is a tab');
  assert(tabs.length <= SEGMENTED_TABS_MAX, 'SegmentedTabs: the tabs fit a row');
  assert(SEGMENTED_TABS_LAYOUTS.includes(layout), 'SegmentedTabs: the layout is a known one');
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | undefined>>([]);
  const selectedIndex = tabs.findIndex((tab) => tab.value === value);
  const { indicator, animated } = useSegmentIndicator({
    trackRef,
    buttonsRef,
    selectedIndex,
    layoutKey: `${layout}:${tabs.map((tab) => tab.label).join('\u0000')}`,
  });
  const extra = (name: string | undefined): string => (name === undefined ? '' : ` ${name}`);
  return (
    <div ref={trackRef} className={`ui-tabs${layout === 'equal' ? ' is-equal' : ''}${extra(className?.track)}`} role="tablist" aria-label={label}>
      <span
        className={`ui-tabs-indicator${extra(className?.indicator)}${animated ? ' is-animated' : ''}`}
        aria-hidden="true"
        style={segmentIndicatorStyle(indicator)}
      />
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          ref={(element) => {
            buttonsRef.current[index] = element ?? undefined;
          }}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={`ui-tab${extra(className?.tab)}${value === tab.value ? ' on' : ''}`}
          onClick={() => onPick(tab.value)}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
