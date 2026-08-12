// Astro's built-in image components, from `astro:assets`.
//
// <Image> and <Picture> are components, not HTML — they take an imported asset
// (or a remote URL plus explicit dimensions), and Astro optimises and emits the
// <img>/<picture> at build time. They belong in the insert palette next to the
// components a project defines, but nothing scans them into existence: they
// have no file in src/, so their names, props and identity are declared here.
//
// The UI treats them as a third thing — not a project component (green cube,
// openable) and not a plain tag (grey element icon). See ASTRO_ASSET_COLOR and
// astroAssetIcon in ui/Icons.jsx.

export const ASTRO_ASSETS_MODULE = 'astro:assets';

// Astro's own accent, so an <Image> reads as "this is Astro's, not yours".
export const ASTRO_ASSET_COLOR = '#ff5d01';

// Shared by both: the source asset and the accessible text. `src` is an expr
// (an imported ImageMetadata) far more often than a string, but a remote URL is
// a string — the props panel decides which editor to show from the value.
const COMMON = [
  { name: 'src', type: 'other' },
  { name: 'alt', type: 'string' },
  { name: 'width', type: 'number' },
  { name: 'height', type: 'number' },
  { name: 'quality', type: 'other' },
  { name: 'loading', type: 'enum', options: ['lazy', 'eager'], default: 'lazy' },
  { name: 'decoding', type: 'enum', options: ['async', 'sync', 'auto'], default: 'async' },
  { name: 'fetchpriority', type: 'enum', options: ['auto', 'high', 'low'], default: 'auto' },
  { name: 'densities', type: 'other' },
  { name: 'widths', type: 'other' },
  { name: 'sizes', type: 'string' },
  { name: 'class', type: 'string' },
];

export const ASTRO_ASSETS = [
  {
    name: 'Image',
    // What it renders — used for the icon, so the row shows an image glyph.
    tag: 'img',
    blurb: 'Optimised <img> from astro:assets',
    astroAsset: true,
    hasRest: true,
    slots: [],
    schema: [...COMMON, { name: 'format', type: 'enum', options: ['webp', 'avif', 'png', 'jpeg', 'jpg', 'svg', 'gif'] }],
  },
  {
    name: 'Picture',
    tag: 'picture',
    blurb: 'Responsive <picture> from astro:assets',
    astroAsset: true,
    hasRest: true,
    slots: [],
    schema: [
      ...COMMON,
      // Picture's plural: the alternate formats to emit sources for, plus the
      // one the fallback <img> uses.
      { name: 'formats', type: 'other' },
      { name: 'fallbackFormat', type: 'enum', options: ['webp', 'avif', 'png', 'jpeg', 'jpg', 'svg', 'gif'] },
      { name: 'pictureAttributes', type: 'other' },
    ],
  },
];

// What a freshly inserted <Image> points at until a real asset is picked.
//
// It cannot just be left off. Astro validates `src` while rendering and throws
// ExpectedImage — which takes down the whole page, so dropping an <Image> onto
// the canvas would replace the design with a stack trace. `src=""` is worse: it
// returns 200 with the entire body silently missing.
//
// A data URI is the one placeholder that costs nothing — it renders a visible
// grey box, needs no file on disk, and needs no remote-domain allowlisting the
// way an http src would. A string src also has to carry width/height, so those
// come with it; picking a real image in the props panel replaces the lot.
export const PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='%23d8d8d8'/%3E%3C/svg%3E";
export const PLACEHOLDER_PROPS = {
  src: { type: 'string', value: PLACEHOLDER_SRC },
  alt: { type: 'string', value: '' },
  width: { type: 'expr', value: '400' },
  height: { type: 'expr', value: '300' },
};

export const isAstroAsset = (name) => ASTRO_ASSETS.some((a) => a.name === name);
export const astroAsset = (name) => ASTRO_ASSETS.find((a) => a.name === name) || null;
