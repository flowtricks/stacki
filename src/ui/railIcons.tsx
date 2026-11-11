// The left rail's alternative icon sets, compared through Settings → Editor →
// Rail icons (src/app/railIconSet.ts). Stacki's own set stays in Icons.tsx and
// the feature mapping (src/app/featureIcons.tsx) picks between all three.
//
// Phosphor: the paths below are copied from Phosphor Icons 2.1.1, Regular weight,
// MIT licence, Copyright (c) 2023 Phosphor Icons — https://phosphoricons.com/,
// source https://github.com/phosphor-icons/core (assets/regular/*.svg). They are
// vendored paths, not a package (docs/dependencies.md). Regular rather than Light:
// at the rail's 20px, Light's 12/256 stroke is under 1px and reads faint beside
// Stacki's other icons; Regular's 16/256 stroke is 1.25px.
//
// Phosphor has no icon for Variables (a card fanned out from a swatch) or for
// Style selectors (three drops), so those two are drawn here in its style: a 256
// grid, a 16-unit stroke, round caps and joins, 16-unit corner radii and 12-unit dots.
//
// Custom: a hand-drawn set on a 20-unit grid with a 1.25-unit stroke, so at the
// rail's 20px every icon has the same 1.25px outline, round caps and joins,
// generous corner radii and no fills except dots.
import type { ComponentType, ReactNode } from 'react';
import type { IconProps } from './IconBase';
import { assert } from '../../shared/core/assert';

/** The rail's buttons, each of which every set draws. */
export const RAIL_ICON_KEYS = [
  'pages',
  'navigator',
  'properties',
  'components',
  'assets',
  'cms',
  'variables',
  'selectors',
  'code',
  'history',
  'apps',
  'ai',
  'instructions',
  'audits',
  'more',
] as const;
export type RailIconKey = (typeof RAIL_ICON_KEYS)[number];
export type RailIconComponent = ComponentType<Pick<IconProps, 'size'>>;
export type RailIconMap = Readonly<Record<RailIconKey, RailIconComponent>>;

const RAIL_ICON_SIZE_DEFAULT = 20;

// A drop with its tip at the top: a circle of radius `radius` and the two lines
// tangent to it from a tip 1.6 radii above its centre. The tangent points sit
// where cos α = 1 / 1.6, so the sides meet the curve without a kink.
const DROP_TIP_RADII = 1.6;
const DROP_TANGENT_SIN = Math.sqrt(1 - (1 / DROP_TIP_RADII) ** 2);
const DROP_TANGENT_COS = 1 / DROP_TIP_RADII;
function dropPath(cx: number, cy: number, radius: number): string {
  assert(radius > 0, 'A drop has a positive radius');
  assert(cy - radius * DROP_TIP_RADII >= 0, "A drop's tip stays inside its grid");
  const tangentX = round(radius * DROP_TANGENT_SIN);
  const tangentY = round(radius * DROP_TANGENT_COS);
  const tipY = round(cy - radius * DROP_TIP_RADII);
  return `M${cx} ${tipY}L${round(cx + tangentX)} ${round(cy - tangentY)}A${radius} ${radius} 0 1 1 ${round(cx - tangentX)} ${round(cy - tangentY)}Z`;
}
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---- Phosphor (Regular) ----

