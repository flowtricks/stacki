// Numbers, dates, relative times, lists and byte sizes for one locale, on the platform's `Intl` (docs/i18n-playbook.md,
// "Numbers and dates"). Nothing in the interface hand-formats these: a `toFixed(1) + ' MB'` or `toLocaleDateString()` with no locale
// shows the operating system's idea of the language, not the one the person chose in Settings.
// Pure and DOM-free so the renderer, Studio and the main process share it. Intl objects are costly to build, so each
// formatter keeps a small bounded cache keyed by its options.
import { assert } from '../assert';
import type { Locale } from './locales';

/** Bound on cached `Intl` objects per locale; past it the cache is emptied rather than grown (AGENTS.md §10). */
export const FORMAT_CACHE_MAX = 64;

export type ListStyle = 'and' | 'or';
export type RelativeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

export interface Formatters {
  readonly locale: Locale;
  /** `formatNumber(1234.5)` is `1,234.5` in English and `1.234,5` in German. Pass options for percent, currency or digits. */
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** The options are required: say `{ dateStyle: 'medium' }` or the fields you want, so the output never depends on a default. */
  readonly formatDate: (value: Date | number, options: Intl.DateTimeFormatOptions) => string;
  /** "3 minutes ago", "yesterday", "in 2 hours": the unit is chosen from the distance between `value` and `now`. */
  readonly formatRelativeTime: (value: Date | number, now: Date | number) => string;
  /** "A, B and C" / "A, B or C" in the language's own grammar. */
  readonly formatList: (items: readonly string[], style: ListStyle) => string;
  /** A file size: `1536` is `1.5 kB`; the unit steps through byte, kilobyte, megabyte and gigabyte. */
  readonly formatBytes: (sizeBytes: number) => string;
}

const formattersByLocale = new Map<Locale, Formatters>();

/** The formatters for a locale. Built once per locale; at most one per shipped language. */
export function formattersFor(locale: Locale): Formatters {
  const existing = formattersByLocale.get(locale);
  if (existing !== undefined) {
    return existing;
  }
  const created = createFormatters(locale);
  formattersByLocale.set(locale, created);
  return created;
}

export function createFormatters(locale: Locale): Formatters {
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  const lists = new Map<ListStyle, Intl.ListFormat>();
  let relative: Intl.RelativeTimeFormat | undefined;

  const numberFormat = (options: Intl.NumberFormatOptions | undefined): Intl.NumberFormat => {
    const cacheKey = JSON.stringify(options ?? {});
    const cached = numbers.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    if (numbers.size >= FORMAT_CACHE_MAX) {
      numbers.clear();
    }
    const created = new Intl.NumberFormat(locale, options);
    numbers.set(cacheKey, created);
    return created;
  };

  const formatNumber: Formatters['formatNumber'] = (value, options) => {
    assert(Number.isFinite(value), 'formatNumber: the value is finite');
    return numberFormat(options).format(value);
  };

  const formatDate: Formatters['formatDate'] = (value, options) => {
    const time = typeof value === 'number' ? value : value.getTime();
    assert(Number.isFinite(time), 'formatDate: the date is valid');
    const cacheKey = JSON.stringify(options);
    let format = dates.get(cacheKey);
    if (format === undefined) {
      if (dates.size >= FORMAT_CACHE_MAX) {
        dates.clear();
      }
      format = new Intl.DateTimeFormat(locale, options);
      dates.set(cacheKey, format);
    }
    return format.format(time);
  };

  const formatRelativeTime: Formatters['formatRelativeTime'] = (value, now) => {
    const valueMs = typeof value === 'number' ? value : value.getTime();
    const nowMs = typeof now === 'number' ? now : now.getTime();
    assert(Number.isFinite(valueMs), 'formatRelativeTime: the time is valid');
    assert(Number.isFinite(nowMs), 'formatRelativeTime: now is valid');
    relative ??= new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
    const step = relativeStep(valueMs - nowMs);
    return relative.format(step.amount, step.unit);
  };

  const formatList: Formatters['formatList'] = (items, style) => {
    let format = lists.get(style);
    if (format === undefined) {
      format = new Intl.ListFormat(locale, { type: style === 'and' ? 'conjunction' : 'disjunction', style: 'long' });
      lists.set(style, format);
    }
    return format.format(items);
  };

  const formatBytes: Formatters['formatBytes'] = (sizeBytes) => {
    assert(Number.isFinite(sizeBytes), 'formatBytes: the size is finite');
    assert(sizeBytes >= 0, 'formatBytes: a size is not negative');
    const step = byteStep(sizeBytes);
    return numberFormat({ style: 'unit', unit: step.unit, unitDisplay: 'short', maximumFractionDigits: step.unit === 'byte' ? 0 : 1 }).format(step.amount);
  };

  return { locale, formatNumber, formatDate, formatRelativeTime, formatList, formatBytes };
}

/** The amount and unit that read best for a signed distance in milliseconds: the largest unit that fits, rounded toward zero. */
export function relativeStep(deltaMs: number): { readonly amount: number; readonly unit: RelativeUnit } {
  assert(Number.isFinite(deltaMs), 'relativeStep: the distance is finite');
  const seconds = Math.trunc(deltaMs / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 60) {
    return { amount: seconds, unit: 'second' };
  }
  if (magnitude < 3_600) {
    return { amount: Math.trunc(seconds / 60), unit: 'minute' };
  }
  if (magnitude < 86_400) {
    return { amount: Math.trunc(seconds / 3_600), unit: 'hour' };
  }
  if (magnitude < 2_592_000) {
    return { amount: Math.trunc(seconds / 86_400), unit: 'day' };
  }
  if (magnitude < 31_536_000) {
    return { amount: Math.trunc(seconds / 2_592_000), unit: 'month' };
  }
  return { amount: Math.trunc(seconds / 31_536_000), unit: 'year' };
}

function byteStep(sizeBytes: number): { readonly amount: number; readonly unit: 'byte' | 'kilobyte' | 'megabyte' | 'gigabyte' } {
  if (sizeBytes < 1_000) {
    return { amount: sizeBytes, unit: 'byte' };
  }
  if (sizeBytes < 1_000_000) {
    return { amount: sizeBytes / 1_000, unit: 'kilobyte' };
  }
  if (sizeBytes < 1_000_000_000) {
    return { amount: sizeBytes / 1_000_000, unit: 'megabyte' };
  }
  return { amount: sizeBytes / 1_000_000_000, unit: 'gigabyte' };
}
