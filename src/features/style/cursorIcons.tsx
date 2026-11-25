import type { ReactNode } from 'react';
import { centralIcon } from '../../ui/central/CentralIcon';
import {
  arrowDown,
  arrowLeft,
  arrowRight,
  arrowUp,
  copy,
  cursorClick,
  drag,
  expand,
  eyeOff,
  help,
  link,
  listMenu,
  move,
  search,
  spinner,
  stop,
  target,
  text,
} from '../../ui/central/centralGeometry';

// Glyphs keyed by the CSS `cursor` keyword — shown next to each option in the Cursor
// dropdown (EffectsSection). Every cursor that has a close Central v1.35 glyph uses it;
// the rest keep their old hand-drawn path until Central ships a match (see the list at the
// bottom). Rendered at 16px. Each Central glyph is used for one keyword only, so the
// dropdown rows stay distinguishable.

function I({ vb = '0 0 24 24', d: path }: { vb?: string; d: string }) {
  return (
    <svg width="16" height="16" viewBox={vb} fill="none" aria-hidden="true">
      <path d={path} fill="currentColor" />
    </svg>
  );
}
function IMulti({ paths }: { paths: Array<[string, number?]> }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths.map(([path, opacity], i) => (
        <path key={i} d={path} fill="currentColor" opacity={opacity} />
      ))}
    </svg>
  );
}

const ArrowDownGlyph = centralIcon(arrowDown);
const ArrowLeftGlyph = centralIcon(arrowLeft);
const ArrowRightGlyph = centralIcon(arrowRight);
const ArrowUpGlyph = centralIcon(arrowUp);
const CopyGlyph = centralIcon(copy);
const CursorClickGlyph = centralIcon(cursorClick);
const DragGlyph = centralIcon(drag);
const ExpandGlyph = centralIcon(expand);
const EyeOffGlyph = centralIcon(eyeOff);
const HelpGlyph = centralIcon(help);
const LinkGlyph = centralIcon(link);
const ListMenuGlyph = centralIcon(listMenu);
const MoveGlyph = centralIcon(move);
const SearchGlyph = centralIcon(search);
const SpinnerGlyph = centralIcon(spinner);
const StopGlyph = centralIcon(stop);
const TargetGlyph = centralIcon(target);
const TextGlyph = centralIcon(text);

// The arrow (auto / default share it).
const ARROW = 'M19.074 12.1695L6 1.5V18.7995L10.065 14.7645L13.611 21.8625' + 'L16.6455 20.2905L13.185 13.368L19.074 12.1695Z';

const CELL_CURSOR_PATH =
  'M21 7.5H16.5V2.8125L15 1.5H7.5V7.5H1.5V15L2.8125 16.5H7.5V21L8.8005 22.5' + 'H16.5V16.5H22.5V8.787L21 7.5ZM3 9H9V3H13.5V9H19.5V13.5H13.5V19.5H9V13.5H3V9Z';
const VERTICAL_TEXT_CURSOR_PATH =
  'M19.5 7.5C19.4988 8.29528 19.1824 9.05765 18.62 9.62001C18.0577 10.1824 17.2953 10.4988 ' +
  '16.5 10.5H15V9H12V10.5H7.5C6.70472 10.4988 5.94235 10.1824 5.37999 9.62001C4.81764 ' +
  '9.05765 4.50119 8.29528 4.5 7.5H1.5C1.50189 8.35469 1.68774 9.19896 2.04492 9.97543' +
  'C2.4021 10.7519 2.92224 11.4424 3.57 12C2.92224 12.5576 2.4021 13.2481 2.04492 14.0246' +
  'C1.68774 14.801 1.50189 15.6453 1.5 16.5H4.5C4.50119 15.7047 4.81764 14.9423 5.37999 14.38' +
  'C5.94235 13.8176 6.70472 13.5012 7.5 13.5H12V15H15V13.5H16.5C17.2953 13.5012 18.0577 ' +
  '13.8176 18.62 14.38C19.1824 14.9423 19.4988 15.7047 19.5 16.5H22.5C22.4981 15.6453 ' +
  '22.3123 14.801 21.9551 14.0246C21.5979 13.2481 21.0778 12.5576 20.43 12C21.0778 ' +
  '11.4424 21.5979 10.7519 21.9551 9.97543C22.3123 9.19896 22.4981 8.35469 22.5 7.5H19.5Z';
