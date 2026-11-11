import { centralIcon } from '../../ui/central/CentralIcon';
import { lock as centralLock, unlock as centralUnlock } from '../../ui/central/centralGeometry';
import type { ReactNode } from 'react';
import type { TransformType } from './model/transform';

// Webflow's transform axis glyphs (the tiny x/y/z is baked into each icon), shown in
// the label slot of each axis row in the transform editor. Move, Scale and Skew reuse
// the translate arrows; Rotate has its own curved-arrow set. Skew is 2D (X/Y only).

const TRANSLATE_X_GUIDE_PATH = 'M7.00004 10.2929V4H8.00004V10H13.5V11H7.70714' + 'L3.85359 14.8536L3.14648 14.1464L7.00004 10.2929Z';
const TRANSLATE_X_LETTER_PATH = 'M3.5 2.667L2.25 1H1L2.875 3.5L1 6H2.25L3.5 4.333L4.75 6H6L4.125 3.5L6 1H4.75L3.5 2.667Z';
const TRANSLATE_X_ARROW_PATH = 'M13.2929 11H7V10H13.2929L11.6464 8.35355L12.3536 7.64645' + 'L15.2071 10.5L12.3536 13.3536L11.6464 12.6464L13.2929 11Z';

const TranslateX = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <g>
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={TRANSLATE_X_GUIDE_PATH} fill="currentColor" />
      <g>
        <path d={TRANSLATE_X_LETTER_PATH} fill="currentColor" />
        <path d={TRANSLATE_X_ARROW_PATH} fill="currentColor" />
      </g>
    </g>
  </svg>
);
const TRANSLATE_Y_GUIDE_PATH = 'M8.00004 8.70711V15H9.00004V9H15V8H8.70714' + 'L5.85359 5.14645L5.14648 5.85355L8.00004 8.70711Z';
const TRANSLATE_Y_ARROW_PATH = 'M9 14.043L10.6465 12.3965L11.3535 13.1035L8.5 15.957' + 'L5.64648 13.1035L6.35352 12.3965L8 14.043V8H9V14.043Z';

const TranslateY = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <g>
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={TRANSLATE_Y_GUIDE_PATH} fill="currentColor" />
      <g>
        <path d={TRANSLATE_Y_ARROW_PATH} fill="currentColor" />
        <path d="M3.5 2.49414L4.75293 1H6L4 3.5V6H3V3.5L1 1H2.25L3.5 2.49414Z" fill="currentColor" />
      </g>
    </g>
  </svg>
);
const TRANSLATE_Z_GUIDE_PATH = 'M7.99998 10.2929V4H8.99998V10H15V11H8.70708' + 'L4.85353 14.8536L4.14642 14.1464L7.99998 10.2929Z';

const TranslateZ = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <g>
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={TRANSLATE_Z_GUIDE_PATH} fill="currentColor" />
      <g>
        <path d="M4.29289 2H1V1H6V1.70711L2.70711 5H6V6H1V5.29289L4.29289 2Z" fill="currentColor" />
        <path d="M9.35355 10.3536L5.70711 14H8V15H4V11H5V13.2929L8.64645 9.64648L9.35355 10.3536Z" fill="currentColor" />
      </g>
    </g>
  </svg>
);
const ROTATE_X_ICON_PATH =
  'M2.25 1L3.5 2.667L4.75 1H6L4.125 3.5L6 6H4.75L3.5 4.333L2.25 6H1L2.875 3.5L1 1H2.25' +
  'ZM14 9.5C14 8.0585 13.709 6.72874 13.215 5.74086C12.736 4.78288 11.9818 4 11 4C10.2342 ' +
  '4 9.60688 4.47634 9.14061 5.14056L9.86132 5.86127C10.2418 5.2491 10.6568 5 11 5' +
  'C11.399 5 11.8948 5.3364 12.3206 6.18807C12.7315 7.00984 13 8.18008 13 9.5C13 10.8199 ' +
  '12.7315 11.9902 12.3206 12.8119C11.8948 13.6636 11.399 14 11 14C10.6011 14 10.1053 ' +
  '13.6636 9.67949 12.8119C9.26861 11.9902 9.00005 10.8199 9.00005 9.5C9.00005 9.23948 ' +
  '9.01051 8.98479 9.03046 8.73746L10.6465 10.3535L11.3536 9.64638L8.85359 7.14638L8.50004 ' +
  '6.79282L8.14648 7.14638L5.64648 9.64638L6.35359 10.3535L8.03232 8.67476C8.01102 8.9445 ' +
  '8.00005 9.22015 8.00005 9.5C8.00005 10.9415 8.29113 12.2713 ' +
  '8.78507 13.2591C9.26405 14.2171 10.0183 15 11 15C11.9818 15 ' +
  '12.736 14.2171 13.215 13.2591C13.709 12.2713 14 10.9415 14 9.5Z';

