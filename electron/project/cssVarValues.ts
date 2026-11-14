// What a custom property's value is: resolved through the other variables, and
// classed as a colour, a size, a font or something else (cssVars.ts).

import { CSS_VARIABLE_LIMITS } from './cssVarRead';

export const NAMED_COLORS = new Set([
  'transparent',
  'currentcolor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'brown',
  'cyan',
  'magenta',
  'lime',
  'navy',
  'teal',
  'olive',
  'maroon',
  'silver',
  'gold',
  'beige',
  'ivory',
  'coral',
  'salmon',
  'khaki',
  'indigo',
  'violet',
]);

export const COLOR_FUNCTION = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

export function resolveValue(value: unknown, map: Map<string, string>, depth = 0): string {
  if (depth > CSS_VARIABLE_LIMITS.resolveDepthMax) {
    return String(value);
  }
  const next = String(value).replace(
    /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (whole: string, name: string, fallback: string | undefined) => {
      const found = map.get(name);
      if (found !== undefined) {
        return found;
      }
      return fallback !== undefined ? fallback.trim() : whole;
    },
  );
  return next === String(value) ? next : resolveValue(next, map, depth + 1);
}

export function colorOf(resolved: unknown): string | undefined {
  const value = String(resolved).trim();
  if (!value) {
    return undefined;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(value)) {
    return value;
  }
  if (COLOR_FUNCTION.test(value)) {
    return value;
  }
  if (NAMED_COLORS.has(value.toLowerCase())) {
    return value;
  }
  return undefined;
}

// True for values that name a colour but cannot be drawn as one — the swatch
// shows a checkerboard rather than pretending.
export const isUncomputableColor = (resolved: unknown): boolean => /(^|\s|\()color-mix\(/i.test(String(resolved));

// What kind of thing a variable holds, which is what picks its glyph — the same
// four the style panel's variable picker uses, so a colour is a droplet in both
// places and a bare number is a number in both.
export const FONT_WORDS = new RegExp(
  '(serif|sans-serif|monospace|cursive|system-ui|uppercase|lowercase|capitalize|' + 'balance|pretty|italic|normal|inherit)',
  'i',
);

export function kindOf(value: unknown, resolved: unknown): string {
  const text = String(resolved ?? value).trim();
  if (!text) {
    return 'size';
  }
  if (colorOf(text) || isUncomputableColor(text)) {
    return 'color';
  }
  // Unitless: a line height, a weight, a column count, a fluid-scale bound.
  if (/^-?\d*\.?\d+$/.test(text)) {
    return 'number';
  }
  // A plain percentage has its own glyph in the Variables panel; calc() holding a % stays a size.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(text)) {
    return 'percentage';
  }
  if (/^-?\d*\.?\d+([a-z%]+)$/i.test(text) || /^(calc|clamp|min|max)\(/i.test(text)) {
    return 'size';
  }
  if (/[a-z]/i.test(text) && (FONT_WORDS.test(text) || text.includes(',') || /^[a-z-]+$/i.test(text))) {
    return 'font';
  }
  return 'size';
}