const GRABBING_CURSOR_PATH =
  'M20.991 7.50034C20.967 6.57034 20.466 6.36034 19.5 6.36034C19.329 6.36034 19.1955 6.38134 ' +
  '19.0545 6.39784V9.36784H18V6.36034C18 5.37034 17.49 5.16034 16.5 5.16034C16.329 5.16034 ' +
  '16.1955 5.18284 16.0545 5.19934V7.99984H15V5.16484C15 4.17484 13.74 3.96484 12.75 3.96484' +
  'C11.76 3.96484 10.5 4.17484 10.5 5.16484V7.99984H9.4455V5.31034C9.05497 5.21034 8.65312 ' +
  '5.16143 8.25 5.16484C7.26 5.16484 6 5.37484 6 6.36484V11.1603H4.9455V9.00034H4.8555' +
  'C3.621 9.00034 3 10.1013 3 11.2623C3 13.6533 4.239 19.5003 11.2545 19.5003H15.384' +
  'C18.804 19.5003 21 17.4333 21 14.1303V7.50034H20.991ZM10.5 15.7503C10.5 15.9493 10.421 ' +
  '16.14 10.2803 16.2807C10.1397 16.4213 9.94891 16.5003 9.75 16.5003C9.55109 16.5003 ' +
  '9.36032 16.4213 9.21967 16.2807C9.07902 16.14 9 15.9493 9 15.7503V12.7503C9 12.5514 ' +
  '9.07902 12.3607 9.21967 12.22C9.36032 12.0794 9.55109 12.0003 9.75 12.0003C9.94891 ' +
  '12.0003 10.1397 12.0794 10.2803 12.22C10.421 12.3607 10.5 12.5514 10.5 12.7503V15.7503' +
  'ZM13.5 15.7503C13.5 15.9493 13.421 16.14 13.2803 16.2807C13.1397 16.4213 12.9489 ' +
  '16.5003 12.75 16.5003C12.5511 16.5003 12.3603 16.4213 12.2197 16.2807C12.079 16.14 ' +
  '12 15.9493 12 15.7503V12.7503C12 12.5514 12.079 12.3607 12.2197 12.22C12.3603 12.0794 ' +
  '12.5511 12.0003 12.75 12.0003C12.9489 12.0003 13.1397 12.0794 13.2803 12.22' +
  'C13.421 12.3607 13.5 12.5514 13.5 12.7503V15.7503ZM16.5 15.7503C16.5 15.9493 16.421 ' +
  '16.14 16.2803 16.2807C16.1397 16.4213 15.9489 16.5003 15.75 16.5003C15.5511 16.5003 ' +
  '15.3603 16.4213 15.2197 16.2807C15.079 16.14 15 15.9493 15 15.7503V12.7503C15 12.5514 ' +
  '15.079 12.3607 15.2197 12.22C15.3603 12.0794 15.5511 12.0003 15.75 12.0003C15.9489 ' +
  '12.0003 16.1397 12.0794 16.2803 12.22C16.421 12.3607 16.5 12.5514 16.5 12.7503V15.7503Z';
const ZOOM_OUT_CURSOR_PATH =
  'M17.8305 15.7095C18.9169 14.1897 19.5007 12.3682 19.5 10.5C19.5 8.71997 18.9722 ' +
  '6.97991 17.9832 5.49987C16.9943 4.01983 15.5887 2.86628 13.9442 2.18509C12.2996 ' +
  '1.5039 10.49 1.32567 8.74419 1.67294C6.99836 2.0202 5.39472 2.87737 4.13604 4.13604' +
  'C2.87737 5.39472 2.0202 6.99836 1.67294 8.74419C1.32567 10.49 1.5039 12.2996 ' +
  '2.18509 13.9442C2.86628 15.5887 4.01983 16.9943 5.49987 17.9832C6.97991 18.9722 ' +
  '8.71997 19.5 10.5 19.5C12.3681 19.5005 14.1897 18.9168 15.7095 17.8305L20.379 22.5' +
  'L22.5 20.379L17.8305 15.7095ZM10.5 18C6.3645 18 3 14.6355 3 10.5C3 6.3645 6.3645 3 10.5 3' +
  'C14.6355 3 18 6.3645 18 10.5C18 14.6355 14.6355 18 10.5 18ZM6 12H15V9H6V12Z';
const COLUMN_RESIZE_CURSOR_PATH =
  'M21.5999 11.9996L16.7999 7.19961V10.7996H13.1999V3.59961H10.7999' +
  'V10.7996H7.1999V7.19961L2.3999 11.9996L7.1999 16.7996V13.1996' +
  'H10.7999V20.3996H13.1999V13.1996H16.7999V16.7996L21.5999 11.9996Z';
