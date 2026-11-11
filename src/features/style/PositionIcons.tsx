import { centralIcon } from '../../ui/central/CentralIcon';
import { close as centralClose } from '../../ui/central/centralGeometry';
// The position section's glyphs, drawn after Webflow's: the position modes,
// float and clear (PositionSection.tsx).

// ─────────────────────────── Icons (from Webflow) ───────────────────────────

export const CLOSE_ICON_PATH =
  'M8.70708 8.00004L12.3535 4.35359L11.6464 3.64648L7.99998 7.29293L4.35353 3.64648' +
  'L3.64642 4.35359L7.29287 8.00004L3.64642 11.6465L4.35353 12.3536L7.99998 8.70714' +
  'L11.6464 12.3536L12.3535 11.6465L8.70708 8.00004Z';

export const CloseIcon = centralIcon(centralClose);
export const RELATIVE_ICON_PATH =
  'M11 2H9V3H11V8H12V3H14V2H11ZM3 9H2V14H3V12H8V11H3V9ZM14 10C14 9.44772 13.5523 9 13 9H10' +
  'C9.44772 9 9 9.44772 9 10V13C9 13.5523 9.44772 14 10 14H13C13.5523 14 14 13.5523 14 13V10Z';

export function RelativeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={RELATIVE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
export const ABSOLUTE_ICON_SECOND_PATH =
  'M11 2H9V3H11V8H12V3H14V2H11ZM3 9H2V14H3V12H8V11H3V9ZM14 10C14 9.44772 13.5523 9 13 9H10' +
  'C9.44772 9 9 9.44772 9 10V13C9 13.5523 9.44772 14 10 14H13C13.5523 14 14 13.5523 14 13V10Z';

export function AbsoluteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M8 3V2H3C2.44772 2 2 2.44772 2 3V8H3V3H8Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={ABSOLUTE_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
export const FIXED_ICON_FIRST_PATH =
  'M11 2H9V3H11V8H12V3H14V2H11ZM3 9H2V14H3V12H8V11H3V9ZM14 10C14 9.44772 13.5523 9 13 9H10' +
  'C9.44772 9 9 9.44772 9 10V13C9 13.5523 9.44772 14 10 14H13C13.5523 14 14 13.5523 14 13V10Z';
export const FIXED_ICON_THIRD_PATH =
  'M5.5 4.75C5.5 5.16421 5.16421 5.5 4.75 5.5C4.33579 5.5 4 5.16421 4 4.75' + 'C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75Z';
export const FIXED_ICON_FOURTH_PATH =
  'M7.25 5.5C7.66421 5.5 8 5.16421 8 4.75C8 4.33579 7.66421 4 7.25 4' + 'C6.83579 4 6.5 4.33579 6.5 4.75C6.5 5.16421 6.83579 5.5 7.25 5.5Z';

export function FixedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={FIXED_ICON_FIRST_PATH} fill="currentColor" />
      <g opacity="0.4">
        <path d="M8 3V2H3C2.44772 2 2 2.44772 2 3V8H3V3H8Z" fill="currentColor" />
        <path d={FIXED_ICON_THIRD_PATH} fill="currentColor" />
        <path d={FIXED_ICON_FOURTH_PATH} fill="currentColor" />
      </g>
    </svg>
  );
}
export const STICKY_ICON_FIRST_PATH = 'M8 3H3L3 13H13V8H14V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3' + 'C2 2.44772 2.44772 2 3 2H8V3Z';
export const STICKY_ICON_SECOND_PATH =
  'M8 4.75C8 5.16421 7.66421 5.5 7.25 5.5C6.83579 5.5 6.5 5.16421 6.5 4.75' + 'C6.5 4.33579 6.83579 4 7.25 4C7.66421 4 8 4.33579 8 4.75Z';
export const STICKY_ICON_THIRD_PATH =
  'M4.75 5.5C5.16421 5.5 5.5 5.16421 5.5 4.75C5.5 4.33579 5.16421 4 4.75 4' + 'C4.33579 4 4 4.33579 4 4.75C4 5.16421 4.33579 5.5 4.75 5.5Z';
export const STICKY_ICON_FOURTH_PATH =
  'M12 6.5C13.3807 6.5 14.5 5.38071 14.5 4C14.5 2.61929 13.3807 1.5 12 1.5' +
  'C10.6193 1.5 9.5 2.61929 9.5 4C9.5 4.50954 9.65244 4.98348 9.9142 5.3787L6.14645 9.14645' +
  'C5.95118 9.34171 5.95118 9.65829 6.14645 9.85355' +
  'C6.34171 10.0488 6.65829 10.0488 6.85355 9.85355L10.6213 6.0858' +
  'C11.0165 6.34756 11.4905 6.5 12 6.5Z';

export function StickyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g opacity="0.4">
        <path d={STICKY_ICON_FIRST_PATH} fill="currentColor" />
        <path d={STICKY_ICON_SECOND_PATH} fill="currentColor" />
        <path d={STICKY_ICON_THIRD_PATH} fill="currentColor" />
      </g>
      <path d={STICKY_ICON_FOURTH_PATH} fill="currentColor" />
    </svg>
  );
}
export const FLOAT_LEFT_ICON_FIRST_PATH =
  'M0.5 4C0.223858 4 0 4.22386 0 4.5V10.5C0 10.7761 0.223858 11 0.5 11H6.5' + 'C6.77614 11 7 10.7761 7 10.5V4.5C7 4.22386 6.77614 4 6.5 4H0.5Z';

