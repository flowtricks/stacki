// Colour contrast as WCAG 2.2 defines it (SC 1.4.3): the relative luminance of
// two sRGB colours, their ratio, and the AA threshold for the text's size. The
// colours are the computed values a browser reports (`rgb(…)` / `rgba(…)`),
// plus the hex forms an author writes, so the same functions serve the rendered
// pass and a test. A translucent foreground is blended over its background
// first, as the screen shows it.
import { assert } from '../core/assert';

export interface Rgba {
  /** 0–255. */
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  /** 0–1. */
  readonly alpha: number;
}

/** AA's ratio for normal text, and for large text (24px, or 18.66px bold). */
export const CONTRAST_NORMAL_MIN = 4.5;
export const CONTRAST_LARGE_MIN = 3;
const LARGE_TEXT_PX_MIN = 24;
const LARGE_BOLD_TEXT_PX_MIN = 18.66;
const BOLD_WEIGHT_MIN = 700;

/** A computed or authored CSS colour, or undefined for a form this does not read (a keyword, a colour function). */
export function parseCssColor(input: string): Rgba | undefined {
  const value = input.trim().toLowerCase();
  if (value === 'transparent') {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }
  if (value.startsWith('#')) {
    return hexColor(value.slice(1));
  }
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const channels = [match[1], match[2], match[3]].map((channel) => Number.parseFloat(channel ?? ''));
  assert(channels.length === 3, 'parseCssColor: three channels');
  const alphaText = match[4];
  const alpha = alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText);
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255) || !Number.isFinite(alpha)) {
    return undefined;
  }
  return { red: channels[0] ?? 0, green: channels[1] ?? 0, blue: channels[2] ?? 0, alpha: Math.min(1, Math.max(0, alpha)) };
}

function hexColor(hex: string): Rgba | undefined {
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(hex)) {
    return undefined;
  }
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
  assert(full.length === 6 || full.length === 8, 'hexColor: expanded to six or eight digits');
  const channel = (index: number): number => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return { red: channel(0), green: channel(1), blue: channel(2), alpha: full.length === 8 ? channel(3) / 255 : 1 };
}

/** `top` drawn over an opaque `bottom`. */
export function blend(top: Rgba, bottom: Rgba): Rgba {
  assert(top.alpha >= 0, 'blend: alpha is at least 0');
  assert(top.alpha <= 1, 'blend: alpha is at most 1');
  const mix = (over: number, under: number): number => over * top.alpha + under * (1 - top.alpha);
  return { red: mix(top.red, bottom.red), green: mix(top.green, bottom.green), blue: mix(top.blue, bottom.blue), alpha: 1 };
}

/** WCAG relative luminance of an opaque colour, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgba): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
  assert(luminance >= 0, 'relativeLuminance: at least black');
  assert(luminance <= 1 + 1e-9, 'relativeLuminance: at most white');
  return luminance;
}

/** The contrast ratio of two opaque colours, 1 to 21. */
export function contrastRatio(first: Rgba, second: Rgba): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  const ratio = (lighter + 0.05) / (darker + 0.05);
  assert(ratio >= 1, 'contrastRatio: at least 1');
  return ratio;
}

/** Whether text of this size and weight is "large" for AA. */
export function largeText(fontSizePx: number, fontWeight: number): boolean {
  assert(fontSizePx >= 0, 'largeText: a size is not negative');
  if (fontSizePx >= LARGE_TEXT_PX_MIN) {
    return true;
  }
  return fontWeight >= BOLD_WEIGHT_MIN && fontSizePx >= LARGE_BOLD_TEXT_PX_MIN;
}

export type ContrastVerdict =
  | { readonly tag: 'pass'; readonly ratio: number }
  | { readonly tag: 'fail'; readonly ratio: number; readonly required: number }
  /** A colour this cannot read, or a background it cannot know (an image, a gradient). */
  | { readonly tag: 'unknown' };

/** AA's verdict on text of `foreground` over `background`, each a CSS colour string. */
export function contrastVerdict(input: {
  readonly foreground: string;
  readonly background: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
}): ContrastVerdict {
  const foreground = parseCssColor(input.foreground);
  const background = parseCssColor(input.background);
  if (foreground === undefined || background === undefined || background.alpha < 1) {
    return { tag: 'unknown' };
  }
  const shown = blend(foreground, background);
  const ratio = contrastRatio(shown, background);
  const required = largeText(input.fontSizePx, input.fontWeight) ? CONTRAST_LARGE_MIN : CONTRAST_NORMAL_MIN;
  assert(required > 1, 'contrastVerdict: a threshold above 1');
  return ratio + 1e-9 >= required ? { tag: 'pass', ratio } : { tag: 'fail', ratio, required };
}