const ROW_RESIZE_CURSOR_PATH = 'M18 10.5H13.5V7.5H18L12 1.5L6 7.5H10.5V10.5H1.5V13.5' + 'H10.5V16.5H6L12 22.5L18 16.5H13.5V13.5H22.5V10.5H18Z';
const NWSE_RESIZE_CURSOR_PATH = 'M17.82 15.6975L8.3025 6.183L11.4825 3.003L3 3V11.4855' + 'L6.183 8.3055L15.6975 17.8185L12.5175 21H21V12.516L17.82 15.6975Z';
const NW_RESIZE_CURSOR_PATH = 'M22.5 19.3969L10.1913 7.08827L14.2796 3H3V14.2796' + 'L7.08827 10.1913L19.3969 22.5L22.5 19.3969Z';
const SW_RESIZE_CURSOR_PATH = 'M22.5 4.6031L19.3969 1.5L7.08827 13.8087L3 9.72039V21H14.2796L10.1913 16.9117L22.5 4.6031Z';
const SE_RESIZE_CURSOR_PATH = 'M1.5 4.6031L4.6031 1.5L16.9117 13.8087L21 9.72039V21H9.72039L13.8087 16.9117L1.5 4.6031Z';

export const CURSOR_ICONS: Record<string, ReactNode> = {
  auto: <I d={ARROW} />,
  default: <I d={ARROW} />,
  none: <EyeOffGlyph />,

  pointer: <CursorClickGlyph />,
  'not-allowed': <StopGlyph />,
  wait: <SpinnerGlyph />,
  progress: (
    <IMulti
      paths={[
        ['M10.5 8.769L1.5 1.5V13.0305L4.725 10.4355L6.9945 15L8.9415 13.989L6.72 9.54L10.5 8.769Z'],
        ['M15.75 10.5H17.25V13.5H15.75V10.5Z'],
        ['M15.75 19.5H17.25V22.5H15.75V19.5Z', 0.7],
        ['M10.5 15.75H13.5V17.25H10.5V15.75Z', 0.9],
        ['M15.156 14.0955L14.0955 15.156L12 13.0605L13.0605 12L15.156 14.0955Z', 0.95],
        ['M21.0779 20.0153L20.0174 21.0758L17.9219 18.9863L18.9824 17.9258L21.0779 20.0153Z', 0.5],
        ['M14.094 17.9258L15.1545 18.9848L13.0605 21.0788L12 20.0183L14.094 17.9258Z', 0.8],
        ['M20.0174 12L21.0779 13.0605L18.9824 15.1545L17.9219 14.094L20.0174 12Z', 0.3],
        ['M19.5 15.75H22.5V17.25H19.5V15.75Z', 0.4],
      ]}
    />
  ),
  help: <HelpGlyph />,
  'context-menu': <ListMenuGlyph />,

  cell: <I d={CELL_CURSOR_PATH} />,
  crosshair: <TargetGlyph />,
  text: <TextGlyph />,
  'vertical-text': <I d={VERTICAL_TEXT_CURSOR_PATH} />,

  grab: <DragGlyph />,
  grabbing: <I d={GRABBING_CURSOR_PATH} />,
  alias: <LinkGlyph />,
  copy: <CopyGlyph />,
  move: <MoveGlyph />,

  'zoom-in': <SearchGlyph />,
  'zoom-out': <I d={ZOOM_OUT_CURSOR_PATH} />,

  'col-resize': <I d={COLUMN_RESIZE_CURSOR_PATH} />,
  'row-resize': <I d={ROW_RESIZE_CURSOR_PATH} />,
  'nesw-resize': <ExpandGlyph />,
  'nwse-resize': <I d={NWSE_RESIZE_CURSOR_PATH} />,
  'ew-resize': <I d="M16.5 13.5V18L22.5 12L16.5 6V10.5H7.5V6L1.5 12L7.5 18V13.5H16.5Z" />,
  'ns-resize': <I d="M13.5 7.5H18L12 1.5L6 7.5H10.5V16.5H6L12 22.5L18 16.5H13.5V7.5Z" />,
  'n-resize': <ArrowUpGlyph />,
  'w-resize': <ArrowLeftGlyph />,
  's-resize': <ArrowDownGlyph />,
  'e-resize': <ArrowRightGlyph />,
  'nw-resize': <I d={NW_RESIZE_CURSOR_PATH} />,
  'ne-resize': <I d="M21 3H9.72039L13.8087 7.08827L1.5 19.3969L4.6031 22.5L16.9117 10.1913L21 14.2796V3Z" />,
  'sw-resize': <I d={SW_RESIZE_CURSOR_PATH} />,
  'se-resize': <I d={SE_RESIZE_CURSOR_PATH} />,
};

// No Central v1.35 glyph exists for these keywords, so they keep their hand-drawn paths:
// auto, default (plain arrow), progress (arrow with spinner), cell, vertical-text, grabbing
// (closed hand), zoom-out (magnifier with minus), col-resize, row-resize, ew-resize,
// ns-resize, nwse-resize, nw-/ne-/sw-/se-resize.