export function FloatLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={FLOAT_LEFT_ICON_FIRST_PATH} fill="currentColor" />
      <path d="M9 5H16V4H9V5Z" fill="currentColor" />
      <path d="M16 8H9V7H16V8Z" fill="currentColor" />
      <path d="M9 11H12.5V10H9V11Z" fill="currentColor" />
    </svg>
  );
}
export const FLOAT_RIGHT_ICON_SECOND_PATH =
  'M9.5 4C9.22386 4 9 4.22386 9 4.5V10.5C9 10.7761 9.22386 11 9.5 11H15.5' + 'C15.7761 11 16 10.7761 16 10.5V4.5C16 4.22386 15.7761 4 15.5 4H9.5Z';

export function FloatRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M0 5H7V4H0V5Z" fill="currentColor" />
      <path d={FLOAT_RIGHT_ICON_SECOND_PATH} fill="currentColor" />
      <path d="M7 8H0V7H7V8Z" fill="currentColor" />
      <path d="M0 11H3.5V10H0V11Z" fill="currentColor" />
    </svg>
  );
}
export const CLEAR_LEFT_ICON_FIRST_PATH =
  'M2 2.5C2 2.22386 2.22386 2 2.5 2H5.5C5.77614 2 6 2.22386 6 2.5V4.5' + 'C6 4.77614 5.77614 5 5.5 5H2.5C2.22386 5 2 4.77614 2 4.5V2.5Z';
export const CLEAR_LEFT_ICON_SECOND_PATH =
  'M7.00008 2.5C7.00008 2.22386 7.22393 2 7.50008 2H13.5001' +
  'C13.7762 2 14.0001 2.22386 14.0001 2.5V4.5C14.0001 4.77614 13.7762 5 13.5001 5H7.50008' +
  'C7.22393 5 7.00008 4.77614 7.00008 4.5V2.5Z';
export const CLEAR_LEFT_ICON_THIRD_PATH = 'M5.20718 10.5L7.35363 8.35355L6.64652 7.64645L3.79297 10.5L6.64652 13.3536L7.35363 12.6464' + 'L5.20718 10.5Z';
export const CLEAR_LEFT_ICON_FOURTH_PATH =
  'M10.0001 6V8.5C10.0001 9.32843 9.3285 10 8.50008 10H4.50008V11H8.50008' + 'C9.88079 11 11.0001 9.88071 11.0001 8.5V6H10.0001Z';

export function ClearLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.3" d={CLEAR_LEFT_ICON_FIRST_PATH} fill="currentColor" />
      <path d={CLEAR_LEFT_ICON_SECOND_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={CLEAR_LEFT_ICON_THIRD_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={CLEAR_LEFT_ICON_FOURTH_PATH} fill="currentColor" />
    </svg>
  );
}
export const CLEAR_RIGHT_ICON_FIRST_PATH =
  'M10 2.5C10 2.22386 10.2239 2 10.5 2H13.5C13.7761 2 14 2.22386 14 2.5V4.5' + 'C14 4.77614 13.7761 5 13.5 5H10.5C10.2239 5 10 4.77614 10 4.5V2.5Z';
export const CLEAR_RIGHT_ICON_SECOND_PATH =
  'M2 2.5C2 2.22386 2.22386 2 2.5 2H8.5C8.77614 2 9 2.22386 9 2.5V4.5' + 'C9 4.77614 8.77614 5 8.5 5H2.5C2.22386 5 2 4.77614 2 4.5V2.5Z';
export const CLEAR_RIGHT_ICON_THIRD_PATH = 'M10.7929 10.5L8.64645 8.35355L9.35355 7.64645L12.2071 10.5L9.35355 13.3536L8.64645 12.6464' + 'L10.7929 10.5Z';

export function ClearRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.3" d={CLEAR_RIGHT_ICON_FIRST_PATH} fill="currentColor" />
      <path d={CLEAR_RIGHT_ICON_SECOND_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={CLEAR_RIGHT_ICON_THIRD_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M6 6V8.5C6 9.32843 6.67157 10 7.5 10H11.5V11H7.5C6.11929 11 5 9.88071 5 8.5V6H6Z" fill="currentColor" />
    </svg>
  );
}
export const CLEAR_BOTH_ICON_FIRST_PATH =
  'M3.00011 2.5C3.00011 2.22386 3.22397 2 3.50011 2H13.5001' +
  'C13.7763 2 14.0001 2.22386 14.0001 2.5V4.5C14.0001 4.77614 13.7763 5 13.5001 5H3.50011' +
  'C3.22397 5 3.00011 4.77614 3.00011 4.5V2.5Z';
export const CLEAR_BOTH_ICON_SECOND_PATH =
  'M3.70716 10L5.35363 8.35353L4.64652 7.64642L1.79297 10.5L4.64652 13.3535L5.35363 12.6464' +
  'L3.70721 11H6.50011C7.31791 11 8.044 10.6073 8.50011 10.0002' +
  'C8.95623 10.6073 9.68231 11 10.5001 11H13.293L11.6466 12.6464L12.3537 13.3535L15.2073 10.5' +
  'L12.3537 7.64642L11.6466 8.35353L13.2931 10H10.5001C9.67169 10 9.00011 9.32843 9.00011 8.5' +
  'V6H8.00011V8.5C8.00011 9.32843 7.32854 10 6.50011 10H3.70716Z';

export function ClearBothIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={CLEAR_BOTH_ICON_FIRST_PATH} fill="currentColor" />
      <path d={CLEAR_BOTH_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
