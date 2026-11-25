// What a template entry's props hold, as the binding picker reads them: a sample, not the
// data. Long strings are clipped, long lists cut short, deep nesting stopped, and what JSON
// cannot hold (a function, a symbol) dropped. These are Desktop's rules, from the sample in
// its /__avb/paths route (electron/preview/markerConfig.ts), with its `__stacki` tags for a
// date, a value nested too deep, and the items a list had past the cut.
//
// The bake runs this function inside the site's own build, on each entry's Astro.props
// (bakeIntegration.ts inlines its source), so it must stay self-contained: no imports, no
// names from outside its body. Its depth is bounded by its own `depth` check.

/** How many entries' props a server answer samples; the picker shows one entry at a time. */
export const ENTRY_PROPS_SAMPLED_MAX = 30;
/** A sample's JSON past this is refused at the boundary: the rules keep real ones far below it. */
export const ENTRY_PROPS_CHARS_MAX = 200_000;

export function sampleEntryProps(value: unknown, depth: number): unknown {
  const stringCharsMax = 160;
  const itemsMax = 8;
  const depthMax = 6;
  const keysMax = 64;
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value.length > stringCharsMax ? `${value.slice(0, stringCharsMax)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') {
    return undefined; // Functions, symbols and bigints are not data a field shows.
  }
  if (value instanceof Date) {
    return { __stacki: 'date', value: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  }
  if (depth >= depthMax) {
    return { __stacki: 'deep' };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value.slice(0, itemsMax).map((item: unknown) => {
      const sampled = sampleEntryProps(item, depth + 1);
      return sampled === undefined ? null : sampled;
    });
    if (value.length > itemsMax) {
      items.push({ __stacki: 'more', count: value.length - itemsMax });
    }
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, keysMax)) {
    try {
      const sampled = sampleEntryProps(Reflect.get(value, key), depth + 1);
      if (sampled !== undefined) {
        out[key] = sampled;
      }
    } catch {
      // A getter that throws is not worth the whole entry.
    }
  }
  return out;
}

/** A sample that crossed a boundary (the wire, the snapshot), kept only while it is bounded JSON. */
export function parseEntryProps(input: unknown): unknown {
  if (input === undefined || input === null) {
    return undefined;
  }
  const text = JSON.stringify(input);
  if (text.length > ENTRY_PROPS_CHARS_MAX) {
    throw new Error('Entry props: the sample exceeds its limit');
  }
  return JSON.parse(text) as unknown;
}
