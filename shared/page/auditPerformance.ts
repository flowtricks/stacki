// Page performance, measured locally: main loads the route from the project's
// dev server in a hidden window and reads what the browser itself reports
// (PerformanceObserver, resource timing, the images and fonts on the page).
// This module is the boundary for that report — every field is parsed and
// bounded here — and turns it into findings and a simple score. The numbers
// come from a dev server, which serves unbundled modules: request counts and
// sizes run high, so the panel labels them approximations.
import { assert } from '../core/assert';
import { toArray, toRecord } from '../core/record';
import { auditFinding, type AuditFinding } from './auditFindings';
import { parseMarker, type RenderedSource } from './auditRendered';

export const MEASUREMENT_LIMITS = {
  imagesMax: 200,
  resourcesMax: 500,
  shiftsMax: 50,
  fontsMax: 100,
  textCharsMax: 2_048,
  /** How long main waits for one page before giving up. */
  pageMsMax: 30_000,
} as const satisfies Record<string, number>;

/** An element the measurement names, with the marker the dev server wrote before it. */
export interface MeasuredElement {
  readonly tag: string;
  readonly marker: string | undefined;
  readonly label: string;
}

export interface MeasuredImage {
  readonly element: MeasuredElement;
  readonly url: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly belowFold: boolean;
  readonly loading: string;
  readonly fetchPriority: string;
}

export interface Measurement {
  readonly lcpMs: number | undefined;
  readonly lcpElement: MeasuredElement | undefined;
  readonly cls: number;
  readonly shifts: readonly MeasuredElement[];
  readonly tbtMs: number;
  readonly transferBytes: number;
  readonly requests: number;
  readonly blocking: readonly string[];
  readonly thirdParty: readonly string[];
  readonly images: readonly MeasuredImage[];
  readonly fontsWithoutDisplay: readonly string[];
  readonly devicePixelRatio: number;
}

function finite(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Measurement.${where}: expected a non-negative number`);
  }
  return value;
}

function bounded(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Measurement.${where}: expected a string`);
  }
  return value.slice(0, MEASUREMENT_LIMITS.textCharsMax);
}

function items(value: unknown, where: string, max: number): readonly unknown[] {
  const list = toArray(value);
  if (list === undefined) {
    throw new Error(`Measurement.${where}: expected an array`);
  }
  return list.slice(0, max);
}

function element(value: unknown, where: string): MeasuredElement {
  const record = toRecord(value);
  if (record === undefined) {
    throw new Error(`Measurement.${where}: expected an object`);
  }
  const marker = record['marker'];
  return {
    tag: bounded(record['tag'], `${where}.tag`).toLowerCase(),
    marker: marker === undefined || marker === '' ? undefined : bounded(marker, `${where}.marker`),
    label: bounded(record['label'] ?? '', `${where}.label`),
  };
}

/** The hidden window's report, checked in full. */
export function parseMeasurement(input: unknown): Measurement {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error('Measurement: expected an object');
  }
  const lcp = value['lcpMs'];
  const lcpElement = value['lcpElement'];
  const images = items(value['images'], 'images', MEASUREMENT_LIMITS.imagesMax).map((raw, index): MeasuredImage => {
    const image = toRecord(raw);
    if (image === undefined) {
      throw new Error(`Measurement.images[${index}]: expected an object`);
    }
    return {
      element: element(image['element'], `images[${index}].element`),
      url: bounded(image['url'], `images[${index}].url`),
      naturalWidth: finite(image['naturalWidth'], `images[${index}].naturalWidth`),
      naturalHeight: finite(image['naturalHeight'], `images[${index}].naturalHeight`),
      displayWidth: finite(image['displayWidth'], `images[${index}].displayWidth`),
      displayHeight: finite(image['displayHeight'], `images[${index}].displayHeight`),
      belowFold: image['belowFold'] === true,
      loading: bounded(image['loading'] ?? '', `images[${index}].loading`).toLowerCase(),
      fetchPriority: bounded(image['fetchPriority'] ?? '', `images[${index}].fetchPriority`).toLowerCase(),
    };
  });
  const strings = (key: string, max: number): readonly string[] => items(value[key], key, max).map((item, index) => bounded(item, `${key}[${index}]`));
  const measurement: Measurement = {
    lcpMs: lcp === undefined ? undefined : finite(lcp, 'lcpMs'),
    lcpElement: lcpElement === undefined ? undefined : element(lcpElement, 'lcpElement'),
    cls: finite(value['cls'], 'cls'),
    shifts: items(value['shifts'], 'shifts', MEASUREMENT_LIMITS.shiftsMax).map((raw, index) => element(raw, `shifts[${index}]`)),
    tbtMs: finite(value['tbtMs'], 'tbtMs'),
    transferBytes: finite(value['transferBytes'], 'transferBytes'),
    requests: finite(value['requests'], 'requests'),
    blocking: strings('blocking', MEASUREMENT_LIMITS.resourcesMax),
    thirdParty: strings('thirdParty', MEASUREMENT_LIMITS.resourcesMax),
    images,
    fontsWithoutDisplay: strings('fontsWithoutDisplay', MEASUREMENT_LIMITS.fontsMax),
    devicePixelRatio: Math.max(1, finite(value['devicePixelRatio'] ?? 1, 'devicePixelRatio')),
  };
  assert(measurement.images.length <= MEASUREMENT_LIMITS.imagesMax, 'parseMeasurement: images are bounded');
  return measurement;
}

