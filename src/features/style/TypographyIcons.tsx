import { centralIcon } from '../../ui/central/CentralIcon';
import {
  alignCenter as centralAlignCenter,
  alignJustify as centralAlignJustify,
  alignLeft as centralAlignLeft,
  alignRight as centralAlignRight,
  clearFormat as centralClearFormat,
  italic as centralItalic,
  strike as centralStrike,
  text as centralText,
  underline as centralUnderline,
} from '../../ui/central/centralGeometry';
// The typography section's glyphs: alignment, decoration, font style,
// capitalization and direction (TypographySection.tsx).

// ─────────────────────────── Icons ───────────────────────────

export const AlignLeftIcon = centralIcon(centralAlignLeft);
export const AlignCenterIcon = centralIcon(centralAlignCenter);
export const AlignRightIcon = centralIcon(centralAlignRight);
export const AlignJustifyIcon = centralIcon(centralAlignJustify);
export const DecorNoneIcon = centralIcon(centralClearFormat);
export const DecorStrikeIcon = centralIcon(centralStrike);
export const DecorUnderlineIcon = centralIcon(centralUnderline);
export function DecorOverlineIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 1V2H14V1H3Z" fill="currentColor" />
      <path d="M5 5H8V12H9V5H12V4H5V5Z" fill="currentColor" />
    </svg>
  );
}
// Italicize (font-style)
export const FontStyleRegularIcon = centralIcon(centralText);
export const FontStyleItalicIcon = centralIcon(centralItalic);
export const TRANSFORM_CAPS_ICON_PATH =
  'M4.12583 4H5.87413L8.00003 11.2279L10.1258 4H11.8741L14.2271 12H13.1848' +
  'L12.5965 9.99994H9.40354L8.8153 12H7.18477L6.5965 9.99994H3.40354L2.8153 12' +
  'H1.77295L4.12583 4ZM6.30238 8.99994L5.12587 4.9999H4.8741L3.69765 8.99994' +
  'H6.30238ZM12.3024 8.99994L11.1259 4.9999H10.8741L9.69765 8.99994H12.3024Z';

// Capitalize (text-transform)
export function TransformCapsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={TRANSFORM_CAPS_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
export const TRANSFORM_CAPITALIZE_UPPER_PATH =
  'M4.12583 4H5.87413L8.22713 12H7.18477L6.5965 9.99994H3.40354L2.8153 12H1.77295' +
  'L4.12583 4ZM6.30238 8.99994L5.12587 4.9999H4.8741L3.69765 8.99994H6.30238Z';
export const TRANSFORM_CAPITALIZE_LOWER_PATH =
  'M12.5 7H10V6H12.5C13.3284 6 14 6.67157 14 7.5V12H13V11.2909C12.4911 ' +
  '11.7327 11.8268 12 11.1 12H11C9.89543 12 9 11.1046 9 10C9 8.89543 9.89543 8 11 8' +
  'H13V7.5C13 7.22386 12.7761 7 12.5 7ZM13 9V9.1C13 10.1493 12.1493 11 11.1 11' +
  'H11C10.4477 11 10 10.5523 10 10C10 9.44772 10.4477 9 11 9H13Z';

export function TransformCapitalizeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={TRANSFORM_CAPITALIZE_UPPER_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={TRANSFORM_CAPITALIZE_LOWER_PATH} fill="currentColor" />
    </svg>
  );
}
export const TRANSFORM_LOWERCASE_LEFT_PATH =
  'M4 7H6.5C6.77614 7 7 7.22386 7 7.5V8H5C3.89543 8 3 8.89543 3 10C3 11.1046 3.89543 12 5 12' +
  'H5.1C5.82677 12 6.49109 11.7327 7 11.2909V12H8V7.5C8 6.67157 7.32843 6 6.5 6H4V7ZM5 9' +
  'H7V9.1C7 10.1493 6.14934 11 5.1 11H5C4.44772 11 4 10.5523 4 10C4 9.44772 4.44772 9 5 9Z';
export const TRANSFORM_LOWERCASE_RIGHT_PATH =
  'M10 7H12.5C12.7761 7 13 7.22386 13 7.5V8H11C9.89543 8 9 8.89543 9 10' +
  'C9 11.1046 9.89543 12 11 12H11.1C11.8268 12 12.4911 11.7327 13 11.2909V12' +
  'H14V7.5C14 6.67157 13.3284 6 12.5 6H10V7ZM11 9H13V9.1C13 10.1493 12.1493 ' +
  '11 11.1 11H11C10.4477 11 10 10.5523 10 10C10 9.44772 10.4477 9 11 9Z';

export function TransformLowercaseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={TRANSFORM_LOWERCASE_LEFT_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={TRANSFORM_LOWERCASE_RIGHT_PATH} fill="currentColor" />
    </svg>
  );
}
export const DIRECTION_LTR_ARROW_PATH =
  'M5 12L12.3111 12L10.6484 10.3555L11.3516 9.64453L14.2071 12.4688' + 'L11.3555 15.3516L10.6445 14.6484L12.2751 13L5 13L5 12Z';
export const DIRECTION_LTR_MARK_PATH =
  'M4.23463 2.15224C4.47728 2.05173 4.73736 2 5 2L5 6C4.73736 6 4.47728 5.94827 ' +
  '4.23463 5.84776C3.99198 5.74725 3.7715 5.59993 3.58579 5.41421C3.40007 5.2285 ' +
  '3.25275 5.00802 3.15224 4.76537C3.05173 4.52272 3 4.26264 3 4C3 3.73736 3.05173 ' +
  '3.47728 3.15224 3.23463C3.25275 2.99198 3.40007 2.7715 3.58579 2.58579' +
  'C3.7715 2.40007 3.99198 2.25275 4.23463 2.15224ZM5 6L5 2H11V3H9V10H8V3H6V10H5L5 6Z';

// Direction icons.
export function DirectionLTRIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={DIRECTION_LTR_ARROW_PATH} fill="currentColor" />
      <path opacity="0.6" fillRule="evenodd" clipRule="evenodd" d={DIRECTION_LTR_MARK_PATH} fill="currentColor" />
    </svg>
  );
}
export const DIRECTION_RTL_ARROW_PATH =
  'M11.0001 12L3.689 12L5.35169 10.3555L4.64848 9.64453L1.79297 12.4688' + 'L4.64462 15.3516L5.35556 14.6484L3.72502 13L11.0001 13V12Z';
export const DIRECTION_RTL_MARK_PATH =
  'M6.23463 2.15224C6.47728 2.05173 6.73736 2 7 2L7 6C6.73736 6 6.47728 5.94827 ' +
  '6.23463 5.84776C5.99198 5.74725 5.7715 5.59993 5.58579 5.41421C5.40007 5.2285 ' +
  '5.25275 5.00802 5.15224 4.76537C5.05173 4.52272 5 4.26264 5 4C5 3.73736 5.05173 ' +
  '3.47728 5.15224 3.23463C5.25275 2.99198 5.40007 2.7715 5.58579 2.58579' +
  'C5.7715 2.40007 5.99198 2.25275 6.23463 2.15224ZM7 6L7 2H13V3H11V10H10V3H8V10H7L7 6Z';

export function DirectionRTLIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={DIRECTION_RTL_ARROW_PATH} fill="currentColor" />
      <path opacity="0.6" fillRule="evenodd" clipRule="evenodd" d={DIRECTION_RTL_MARK_PATH} fill="currentColor" />
    </svg>
  );
}