const RotateX = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d={ROTATE_X_ICON_PATH} fill="currentColor" />
  </svg>
);
const ROTATE_Y_ICON_PATH =
  'M3.5 2.494L4.753 1H6L4 3.5V6H3V3.5L1 1H2.25L3.5 2.494ZM10.2625 11.9696L8.64645 10.3536' +
  'L9.35355 9.64645L11.8536 12.1464L12.2071 12.5L11.8536 12.8536L9.35355 15.3536L8.64645 ' +
  '14.6464L10.3252 12.9677C10.0554 12.989 9.77982 13 9.5 13C8.0585 13 6.72874 ' +
  '12.7089 5.74086 12.215C4.78288 11.736 4 10.9818 4 10C4 9.01823 4.78288 8.26401 ' +
  '5.74086 7.78502C6.72874 7.29108 8.0585 7 9.5 7C10.9415 7 12.2713 7.29108 13.2591 7.78502' +
  'C14.2171 8.26401 15 9.01823 15 10C15 10.7658 14.5237 11.3932 13.8594 11.8594' +
  'L13.1387 11.1387C13.7509 10.7583 14 10.3433 14 10C14 9.60106 13.6636 9.10528 ' +
  '12.8119 8.67945C11.9902 8.26857 10.8199 8 9.5 8C8.18008 8 7.00984 8.26857 6.18807 8.67945' +
  'C5.3364 9.10528 5 9.60106 5 10C5 10.3989 5.3364 10.8947 6.18807 11.3206' +
  'C7.00984 11.7314 8.18008 12 9.5 12C9.7605 12 10.0152 11.9895 10.2625 11.9696Z';

const RotateY = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d={ROTATE_Y_ICON_PATH} fill="currentColor" />
  </svg>
);
const ROTATE_Z_ICON_PATH =
  'M1 2H4.29289L1.14645 5.14645L1 5.29289V6H1.5H6V5H2.70711L5.85355 1.85355L6 1.70711' +
  'V1H5.5H1V2ZM11.2929 6H10.5C8.01472 6 6 8.01472 6 10.5C6 12.9853 8.01472 15 10.5 15' +
  'C12.9853 15 15 12.9853 15 10.5H14C14 12.433 12.433 14 10.5 14C8.567 14 7 12.433 7 10.5' +
  'C7 8.567 8.567 7 10.5 7H11.2929L9.64645 8.64645L10.3536 9.35355L12.8536 6.85355' +
  'L13.2071 6.5L12.8536 6.14645L10.3536 3.64645L9.64645 4.35355L11.2929 6Z';

const RotateZ = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d={ROTATE_Z_ICON_PATH} fill="currentColor" />
  </svg>
);

const TRANSLATE: Record<'x' | 'y' | 'z', ReactNode> = {
  x: TranslateX,
  y: TranslateY,
  z: TranslateZ,
};
const ROTATE: Record<'x' | 'y' | 'z', ReactNode> = { x: RotateX, y: RotateY, z: RotateZ };

/** The Webflow glyph for a transform axis, chosen by type (Rotate is curved). */
export function transformAxisIcon(type: TransformType, axis: 'x' | 'y' | 'z'): ReactNode {
  return type === 'rotate' ? ROTATE[axis] : TRANSLATE[axis];
}

const MOVE_TYPE_ICON_PATH =
  'M11.3535 3.64648L10.6465 4.35352L9 2.70703V7H13.293L11.6465 5.35352L12.3535 4.64648' +
  'L15.207 7.5L12.3535 10.3535L11.6465 9.64648L13.293 8H9V12.293L10.6465 10.6465' +
  'L11.3535 11.3535L8.5 14.207L5.64648 11.3535L6.35352 10.6465L8 12.293V8H3.70703' +
  'L5.35352 9.64648L4.64648 10.3535L1.79297 7.5L4.64648 4.64648L5.35352 5.35352' +
  'L3.70703 7H8V2.70703L6.35352 4.35352L5.64648 3.64648L8.5 0.792969L11.3535 3.64648Z';
