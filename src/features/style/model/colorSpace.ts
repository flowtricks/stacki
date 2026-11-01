// Color parsing + conversion for the color picker. Parsing leans on a shared
// canvas 2d context (the browser normalizes ANY CSS color — named, hex, rgb(),
// hsl(), transparent — to rgb/rgba), so we never ship a 148-name table.

export type RGBA = { r: number; g: number; b: number; a: number }; // r,g,b 0–255, a 0–1
export type HSVA = { h: number; s: number; v: number; a: number }; // h 0–360, s,v 0–100, a 0–1

// The canvas is probed once; a failed probe is remembered so the fallback parser is used
// without retrying the DOM on every call.
type CanvasProbe = { readonly kind: 'unprobed' } | { readonly kind: 'probed'; readonly context: CanvasRenderingContext2D | undefined };

let canvasProbe: CanvasProbe = { kind: 'unprobed' };

function canvasContext(): CanvasRenderingContext2D | undefined {
  if (canvasProbe.kind === 'probed') {
    return canvasProbe.context;
  }
  let context: CanvasRenderingContext2D | undefined;
  try {
    context = document.createElement('canvas').getContext('2d') ?? undefined;
  } catch {
    context = undefined;
  }
  canvasProbe = { kind: 'probed', context };
  return context;
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const round = (value: number) => Math.round(value);

/** Parse any CSS color string to RGBA, or undefined when it isn't a valid color. */
export function parseColor(input: string): RGBA | undefined {
  const value = input.trim();
  if (!value) {
    return undefined;
  }
  const context = canvasContext();
  if (!context) {
    return parseColorFallback(value);
  }
  // Invalid values leave fillStyle unchanged, so probe with two different sentinels
  // — if the readback matches neither-changed, the input was rejected.
  context.fillStyle = '#000000';
  context.fillStyle = value;
  const readbackAfterBlack = context.fillStyle;
  context.fillStyle = '#ffffff';
  context.fillStyle = value;
  const readbackAfterWhite = context.fillStyle;
  if (readbackAfterBlack !== readbackAfterWhite) {
    return undefined;
  }
  return parseNormalized(readbackAfterBlack);
}

/** Parse the browser-normalized output (`#rrggbb` or `rgb[a](…)`). */
function parseNormalized(normalized: string): RGBA | undefined {
  if (normalized[0] === '#') {
    const hex = normalized.slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  const match = /rgba?\(([^)]+)\)/i.exec(normalized);
  if (!match) {
    return undefined;
  }
  const parts = (match[1] ?? '').split(',').map((part) => part.trim());
  if (parts.length < 3) {
    return undefined;
  }
  return {
    r: round(parseFloat(parts[0] ?? '')),
    g: round(parseFloat(parts[1] ?? '')),
    b: round(parseFloat(parts[2] ?? '')),
    a: parts[3] !== undefined ? clamp(parseFloat(parts[3]), 0, 1) : 1,
  };
}

// A minimal fallback for non-DOM contexts (tests) — hex + rgb/rgba only.
function parseColorFallback(value: string): RGBA | undefined {
  // The one keyword worth knowing without a canvas: it is what an unset colour
  // is written as all over this panel, and a browser normalizes it to exactly
  // this. Left out, the fallback answers "not a colour" for the value the panel
  // shows most often.
  if (value.toLowerCase() === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    let hexDigits = hex[1] ?? '';
    if (hexDigits.length === 3 || hexDigits.length === 4) {
      hexDigits = hexDigits
        .split('')
        .map((digit) => digit + digit)
        .join('');
    }
    return {
      r: parseInt(hexDigits.slice(0, 2), 16),
      g: parseInt(hexDigits.slice(2, 4), 16),
      b: parseInt(hexDigits.slice(4, 6), 16),
      a: hexDigits.length === 8 ? parseInt(hexDigits.slice(6, 8), 16) / 255 : 1,
    };
  }
  return parseNormalized(value);
}

export function rgbaToHsva({ r: red, g: green, b: blue, a: alpha }: RGBA): HSVA {
  const rn = red / 255,
    gn = green / 255,
    bn = blue / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn),
    delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === rn) {
      hue = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      hue = (bn - rn) / delta + 2;
    } else {
      hue = (rn - gn) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }
  return {
    h: round(hue),
    s: round(max === 0 ? 0 : (delta / max) * 100),
    v: round(max * 100),
    a: alpha,
  };
}

export function hsvaToRgba({ h: hue, s: saturation, v: value, a: alpha }: HSVA): RGBA {
  const sn = saturation / 100,
    vn = value / 100;
  const chroma = vn * sn;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = vn - chroma;
  const [redBase, greenBase, blueBase] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return {
    r: round((redBase + offset) * 255),
    g: round((greenBase + offset) * 255),
    b: round((blueBase + offset) * 255),
    a: alpha,
  };
}

const hex2 = (channel: number) => clamp(round(channel), 0, 255).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` when alpha < 1. */
export function formatHex({ r: red, g: green, b: blue, a: alpha }: RGBA): string {
  const base = `#${hex2(red)}${hex2(green)}${hex2(blue)}`;
  return alpha < 1 ? `${base}${hex2(alpha * 255)}` : base;
}

/** `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
export function formatRgba({ r: red, g: green, b: blue, a: alpha }: RGBA): string {
  const rn = round(red),
    gn = round(green),
    bn = round(blue);
  return alpha < 1 ? `rgba(${rn}, ${gn}, ${bn}, ${round(alpha * 100) / 100})` : `rgb(${rn}, ${gn}, ${bn})`;
}

// The picker's four notations. `hsb` (= hue/sat/brightness, the HSVA the picker
// stores) has no CSS form, so it emits rgb — it's an input representation only.
export type ColorMode = 'hex' | 'rgb' | 'hsl' | 'hsb';

export function formatColor(color: RGBA, mode: ColorMode): string {
  if (mode === 'rgb' || mode === 'hsb') {
    return formatRgba(color);
  }
  if (mode === 'hsl') {
    return formatHsla(color);
  }
  return formatHex(color);
}

/** RGBA → HSL channels (h 0–360, s/l 0–100). */
export function rgbaToHsl({ r: red, g: green, b: blue }: RGBA): {
  h: number;
  s: number;
  l: number;
} {
  const rn = red / 255,
    gn = green / 255,
    bn = blue / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn),
    delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === rn) {
      hue = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      hue = (bn - rn) / delta + 2;
    } else {
      hue = (rn - gn) / delta + 4;
    }
    hue = (hue * 60 + 360) % 360;
  }
  return { h: round(hue), s: round(saturation * 100), l: round(lightness * 100) };
}

function formatHsla(color: RGBA): string {
  const { h: hue, s: saturation, l: lightness } = rgbaToHsl(color);
  return color.a < 1 ? `hsla(${hue}, ${saturation}%, ${lightness}%, ${round(color.a * 100) / 100})` : `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/** Detect the notation a color string is written in (to keep output style stable). */
export function colorMode(input: string): ColorMode {
  const normalized = input.trim().toLowerCase();
  if (normalized.startsWith('hsl')) {
    return 'hsl';
  }
  if (normalized.startsWith('rgb')) {
    return 'rgb';
  }
  return 'hex';
}
