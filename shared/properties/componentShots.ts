import { count, list, object, pathText, text } from '../core/boundary';

// Photographs of components on the pages that use them, for the insert palette.
//
// The main process renders the project's pages in a hidden window, finds where each component
// sits on the page, and keeps a JPEG of that spot. This file is the contract both halves share:
// the bounds, the shape of the cache's meta file, and the shape the renderer receives. The meta
// file is read from disk and the entry list from IPC, so both are parsed here, at the boundary.

export const COMPONENT_SHOT_LIMITS = {
  /** Logical width every photograph is taken at. */
  widthPx: 1440,
  /** Tallest a photograph gets, in logical pixels: a section taller than this is cut off at the bottom. */
  heightMax: 1600,
  /** Shortest region worth a photograph; anything thinner is a divider or an empty wrapper. */
  heightMin: 24,
  /** Pages loaded in one run, the home page first; pages found through links to dynamic routes included. */
  pagesMax: 60,
  /** Width of the second look at a page, for components its desktop width hides (a table of contents that CSS drops above 1400 px). */
  narrowWidthPx: 1200,
  /** Links read from one page when looking for addresses behind dynamic routes. */
  linksMax: 500,
  /** Components kept per project. */
  componentsMax: 500,
  /** Comment anchors read from one page. */
  anchorsMax: 6000,
  /** Sibling nodes walked between one pair of anchors. */
  siblingsMax: 2000,
  /** Source files parsed to learn which component a marker path calls. */
  filesParsedMax: 2000,
  /** JPEG quality of a photograph. */
  jpegQuality: 82,
  /** How long a page may take to load, in milliseconds. */
  pageLoadTimeoutMs: 20_000,
  /** Wait after load for fonts, posters and entrance animations, in milliseconds. */
  settleMs: 1800,
  /** Longest one photograph may take from measuring to bytes, in milliseconds. */
  shotTimeoutMs: 8000,
  /** Longest a whole run may take, in milliseconds. */
  runTimeoutMs: 10 * 60 * 1000,
} as const;

const SHOT_FILE = /^[0-9a-f]{16}\.jpg$/;
const FINGERPRINT = /^[0-9a-f]{0,64}$/;

export interface ComponentShot {
  /** The component's file, as the project scan names it. */
  readonly component: string;
  /** The image file in the project's cache folder. */
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface ComponentShotMeta {
  readonly version: 1;
  /** The fingerprint of the project the run completed against; empty while no run has completed. */
  readonly fingerprint: string;
  readonly capturedAt: number;
  readonly shots: readonly ComponentShot[];
}

export function parseComponentShotMeta(input: unknown): ComponentShotMeta {
  const value = object({ version: count, fingerprint: text, capturedAt: count, shots: list(parseComponentShot) })(input);
  if (value.version !== 1) {
    throw new Error('Component shots: unknown meta version');
  }
  if (!FINGERPRINT.test(value.fingerprint)) {
    throw new Error('Component shots: fingerprint is not hexadecimal');
  }
  if (value.shots.length > COMPONENT_SHOT_LIMITS.componentsMax) {
    throw new Error('Component shots: too many shots');
  }
  const seen = new Set<string>();
  for (const shot of value.shots) {
    if (seen.has(shot.component)) {
      throw new Error('Component shots: duplicate component');
    }
    seen.add(shot.component);
  }
  return { version: 1, fingerprint: value.fingerprint, capturedAt: value.capturedAt, shots: value.shots };
}

function parseComponentShot(input: unknown): ComponentShot {
  const value = object({ component: pathText, file: text, width: count, height: count })(input);
  if (value.component.length === 0) {
    throw new Error('Component shots: empty component');
  }
  if (!SHOT_FILE.test(value.file)) {
    throw new Error('Component shots: image file name');
  }
  if (value.width < 1 || value.width > COMPONENT_SHOT_LIMITS.widthPx) {
    throw new Error('Component shots: width out of bounds');
  }
  if (value.height < 1 || value.height > COMPONENT_SHOT_LIMITS.heightMax) {
    throw new Error('Component shots: height out of bounds');
  }
  return value;
}

/** What the renderer learns about one photograph: where it is for, and how big. The bytes come separately. */
export interface ComponentShotEntry {
  readonly component: string;
  readonly width: number;
  readonly height: number;
}

export function parseComponentShotEntries(input: unknown): readonly ComponentShotEntry[] {
  const entries = list((entry) => {
    const { component, width, height } = parseComponentShot({
      ...object({ component: pathText, width: count, height: count })(entry),
      file: '0'.repeat(16) + '.jpg',
    });
    return { component, width, height };
  })(input);
  if (entries.length > COMPONENT_SHOT_LIMITS.componentsMax) {
    throw new Error('Component shots: too many entries');
  }
  return entries;
}

/** The photograph as a data URL, or undefined when there is none. Bounded: a JPEG of 1440 × 1600 is far below this. */
export const SHOT_DATA_URL_CHARS_MAX = 12 * 1024 * 1024;
export function parseComponentShotImage(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = text(input);
  if (!value.startsWith('data:image/jpeg;base64,')) {
    throw new Error('Component shot image: not a JPEG data URL');
  }
  if (value.length > SHOT_DATA_URL_CHARS_MAX) {
    throw new Error('Component shot image: exceeds limit');
  }
  return value;
}