const ROTATE_TYPE_CURVE_PATH =
  'M8.3536 2.35359L6.20715 4.50004H10C12.2092 4.50004 14 6.2909 14 8.50004' +
  'C14 10.7092 12.2092 12.5 10 12.5H9.00005V11.5H10C11.6569 11.5 13 10.1569 ' +
  '13 8.50004C13 6.84318 11.6569 5.50004 10 5.50004H6.20715L8.3536 7.64648' +
  'L7.64649 8.35359L4.29294 5.00004L7.64649 1.64648L8.3536 2.35359Z';
const ROTATE_TYPE_ARROWHEAD_PATH =
  'M5.3536 13.6465L7.64649 11.3536C7.84175 11.1583 7.84175 10.8417 7.64649 10.6465' +
  'L5.3536 8.35359C5.15834 8.15833 4.84176 8.15833 4.64649 8.35359' +
  'L2.3536 10.6465C2.15834 10.8417 2.15834 11.1583 2.3536 11.3536' +
  'L4.64649 13.6465C4.84176 13.8417 5.15834 13.8417 5.3536 13.6465Z';
const SKEW_TYPE_OUTLINE_PATH =
  'M6.11801 4L2.11801 12H9.88194L13.8819 4H6.11801ZM5.80899 3C5.61961 3 5.44648 3.107 ' +
  '5.36178 3.27639L0.861781 12.2764C0.695556 12.6088 0.937304 13 1.309 13H10.191C10.3803 13 ' +
  '10.5535 12.893 10.6382 12.7236L15.1382 3.72361C15.3044 3.39116 15.0627 3 14.691 3H5.80899Z';
const SKEW_TYPE_TOP_EDGE_PATH = 'M4.99998 4H11C11 3.44771 10.5523 3 10 3H5.80899' + 'C5.61961 3 5.44648 3.107 5.36178 3.27639L4.99998 4Z';

// The per-type glyph shown on each collapsed layer row (Move / Scale / Rotate / Skew).
const TYPE_ICONS: Record<TransformType, ReactNode> = {
  move: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={MOVE_TYPE_ICON_PATH} fill="currentColor" />
    </svg>
  ),
  scale: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 3.70711L3.70711 13H7V14H2V9H3V12.2929L12.2929 3H9V2H14V7H13V3.70711Z" fill="currentColor" />
      <g opacity="0.4">
        <path d="M8 2H3C2.44772 2 2 2.44772 2 3V8H3V3H8V2Z" fill="currentColor" />
        <path d="M8 13H13V8H14V13C14 13.5523 13.5523 14 13 14H8V13Z" fill="currentColor" />
      </g>
    </svg>
  ),
  rotate: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g>
        <path d={ROTATE_TYPE_CURVE_PATH} fill="currentColor" />
        <path d={ROTATE_TYPE_ARROWHEAD_PATH} fill="currentColor" />
      </g>
    </svg>
  ),
  skew: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g>
        <path fillRule="evenodd" clipRule="evenodd" d={SKEW_TYPE_OUTLINE_PATH} fill="currentColor" />
        <g opacity="0.4">
          <path d="M2 7.76389L1 9.76389V4C1 3.44772 1.44772 3 2 3H4.38194L3.88194 4H2V7.76389Z" fill="currentColor" />
          <path d={SKEW_TYPE_TOP_EDGE_PATH} fill="currentColor" />
          <path d="M11 5V7.52782L10 9.52782V5H11Z" fill="currentColor" />
          <path d="M10.8819 10L11 9.76389V10H10.8819Z" fill="currentColor" />
        </g>
      </g>
    </svg>
  ),
};

/** The Webflow glyph for a transform layer type (collapsed row preview). */
export function transformTypeIcon(type: TransformType): ReactNode {
  return TYPE_ICONS[type];
}

/** Padlock — locked (X & Y linked). */
export const LockIcon = centralIcon(centralLock);
/** Open padlock — unlocked (X & Y independent). */
export const UnlockIcon = centralIcon(centralUnlock);
