import { centralIcon } from '../../ui/central/CentralIcon';
import { chevronDown as centralChevronDown, chevronUp as centralChevronUp, properties as centralProperties } from '../../ui/central/centralGeometry';
// The grid controls' glyphs and value lists: flow and density icons, the
// alignment and content-distribution icons, and their labels
// (GridControls.tsx).

import type { ReactNode } from 'react';
import { type SegmentedOption } from './components/SegmentedControl';

export const FLEX_FLOW_WRAP_ICON_FIRST_PATH =
  'M14.207 11.5L10.8535 14.8535L10.1465 14.1465L12.293 12H3V11H12.293L10.1465 8.85352' + 'L10.8535 8.14648L14.207 11.5ZM11 4H3V3H11V4Z';

// ── value lists ──
// grid-auto-flow direction glyphs (Webflow's flow-wrap icons): row fills across then
// wraps down; column fills down then wraps across.
export const FlexFlowWrapIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path d={FLEX_FLOW_WRAP_ICON_FIRST_PATH} fill="currentColor" />
    <path opacity="0.4" d="M11 4.20703L4.20703 11H3V10.793L9.79297 4H11V4.20703Z" fill="currentColor" />
  </svg>
);
export const FLEX_FLOW_COLUMN_WRAP_ICON_FIRST_PATH =
  'M11.5 14.207L14.8535 10.8535L14.1465 10.1465L12 12.293L12 3L11 3L11 12.293L8.85352 10.1465' + 'L8.14648 10.8535L11.5 14.207ZM4 11L4 3L3 3L3 11L4 11Z';

export const FlexFlowColumnWrapIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path d={FLEX_FLOW_COLUMN_WRAP_ICON_FIRST_PATH} fill="currentColor" />
    <path opacity="0.4" d="M4.20703 11L11 4.20703L11 3L10.793 3L4 9.79297L4 11L4.20703 11Z" fill="currentColor" />
  </svg>
);
export const GRID_FLOW: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'row', label: <FlexFlowWrapIcon />, ariaLabel: 'Horizontal', tooltip: 'Horizontal' },
  {
    value: 'column',
    label: <FlexFlowColumnWrapIcon />,
    ariaLabel: 'Vertical',
    tooltip: 'Vertical',
  },
];
// Item alignment (justify-items = X, align-items = Y), Webflow's order.
export const GRID_ITEM_ALIGN = ['start', 'center', 'end', 'stretch', 'baseline'];
export const GRID_CONTENT = ['start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly'];

// Box alignment has flex-flavoured synonyms for the same positions, and the Flex
// settings block writes those (`justify-content: flex-start` is valid on a grid
// container and behaves as `start`). Fold them onto the grid spelling for DISPLAY, so
// a value authored there — or by hand — still lands on a preset instead of dropping
// the control into its raw-value input. The declaration itself is left alone until
// the user picks something.
export const GRID_SYNONYMS: Record<string, string> = {
  'flex-start': 'start',
  'flex-end': 'end',
  'self-start': 'start',
  'self-end': 'end',
  left: 'start',
  right: 'end',
  normal: 'stretch',
};
export const gridKeyword = (value: string) => GRID_SYNONYMS[value] ?? value;