function PhosphorFill(props: { readonly size: number | undefined; readonly path: string }) {
  const size = props.size ?? RAIL_ICON_SIZE_DEFAULT;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      style={{ display: 'block', flexShrink: 0, pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <path d={props.path} />
    </svg>
  );
}

// The two Phosphor-style icons are drawn as strokes, as Phosphor's own sources are
// before they are expanded to the fills above; at 16 units the two render alike.
function PhosphorStroke(props: { readonly size: number | undefined; readonly children: ReactNode }) {
  const size = props.size ?? RAIL_ICON_SIZE_DEFAULT;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={16}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0, pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

const PHOSPHOR_PATHS = {
  file:
    'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34Z' +
    'M160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z',
  listBullets:
    'M80,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H88A8,8,0,0,1,80,64Zm136,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z' +
    'M44,52A12,12,0,1,0,56,64,12,12,0,0,0,44,52Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,180Z',
  slidersHorizontal:
    'M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Zm64-24A16,16,0,1,1,88,80,16,16,0,0,1,104,64Z' +
    'M216,168H199a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16h97a32,32,0,0,0,62,0h17a8,8,0,0,0,0-16Zm-48,24a16,16,0,1,1,16-16A16,16,0,0,1,168,192Z',
  cube:
    'M223.68,66.15,135.68,18h0a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0' +
    'l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32h0l80.34,44L128,120,47.66,76ZM40,90l80,43.78v85.79L40,175.82Z' +
    'm96,129.57V133.82L216,90v85.78Z',
  image:
    'M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0' +
    'l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200Z' +
    'M144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z',
  database:
    'M128,24C74.17,24,32,48.6,32,80v96c0,31.4,42.17,56,96,56s96-24.6,96-56V80C224,48.6,181.83,24,128,24Zm80,104c0,9.62-7.88,19.43-21.61,26.92' +
    'C170.93,163.35,150.19,168,128,168s-42.93-4.65-58.39-13.08C55.88,147.43,48,137.62,48,128V111.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64Z' +
    'M69.61,53.08C85.07,44.65,105.81,40,128,40s42.93,4.65,58.39,13.08C200.12,60.57,208,70.38,208,80s-7.88,19.43-21.61,26.92' +
    'C170.93,115.35,150.19,120,128,120s-42.93-4.65-58.39-13.08C55.88,99.43,48,89.62,48,80S55.88,60.57,69.61,53.08Z' +
    'M186.39,202.92C170.93,211.35,150.19,216,128,216s-42.93-4.65-58.39-13.08C55.88,195.43,48,185.62,48,176V159.36' +
    'c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64V176C208,185.62,200.12,195.43,186.39,202.92Z',
  code:
    'M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Z' +
    'm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29Z' +
    'M162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z',
  clockCounterClockwise:
    'M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Z' +
    'm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49' +
    'c7.15-8.42,14.27-16.35,22.39-24.57a80,80,0,1,1,1.66,114.75,8,8,0,1,0-11,11.64A96,96,0,1,0,128,32Z',
  bookOpen:
    'M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72' +
    'a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88' +
    'a24,24,0,0,1,24-24h64Z',
  clipboardText:
    'M168,152a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,152Zm-8-40H96a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Z' +
    'm56-64V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V48A16,16,0,0,1,56,32H92.26a47.92,47.92,0,0,1,71.48,0H200A16,16,0,0,1,216,48Z' +
    'M96,64h64a32,32,0,0,0-64,0ZM200,48H173.25A47.93,47.93,0,0,1,176,64v8a8,8,0,0,1-8,8H88a8,8,0,0,1-8-8V64a47.93,47.93,0,0,1,2.75-16H56V216H200Z',
  sparkle:
    'M197.58,129.06,146,110l-19-51.62a15.92,15.92,0,0,0-29.88,0L78,110l-51.62,19a15.92,15.92,0,0,0,0,29.88L78,178l19,51.62a15.92,15.92,0,0,0,29.88,0' +
    'L146,178l51.62-19a15.92,15.92,0,0,0,0-29.88ZM137,164.22a8,8,0,0,0-4.74,4.74L112,223.85,91.78,169A8,8,0,0,0,87,164.22L32.15,144,87,123.78' +
    'A8,8,0,0,0,91.78,119L112,64.15,132.22,119a8,8,0,0,0,4.74,4.74L191.85,144Z' +
    'M144,40a8,8,0,0,1,8-8h16V16a8,8,0,0,1,16,0V32h16a8,8,0,0,1,0,16H184V64a8,8,0,0,1-16,0V48H152A8,8,0,0,1,144,40Z' +
    'M248,88a8,8,0,0,1-8,8h-8v8a8,8,0,0,1-16,0V96h-8a8,8,0,0,1,0-16h8V72a8,8,0,0,1,16,0v8h8A8,8,0,0,1,248,88Z',
  dotsThree: 'M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm56-12a12,12,0,1,0,12,12A12,12,0,0,0,196,116ZM60,116a12,12,0,1,0,12,12A12,12,0,0,0,60,116Z',
} as const;

const phosphor = (path: string): RailIconComponent => {
  const PhosphorIcon = (props: Pick<IconProps, 'size'>) => <PhosphorFill size={props.size} path={path} />;
  return PhosphorIcon;
};

// Apps: Phosphor's SquaresFour with its last square swapped for a plus (as in
// PlusSquare, arms 32 units from the centre). A 64-unit square stroked at 16
// with an 8-unit radius has SquaresFour's 16-unit outer and square inner corners.
const PhosphorAppsIcon = (props: Pick<IconProps, 'size'>) => (
  <PhosphorStroke size={props.size}>
    <rect x="48" y="48" width="64" height="64" rx="8" />
    <rect x="144" y="48" width="64" height="64" rx="8" />
    <rect x="48" y="144" width="64" height="64" rx="8" />
    <path d="M176 144v64M144 176h64" />
  </PhosphorStroke>
);

// Variables, in Phosphor's style: an upright card with a rounded foot and a dot,
// and behind it a second card fanned 45° about that dot. The fanned card's lower
// edge runs tangent into the foot, so the two read as one hinged swatch.
const PhosphorVariablesIcon = (props: Pick<IconProps, 'size'>) => (
  <PhosphorStroke size={props.size}>
    <path d="M128 52a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v128a40 40 0 0 1-80 0Z" />
    <path d="M128 83.43 108.6 64.04a16 16 0 0 0-22.62 0L52.04 97.98a16 16 0 0 0 0 22.62l87.68 87.68" />
    <circle cx="168" cy="180" r="12" fill="currentColor" stroke="none" />
  </PhosphorStroke>
);

// Style selectors, in Phosphor's style: three drops in a triangle, two above and one below.
const PHOSPHOR_DROPS = [dropPath(76, 89, 36), dropPath(180, 89, 36), dropPath(128, 181, 36)] as const;
const PhosphorSelectorsIcon = (props: Pick<IconProps, 'size'>) => (
  <PhosphorStroke size={props.size}>
    {PHOSPHOR_DROPS.map((path) => (
      <path key={path} d={path} />
    ))}
  </PhosphorStroke>
);

export const PHOSPHOR_RAIL_ICONS: RailIconMap = {
  pages: phosphor(PHOSPHOR_PATHS.file),
  navigator: phosphor(PHOSPHOR_PATHS.listBullets),
  properties: phosphor(PHOSPHOR_PATHS.slidersHorizontal),
  components: phosphor(PHOSPHOR_PATHS.cube),
  assets: phosphor(PHOSPHOR_PATHS.image),
  cms: phosphor(PHOSPHOR_PATHS.database),
  variables: PhosphorVariablesIcon,
  selectors: PhosphorSelectorsIcon,
  code: phosphor(PHOSPHOR_PATHS.code),
  history: phosphor(PHOSPHOR_PATHS.clockCounterClockwise),
  apps: PhosphorAppsIcon,
  ai: phosphor(PHOSPHOR_PATHS.sparkle),
  instructions: phosphor(PHOSPHOR_PATHS.bookOpen),
  audits: phosphor(PHOSPHOR_PATHS.clipboardText),
  more: phosphor(PHOSPHOR_PATHS.dotsThree),
};

// ---- Custom ----

function Custom(props: { readonly size: number | undefined; readonly children: ReactNode }) {
  const size = props.size ?? RAIL_ICON_SIZE_DEFAULT;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0, pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

// The set's one filled mark: a dot, 2 units across, a little heavier than the stroke.
const Dot = (props: { readonly cx: number; readonly cy: number }) => <circle cx={props.cx} cy={props.cy} r="1" fill="currentColor" stroke="none" />;

const custom = (children: ReactNode): RailIconComponent => {
  const CustomIcon = (props: Pick<IconProps, 'size'>) => <Custom size={props.size}>{children}</Custom>;
  return CustomIcon;
};

const CUSTOM_DROPS = [dropPath(6, 7, 2.75), dropPath(14, 7, 2.75), dropPath(10, 14.5, 2.75)] as const;

export const CUSTOM_RAIL_ICONS: RailIconMap = {
  // A page with its corner folded.
  pages: custom(
    <>
      <path d="M11.25 2.25H6A1.75 1.75 0 0 0 4.25 4v12A1.75 1.75 0 0 0 6 17.75h8A1.75 1.75 0 0 0 15.75 16V6.75Z" />
      <path d="M11.25 2.25V5.5a1.25 1.25 0 0 0 1.25 1.25h3.25" />
    </>,
  ),
  // Stacki's own Navigator, restyled: a line, then two lines stepped in a level.
  navigator: custom(<path d="M2.5 5.5h12M6 10h11.5M6 14.5h11.5" />),
  // Two sliders: the component's properties.
  properties: custom(
    <>
      <path d="M3 6.5h4.5M11.5 6.5H17" />
      <circle cx="9.5" cy="6.5" r="2" />
      <path d="M3 13.5h8.5M15.5 13.5H17" />
      <circle cx="13.5" cy="13.5" r="2" />
    </>,
  ),
  components: custom(
    <>
      <path d="M10 2.5 16.5 6.25v7.5L10 17.5 3.5 13.75v-7.5Z" />
      <path d="M3.5 6.25 10 10l6.5-3.75M10 10v7.5" />
    </>,
  ),
  // A picture frame: a hill, a smaller hill behind it and the sun.
  assets: custom(
    <>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
      <path d="m3 14 4.3-4.3a1 1 0 0 1 1.4 0l5.8 5.8" />
      <path d="m11.75 12.75 1.55-1.55a1 1 0 0 1 1.4 0l2.3 2.3" />
      <circle cx="13" cy="7.5" r="1.5" />
    </>,
  ),
  cms: custom(
    <>
      <ellipse cx="10" cy="5" rx="6.25" ry="2.5" />
      <path d="M3.75 5v10c0 1.38 2.8 2.5 6.25 2.5s6.25-1.12 6.25-2.5V5" />
      <path d="M3.75 10c0 1.38 2.8 2.5 6.25 2.5s6.25-1.12 6.25-2.5" />
    </>,
  ),
  // The Phosphor-style Variables icon on this grid: an upright card with a dot,
  // and a card fanned 45° behind it about that dot, its lower edge tangent to the foot.
  variables: custom(
    <>
      <path d="M9.75 4.75a2 2 0 0 1 2-2h2.5a2 2 0 0 1 2 2V14a3.25 3.25 0 0 1-6.5 0Z" />
      <path d="M9.75 6.15 8.76 5.16a1.75 1.75 0 0 0-2.48 0L4.16 7.28a1.75 1.75 0 0 0 0 2.48l6.54 6.54" />
      <Dot cx={13} cy={14} />
    </>,
  ),
  selectors: custom(
    <>
      {CUSTOM_DROPS.map((path) => (
        <path key={path} d={path} />
      ))}
    </>,
  ),
  code: custom(<path d="M6.5 6 2.5 10l4 4M13.5 6l4 4-4 4M11.25 4.5l-2.5 11" />),
  // A clock turned back, as Stacki's own History icon is.
  history: custom(
    <>
      <path d="M3 10a7 7 0 1 0 2.05-4.95L3 7.1" />
      <path d="M3 3.6v3.5h3.5" />
      <path d="M10 6.5V10l2.5 1.5" />
    </>,
  ),
  apps: custom(
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.75" />
      <rect x="11" y="3" width="6" height="6" rx="1.75" />
      <rect x="3" y="11" width="6" height="6" rx="1.75" />
      <path d="M14 11v6M11 14h6" />
    </>,
  ),
  // A four-pointed star with curved sides, and a small cross beside it.
  ai: custom(
    <>
      <path d="M8.5 6c.6 3.6 1.9 4.9 5.5 5.5-3.6.6-4.9 1.9-5.5 5.5-.6-3.6-1.9-4.9-5.5-5.5 3.6-.6 4.9-1.9 5.5-5.5Z" />
      <path d="M15 2.75v4.5M12.75 5h4.5" />
    </>,
  ),
  instructions: custom(
    <>
      <path d="M10 5.5C8.5 4.25 6.5 3.75 3 4v11.5c3.5-.25 5.5.25 7 1.5 1.5-1.25 3.5-1.75 7-1.5V4c-3.5-.25-5.5.25-7 1.5Z" />
      <path d="M10 5.5V17" />
    </>,
  ),
  // A clipboard with a check; the board's top edge stops either side of the clip.
  audits: custom(
    <>
      <path d="M7.25 3.5H6.5A2.5 2.5 0 0 0 4 6v9a2.5 2.5 0 0 0 2.5 2.5h7A2.5 2.5 0 0 0 16 15V6a2.5 2.5 0 0 0-2.5-2.5h-.75" />
      <rect x="7.25" y="2.25" width="5.5" height="2.75" rx="1" />
      <path d="m7.5 11 1.75 1.75 3.5-3.75" />
    </>,
  ),
  more: custom(
    <>
      <circle cx="4.5" cy="10" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10" r="1.25" fill="currentColor" stroke="none" />
    </>,
  ),
};