/** A 0–100 score from the vitals and the page's weight: a simple guide, not Lighthouse's formula. */
export function performanceScore(measurement: Pick<Measurement, 'lcpMs' | 'cls' | 'tbtMs' | 'transferBytes' | 'requests'>): number {
  let score = 100;
  const lcp = measurement.lcpMs ?? 0;
  score -= lcp > 4_000 ? 30 : lcp > 2_500 ? 15 : 0;
  score -= measurement.cls > 0.25 ? 25 : measurement.cls > 0.1 ? 10 : 0;
  score -= measurement.tbtMs > 600 ? 25 : measurement.tbtMs > 200 ? 10 : 0;
  score -= measurement.transferBytes > 5_000_000 ? 10 : measurement.transferBytes > 2_000_000 ? 5 : 0;
  score -= measurement.requests > 150 ? 5 : 0;
  const clamped = Math.max(0, Math.min(100, score));
  assert(Number.isSafeInteger(clamped), 'performanceScore: a whole number');
  return clamped;
}

const MODERN_FORMAT = /\.(avif|webp|svg)(\?|#|$)|format=(avif|webp)|[?&]f=(avif|webp)|\/_image\?/i;

/** The findings one page's measurement shows, each placed at its element's source when the dev server marked it. */
export function performanceFindings(measurement: Measurement, page: { readonly file: string; readonly route: string }): readonly AuditFinding[] {
  assert(page.route.startsWith('/'), 'performanceFindings: a route');
  const findings: AuditFinding[] = [];
  const add = (
    check: AuditFinding['check'],
    detail: string,
    measured: MeasuredElement | undefined,
    fix?: { readonly label: string; readonly name: string; readonly value: string },
  ): void => {
    const source: RenderedSource | undefined = measured?.marker === undefined ? undefined : parseMarker(measured.marker, page.file);
    const file = source?.file ?? page.file;
    findings.push(
      auditFinding({
        check,
        file,
        fileKind: file === page.file ? 'page' : 'component',
        element: source === undefined || measured === undefined ? undefined : { path: source.path, tag: measured.tag, line: undefined },
        detail: `${detail} (on ${page.route})`,
        source: 'rendered',
        fix:
          fix === undefined || source === undefined || measured?.tag !== 'img'
            ? undefined
            : {
                label: fix.label,
                before: '<img …>',
                after: `<img … ${fix.name}="${fix.value}">`,
                file,
                edits: [{ tag: 'attributes', path: source.path, expect: 'img', patch: { [fix.name]: { type: 'string', value: fix.value } } }],
              },
      }),
    );
  };
  if (measurement.lcpMs !== undefined && measurement.lcpMs > 2_500) {
    add('perf-lcp', `${(measurement.lcpMs / 1000).toFixed(1)} s to the largest paint`, measurement.lcpElement);
  }
  if (measurement.cls > 0.1) {
    add('perf-cls', `CLS ${measurement.cls.toFixed(2)}`, measurement.shifts[0]);
  }
  if (measurement.tbtMs > 200) {
    add('perf-tbt', `${Math.round(measurement.tbtMs)} ms of blocking script`, undefined);
  }
  if (measurement.transferBytes > 2_000_000 || measurement.requests > 150) {
    add('perf-weight', `${(measurement.transferBytes / 1_000_000).toFixed(1)} MB in ${measurement.requests} requests (dev server)`, undefined);
  }
  for (const url of measurement.blocking.slice(0, 10)) {
    add('perf-blocking', shortUrl(url), undefined);
  }
  for (const url of measurement.thirdParty.slice(0, 10)) {
    add('perf-third-party', shortUrl(url), undefined);
  }
  for (const family of measurement.fontsWithoutDisplay.slice(0, 10)) {
    add('perf-font-display', `@font-face "${family}"`, undefined);
  }
  imageFindings(measurement, add);
  return findings;
}

type Add = (
  check: AuditFinding['check'],
  detail: string,
  measured: MeasuredElement | undefined,
  fix?: { readonly label: string; readonly name: string; readonly value: string },
) => void;

function imageFindings(measurement: Measurement, add: Add): void {
  const lcpMarker = measurement.lcpElement?.marker;
  for (const image of measurement.images) {
    const name = shortUrl(image.url);
    const wanted = image.displayWidth * measurement.devicePixelRatio;
    if (image.displayWidth > 0 && image.naturalWidth > wanted * 1.5 && image.naturalWidth - wanted > 200) {
      add('perf-image-size', `${name}: ${image.naturalWidth}px wide, shown at ${Math.round(image.displayWidth)}px`, image.element);
    }
    if (!MODERN_FORMAT.test(image.url) && !image.url.startsWith('data:')) {
      add('perf-image-format', name, image.element);
    }
    if (image.belowFold && image.loading !== 'lazy') {
      add('perf-lazy', name, image.element, { label: 'Add loading="lazy"', name: 'loading', value: 'lazy' });
    }
    if (lcpMarker !== undefined && image.element.marker === lcpMarker && image.fetchPriority !== 'high') {
      add('perf-fetchpriority', name, image.element, { label: 'Add fetchpriority="high"', name: 'fetchpriority', value: 'high' });
    }
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}