// Webflow's grid align-self glyphs — the Column set drives X (justify-items), the Row
// set drives Y (align-items). Keyed by grid keyword.
export const GridAlignIcon = ({ paths }: { paths: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {paths}
  </svg>
);
export const X_ALIGN_BASELINE_SECOND_PATH =
  'M7.64645 1.35355L9.29289 3H3V4H9.29289L7.64645 5.64645L8.35355 6.35355L11.2071 3.5' + 'L8.35355 0.646447L7.64645 1.35355Z';
export const X_ALIGN_BASELINE_THIRD_PATH =
  'M3 11.3746V9.6263L11 7.27331V8.31566L8.99994 8.90393V12.0969L11 12.6852V13.7275L3 11.3746Z' +
  'M7.99994 9.19806L3.9999 10.3746V10.6263L7.99994 11.8028V9.19806Z';

export const X_ALIGN_ICONS: Record<string, ReactNode> = {
  start: <path d="M2 1V15H3V9H11.5C11.7761 9 12 8.77614 12 8.5V7.5C12 7.22386 11.7761 7 11.5 7H3V1H2Z" fill="currentColor" />,
  center: (
    <>
      <path d="M7 15V9H2.5C2.22386 9 2 8.77614 2 8.5V7.5C2 7.22386 2.22386 7 2.5 7H7V1H8V15H7Z" fill="currentColor" />
      <path d="M14 7.5C14 7.22386 13.7761 7 13.5 7H9V9H13.5C13.7761 9 14 8.77614 14 8.5V7.5Z" fill="currentColor" />
    </>
  ),
  end: <path d="M13 9V15H14V1H13V7H4.5C4.22386 7 4 7.22386 4 7.5V8.5C4 8.77614 4.22386 9 4.5 9H13Z" fill="currentColor" />,
  stretch: <path d="M2 15V1H3V7H13V1H14V15H13V9H3V15H2Z" fill="currentColor" />,
  baseline: (
    <>
      <path d="M13 0V15H14V0H13Z" fill="currentColor" />
      <path d={X_ALIGN_BASELINE_SECOND_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={X_ALIGN_BASELINE_THIRD_PATH} fill="currentColor" />
    </>
  ),
};
export const Y_ALIGN_BASELINE_FIRST_PATH = 'M13 2V8.29289L14.6464 6.64645L15.3536 7.35355L12.5 10.2071L9.64645 7.35355L10.3536 6.64645' + 'L12 8.29289V2H13Z';
export const Y_ALIGN_BASELINE_THIRD_PATH =
  'M4.62582 2H6.37412L8.72712 10H7.68476L7.09649 7.99994H3.90349L3.31524 10H2.27288L4.62582 2' +
  'ZM6.80237 6.99994L5.62585 2.9999H5.37409L4.19761 6.99994H6.80237Z';

export const Y_ALIGN_ICONS: Record<string, ReactNode> = {
  start: <path d="M15 2H1V3L7 3L7 11.5C7 11.7761 7.22386 12 7.5 12H8.5C8.77614 12 9 11.7761 9 11.5V3H15V2Z" fill="currentColor" />,
  center: (
    <>
      <path d="M9 7V2.5C9 2.22386 8.77614 2 8.5 2H7.5C7.22386 2 7 2.22386 7 2.5V7L1 7V8L15 8V7H9Z" fill="currentColor" />
      <path d="M9 9V13.5C9 13.7761 8.77614 14 8.5 14H7.5C7.22386 14 7 13.7761 7 13.5V9H9Z" fill="currentColor" />
    </>
  ),
  end: <path d="M9 13V4.5C9 4.22386 8.77614 4 8.5 4H7.5C7.22386 4 7 4.22386 7 4.5L7 13L1 13V14L15 14V13H9Z" fill="currentColor" />,
  stretch: <path d="M1 3V2H15V3H9V13L15 13V14L1 14V13H7L7 3L1 3Z" fill="currentColor" />,
  baseline: (
    <>
      <path d={Y_ALIGN_BASELINE_FIRST_PATH} fill="currentColor" />
      <path d="M16 12L1 12V13L16 13V12Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={Y_ALIGN_BASELINE_THIRD_PATH} fill="currentColor" />
    </>
  ),
};
// Axis-aware labels: start/end read Left/Right on X, Top/Bottom on Y (Webflow).
export const X_ALIGN_LABELS: Record<string, string> = {
  start: 'Left',
  center: 'Center',
  end: 'Right',
  stretch: 'Stretch',
  baseline: 'Baseline',
};
export const Y_ALIGN_LABELS: Record<string, string> = {
  start: 'Top',
  center: 'Center',
  end: 'Bottom',
  stretch: 'Stretch',
  baseline: 'Baseline',
};

export const LABELS: Record<string, string> = {
  'space-between': 'Space between',
  'space-around': 'Space around',
  'space-evenly': 'Space evenly',
  start: 'Start',
  end: 'End',
  center: 'Center',
  stretch: 'Stretch',
};
export const cap = (word: string) => (word ? (word[0] ?? '').toUpperCase() + word.slice(1) : word);

// ── content-distribution glyphs (justify-content = Columns, align-content = Rows) ──
// Webflow's grid content icons: Column variants for justify-content, Row variants for
// align-content. space-evenly (not in Webflow's set) reuses the space-around glyph.
export const CONTENT_PATHS: Record<string, { col: string[]; row: string[] }> = {
  start: {
    col: [
      'M3 14V10H5.5C5.77614 10 6 9.77614 6 9.5V8.5C6 8.22386 5.77614 8 5.5 8H3V7H5.5' + 'C5.77614 7 6 6.77614 6 6.5V5.5C6 5.22386 5.77614 5 5.5 5H3V1H2V14H3Z',
      'M7 5.5C7 5.22386 7.22386 5 7.5 5H9.5C9.77614 5 10 5.22386 10 5.5V6.5' + 'C10 6.77614 9.77614 7 9.5 7H7.5C7.22386 7 7 6.77614 7 6.5V5.5Z',
      'M7 8.5C7 8.22386 7.22386 8 7.5 8H9.5C9.77614 8 10 8.22386 10 8.5V9.5' + 'C10 9.77614 9.77614 10 9.5 10H7.5C7.22386 10 7 9.77614 7 9.5V8.5Z',
    ],
    row: [
      'M15 3L11 3V5.5C11 5.77614 10.7761 6 10.5 6H9.5C9.22386 6 9 5.77614 9 5.5V3L8 3L8 5.5' +
        'C8 5.77614 7.77614 6 7.5 6H6.5C6.22386 6 6 5.77614 6 5.5L6 3L2 3V2H15V3Z',
      'M6.5 7C6.22386 7 6 7.22386 6 7.5L6 9.5C6 9.77614 6.22386 10 6.5 10H7.5' + 'C7.77614 10 8 9.77614 8 9.5L8 7.5C8 7.22386 7.77614 7 7.5 7H6.5Z',
      'M9.5 7C9.22386 7 9 7.22386 9 7.5V9.5C9 9.77614 9.22386 10 9.5 10H10.5' + 'C10.7761 10 11 9.77614 11 9.5V7.5C11 7.22386 10.7761 7 10.5 7H9.5Z',
    ],
  },
  center: {
    col: [
      'M7 10V14H8V1H7V5H4.5C4.22386 5 4 5.22386 4 5.5V6.5C4 6.77614 4.22386 7 4.5 7H7V8H4.5' + 'C4.22386 8 4 8.22386 4 8.5V9.5C4 9.77614 4.22386 10 4.5 10H7Z',
      'M11.5 5H9V7H11.5C11.7761 7 12 6.77614 12 6.5V5.5C12 5.22386 11.7761 5 11.5 5Z',
      'M9 8H11.5C11.7761 8 12 8.22386 12 8.5V9.5C12 9.77614 11.7761 10 11.5 10H9V8Z',
    ],
    row: [
      'M11 7V4.5C11 4.22386 10.7761 4 10.5 4H9.5C9.22386 4 9 4.22386 9 4.5V7L8 7V4.5' +
        'C8 4.22386 7.77614 4 7.5 4H6.5C6.22386 4 6 4.22386 6 4.5V7L2 7V8L15 8V7H11Z',
      'M11 9V11.5C11 11.7761 10.7761 12 10.5 12H9.5C9.22386 12 9 11.7761 9 11.5V9H11Z',
      'M8 9V11.5C8 11.7761 7.77614 12 7.5 12H6.5C6.22386 12 6 11.7761 6 11.5V9H8Z',
    ],
  },
  end: {
    col: [
      'M12 14V10H9.5C9.22386 10 9 9.77614 9 9.5V8.5C9 8.22386 9.22386 8 9.5 8H12V7H9.5' +
        'C9.22386 7 9 6.77614 9 6.5V5.5C9 5.22386 9.22386 5 9.5 5H12V1H13V14H12Z',
      'M8 5.5C8 5.22386 7.77614 5 7.5 5H5.5C5.22386 5 5 5.22386 5 5.5V6.5' + 'C5 6.77614 5.22386 7 5.5 7H7.5C7.77614 7 8 6.77614 8 6.5V5.5Z',
      'M8 8.5C8 8.22386 7.77614 8 7.5 8H5.5C5.22386 8 5 8.22386 5 8.5V9.5' + 'C5 9.77614 5.22386 10 5.5 10H7.5C7.77614 10 8 9.77614 8 9.5V8.5Z',
    ],
    row: [
      'M6.5 8C6.22386 8 6 7.77614 6 7.5V5.5C6 5.22386 6.22386 5 6.5 5H7.5' + 'C7.77614 5 8 5.22386 8 5.5L8 7.5C8 7.77614 7.77614 8 7.5 8H6.5Z',
      'M6.5 9C6.22386 9 6 9.22386 6 9.5V12H2V13L15 13V12L11 12V9.5' +
        'C11 9.22386 10.7761 9 10.5 9H9.5C9.22386 9 9 9.22386 9 9.5V12H8L8 9.5' +
        'C8 9.22386 7.77614 9 7.5 9H6.5Z',
      'M9.5 8C9.22386 8 9 7.77614 9 7.5V5.5C9 5.22386 9.22386 5 9.5 5H10.5' + 'C10.7761 5 11 5.22386 11 5.5V7.5C11 7.77614 10.7761 8 10.5 8H9.5Z',
    ],
  },
  stretch: {
    col: [
      'M2 14V1H3V5H7.5C7.77614 5 8 5.22386 8 5.5L8 6.5C8 6.77614 7.77614 7 7.5 7H3L3 8H7.5' +
        'C7.77614 8 8 8.22386 8 8.5L8 9.5C8 9.77614 7.77614 10 7.5 10H3L3 14H2Z',
      'M14 14V10H9.5C9.22386 10 9 9.77614 9 9.5V8.5C9 8.22386 9.22386 8 9.5 8H14V7H9.5' +
        'C9.22386 7 9 6.77614 9 6.5V5.5C9 5.22386 9.22386 5 9.5 5H14V1H15V14H14Z',
    ],
    row: [
      'M15 3L11 3V6.5C11 6.77614 10.7761 7 10.5 7H9.5C9.22386 7 9 6.77614 9 6.5V3L8 3V6.5' +
        'C8 6.77614 7.77614 7 7.5 7H6.5C6.22386 7 6 6.77614 6 6.5V3L2 3V2H15V3Z',
      'M15 13L2 13V12L6 12V8.5C6 8.22386 6.22386 8 6.5 8H7.5C7.77614 8 8 8.22386 8 8.5V12H9' +
        'V8.5C9 8.22386 9.22386 8 9.5 8H10.5C10.7761 8 11 8.22386 11 8.5V12H15V13Z',
    ],
  },
  'space-between': {
    col: [
      'M2 14V1H3V5H5.5C5.77614 5 6 5.22386 6 5.5L6 6.5C6 6.77614 5.77614 7 5.5 7H3L3 8H5.5' +
        'C5.77614 8 6 8.22386 6 8.5V9.5C6 9.77614 5.77614 10 5.5 10H3L3 14H2ZM14 14V10H11.5' +
        'C11.2239 10 11 9.77614 11 9.5V8.5C11 8.22386 11.2239 8 11.5 8H14V7H11.5' +
        'C11.2239 7 11 6.77614 11 6.5V5.5C11 5.22386 11.2239 5 11.5 5H14V1H15V14H14Z',
    ],
    row: [
      'M15 2L11 2V4.5C11 4.77614 10.7761 5 10.5 5H9.5C9.22386 5 9 4.77614 9 4.5V2L8 2V4.5' +
        'C8 4.77614 7.77614 5 7.5 5H6.5C6.22386 5 6 4.77614 6 4.5V2L2 2V1H15V2Z',
      'M15 14L2 14V13L6 13V10.5C6 10.2239 6.22386 10 6.5 10H7.5C7.77614 10 8 10.2239 8 10.5' +
        'V13H9V10.5C9 10.2239 9.22386 10 9.5 10H10.5C10.7761 10 11 10.2239 11 10.5V13H15V14Z',
    ],
  },
  'space-around': {
    col: [
      'M3 14H2V1H3V14Z',
      'M15 14H14V1H15V14Z',
      'M6.5 8C6.77614 8 7 8.22386 7 8.5V9.5C7 9.77614 6.77614 10 6.5 10H4.5' + 'C4.22386 10 4 9.77614 4 9.5V8.5C4 8.22386 4.22386 8 4.5 8H6.5Z',
      'M12.5 8C12.7761 8 13 8.22386 13 8.5V9.5C13 9.77614 12.7761 10 12.5 10H10.5' + 'C10.2239 10 10 9.77614 10 9.5V8.5C10 8.22386 10.2239 8 10.5 8H12.5Z',
      'M6.5 5C6.77614 5 7 5.22386 7 5.5V6.5C7 6.77614 6.77614 7 6.5 7H4.5' + 'C4.22386 7 4 6.77614 4 6.5V5.5C4 5.22386 4.22386 5 4.5 5H6.5Z',
      'M12.5 5C12.7761 5 13 5.22386 13 5.5V6.5C13 6.77614 12.7761 7 12.5 7H10.5' + 'C10.2239 7 10 6.77614 10 6.5V5.5C10 5.22386 10.2239 5 10.5 5H12.5Z',
    ],
    row: [
      'M2 1H15V2L2 2V1Z',
      'M2 13L15 13V14L2 14V13Z',
      'M8 3.5C8 3.22386 7.77614 3 7.5 3L6.5 3C6.22386 3 6 3.22386 6 3.5L6 5.5' + 'C6 5.77614 6.22386 6 6.5 6L7.5 6C7.77614 6 8 5.77614 8 5.5V3.5Z',
      'M9 3.5C9 3.22386 9.22386 3 9.5 3L10.5 3C10.7761 3 11 3.22386 11 3.5V5.5' + 'C11 5.77614 10.7761 6 10.5 6L9.5 6C9.22386 6 9 5.77614 9 5.5V3.5Z',
      'M8 9.5C8 9.22386 7.77614 9 7.5 9L6.5 9C6.22386 9 6 9.22386 6 9.5L6 11.5' + 'C6 11.7761 6.22386 12 6.5 12H7.5C7.77614 12 8 11.7761 8 11.5V9.5Z',
      'M9 9.5C9 9.22386 9.22386 9 9.5 9L10.5 9C10.7761 9 11 9.22386 11 9.5V11.5' + 'C11 11.7761 10.7761 12 10.5 12H9.5C9.22386 12 9 11.7761 9 11.5V9.5Z',
    ],
  },
};
export function ContentIcon({ value, vertical }: { value: string; vertical: boolean }) {
  const set = CONTENT_PATHS[value] ?? CONTENT_PATHS['space-around'];
  if (set === undefined) {
    return undefined;
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      {(vertical ? set.row : set.col).map((path, i) => (
        <path key={i} d={path} fillRule="evenodd" clipRule="evenodd" fill="currentColor" />
      ))}
    </svg>
  );
}
export const contentOptions = ({ vertical }: { readonly vertical: boolean }): ReadonlyArray<SegmentedOption<string>> => {
  // Vertical → align-content (Rows); otherwise justify-content (Columns). The tooltip
  // names the property, like Webflow ("Justify Content: Center").
  const propName = vertical ? 'Align Content' : 'Justify Content';
  return GRID_CONTENT.map((option) => {
    const name = `${propName}: ${LABELS[option] ?? cap(option)}`;
    return {
      value: option,
      label: <ContentIcon value={option} vertical={vertical} />,
      ariaLabel: name,
      tooltip: name,
    };
  });
};

// Icons.
export const ChevUp = centralIcon(centralChevronUp, 12);
export const ChevDown = centralIcon(centralChevronDown, 12);
export const DENSE_ICON_FIRST_PATH =
  'M14.8535 11.1465 14.1465 11.8535 12.5 10.207V14H11.5v-3.793' + 'L9.85352 11.8535 9.14648 11.1465 12 8.29297 14.8535 11.1465Z';
export const DENSE_ICON_SECOND_PATH =
  'M14.1025 1.005C14.6067 1.056 15 1.482 15 2v4l-.005.103c-.048.47-.422.844-.892.892L14 7h-4' +
  'c-.518 0-.944-.393-.995-.897L9 6V2c0-.552.448-1 1-1h4l.103.005ZM10 6h4V2h-4v4Z';
export const DENSE_ICON_FOURTH_PATH =
  'M7.103 1.005C7.607 1.056 8 1.482 8 2v4l-.005.103c-.048.47-.422.844-.892.892L7 7H3' +
  'c-.518 0-.944-.393-.995-.897L2 6V2c0-.552.448-1 1-1h4l.103.005ZM3 6h4V2H3v4Z';

export const DenseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d={DENSE_ICON_FIRST_PATH} fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d={DENSE_ICON_SECOND_PATH} fill="currentColor" />
    <path d="M9 9H3v4h6v1H3l-.103-.005c-.47-.048-.844-.422-.892-.892L2 13V9c0-.552.448-1 1-1h6v1Z" fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d={DENSE_ICON_FOURTH_PATH} fill="currentColor" />
  </svg>
);
// The "customize track sizes" toggle (Webflow's grid gear) — swaps the count
// steppers for raw grid-template fields so non-uniform tracks (200px 1fr auto…) can
// be typed instead of only N equal 1fr tracks.
export const CustomizeIcon = centralIcon(centralProperties);
