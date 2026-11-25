// Colour normalization for writes. Webflow's native Style API accepts hex and
// rgb()/rgba() but not hsl()/hsla() — it silently drops an hsl* value. So on every
// write we rewrite any hsl()/hsla() in the value to rgb()/rgba() (works natively AND
// in embed CSS, and matches how Webflow stores colours). Only hsl* substrings are
// touched; everything else — including a gradient's angle, positions, and other
// colours — passes through untouched.

// Matches one hsl()/hsla() function. `[^)]*` can't span a nested paren, so an
// hsl(var(--x) …) with an inner function is left alone (returned unchanged below).
const HSL_FUNCTION_RE = /hsla?\(\s*[^)]*\)/gi;

/** Rewrite every hsl()/hsla() colour in a CSS value to rgb()/rgba(). */
export function hslaToRgba(value: string): string {
  if (!value || !/hsl/i.test(value)) {
    return value;
  }
  return value.replace(HSL_FUNCTION_RE, (match) => {
    const inner = match.slice(match.indexOf('(') + 1, -1);
    return convertHsl(inner) ?? match;
  });
}

function convertHsl(inner: string): string | undefined {
  let alpha: string | undefined;
  let body = inner.trim();
  // Modern slash-alpha syntax: `h s l / a`.
  const slash = body.indexOf('/');
  if (slash !== -1) {
    alpha = body.slice(slash + 1).trim();
    body = body.slice(0, slash).trim();
  }

  const parts = body.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) {
    return undefined;
  }
  if (alpha === undefined && parts.length >= 4) {
    alpha = parts[3];
  } // legacy `h, s, l, a`

  const hue = parseHue(parts[0] ?? '');
  const saturation = parsePercent(parts[1] ?? '');
  const lightness = parsePercent(parts[2] ?? '');
  if (hue === undefined || saturation === undefined || lightness === undefined) {
    return undefined;
  }

  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  if (alpha !== undefined) {
    const alphaAmount = parseAlpha(alpha);
    if (alphaAmount === undefined) {
      return undefined;
    }
    if (alphaAmount < 1) {
      return `rgba(${red}, ${green}, ${blue}, ${round(alphaAmount)})`;
    }
  }
  return `rgb(${red}, ${green}, ${blue})`;
}

/** Hue with an optional angle unit → degrees in [0, 360). */
function parseHue(token: string): number | undefined {
  const match = token.match(/^(-?[\d.]+)(deg|grad|rad|turn)?$/i);
  if (!match) {
    return undefined;
  }
  let degrees = parseFloat(match[1] ?? '');
  switch ((match[2] || 'deg').toLowerCase()) {
    case 'grad':
      degrees *= 0.9;
      break;
    case 'rad':
      degrees = (degrees * 180) / Math.PI;
      break;
    case 'turn':
      degrees *= 360;
      break;
  }
  return ((degrees % 360) + 360) % 360;
}

/** Saturation/lightness → 0–1 (a bare 0–100 number is treated as a percentage). */
function parsePercent(token: string): number | undefined {
  const match = token.match(/^(-?[\d.]+)%?$/);
  if (!match) {
    return undefined;
  }
  let fraction = parseFloat(match[1] ?? '');
  if (token.trim().endsWith('%') || fraction > 1) {
    fraction /= 100;
  }
  return Math.max(0, Math.min(1, fraction));
}

/** Alpha as a 0–1 number or a percentage. */
function parseAlpha(token: string): number | undefined {
  const match = token.match(/^(-?[\d.]+)%?$/);
  if (!match) {
    return undefined;
  }
  let fraction = parseFloat(match[1] ?? '');
  if (token.trim().endsWith('%')) {
    fraction /= 100;
  }
  return Math.max(0, Math.min(1, fraction));
}

/** HSL (h 0–360, s/l 0–1) → 8-bit RGB. */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = hue / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  let red = 0,
    green = 0,
    blue = 0;
  if (hp < 1) {
    red = chroma;
    green = x;
  } else if (hp < 2) {
    red = x;
    green = chroma;
  } else if (hp < 3) {
    green = chroma;
    blue = x;
  } else if (hp < 4) {
    green = x;
    blue = chroma;
  } else if (hp < 5) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }
  const offset = lightness - chroma / 2;
  return [Math.round((red + offset) * 255), Math.round((green + offset) * 255), Math.round((blue + offset) * 255)];
}

const round = (value: number) => Math.round(value * 1000) / 1000;
