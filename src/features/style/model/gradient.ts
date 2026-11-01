// Parse / serialize a CSS gradient function into a structured model so the
// Backgrounds panel can offer Webflow's visual gradient editor (position grid,
// size presets, a draggable stops bar, a repeat toggle) instead of raw CSS text.
//
// Handles (repeating-)linear / radial / conic gradients. Anything it can't parse
// stays editable as raw text (the caller falls back), so this never has to be
// exhaustive — just faithful for the shapes Webflow emits.

import { splitTopLevelCommas, splitTopLevelSpaces } from './background';

export type GradientType = 'linear' | 'radial' | 'conic';

/** One color stop: a color plus an optional position (`''` = auto/unspecified). */
export type GradientStop = { color: string; pos: string };

export type Gradient = {
  type: GradientType;
  repeating: boolean;
  /** linear: `180deg` / `to bottom` (`''` = default top→bottom). */
  angle: string;
  /** radial: `circle` | `ellipse` (`''` = ellipse, the CSS default). */
  shape: string;
  /** radial: `closest-side` | `closest-corner` | `farthest-side` | `farthest-corner`
   *  or an explicit length/`%` (`''` = farthest-corner, the CSS default). */
  size: string;
  /** conic: `from 45deg` angle value without the keyword (`''` = 0deg). */
  from: string;
  /** radial/conic center — `''` treated as `50%` (center). */
  posX: string;
  posY: string;
  stops: GradientStop[];
};
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4); the
// type and the stop list change only through their own paths.
export type GradientPatch =
  | Pick<Gradient, 'angle'>
  | Pick<Gradient, 'from'>
  | Pick<Gradient, 'posX'>
  | Pick<Gradient, 'posY'>
  | Pick<Gradient, 'posX' | 'posY'>
  | Pick<Gradient, 'repeating'>
  | Pick<Gradient, 'size'>;
export type GradientStopPatch = Pick<GradientStop, 'color'> | Pick<GradientStop, 'pos'>;

const GRADIENT_RE = /^(repeating-)?(linear|radial|conic)-gradient\s*\(([\s\S]*)\)\s*$/i;
const RADIAL_SIZE_KW = new Set(['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner']);
const isAngle = (token: string) => /^-?[\d.]+(deg|grad|rad|turn)$/i.test(token.trim());
const isLength = (token: string) => /^-?[\d.]+(px|%|em|rem|vw|vh|vmin|vmax|ch|fr)?$/i.test(token.trim());
const POSITION_KEYWORDS: Record<string, string> = {
  left: '0%',
  right: '100%',
  top: '0%',
  bottom: '100%',
  center: '50%',
};

/** Map a position keyword/length to a percentage string (best effort). */
function positionValue(token: string): string {
  const normalized = token.trim().toLowerCase();
  return POSITION_KEYWORDS[normalized] ?? token.trim();
}

/** Parse `x y` (or a single value → x, y=center) into { posX, posY }. */
function parseCenter(text: string): { posX: string; posY: string } {
  const toks = splitTopLevelSpaces(text);
  if (!toks.length) {
    return { posX: '', posY: '' };
  }
  if (toks.length === 1) {
    const first = toks[0] ?? '';
    const position = positionValue(first);
    // A lone vertical keyword sets Y; anything else sets X (center the other axis).
    if (/^(top|bottom)$/i.test(first)) {
      return { posX: '50%', posY: position };
    }
    return { posX: position, posY: '50%' };
  }
  return { posX: positionValue(toks[0] ?? ''), posY: positionValue(toks[1] ?? '') };
}

/** Split one stop into color + optional trailing position (handles rgba()/color-mix). */
function parseStop(part: string): GradientStop {
  const toks = splitTopLevelSpaces(part);
  if (toks.length > 1 && isLength(toks[toks.length - 1] ?? '')) {
    return { pos: toks.pop() ?? '', color: toks.join(' ') };
  }
  return { color: toks.join(' '), pos: '' };
}

/** Is the first comma-group a prelude (direction/shape/size/position) vs a color stop? */
function isPrelude(type: GradientType, part: string): boolean {
  const normalized = part.trim().toLowerCase();
  if (type === 'linear') {
    return normalized.startsWith('to ') || isAngle(normalized);
  }
  if (type === 'conic') {
    return normalized.startsWith('from ') || normalized.startsWith('at ');
  }
  // radial: shape / size keyword / explicit size / an `at <pos>`.
  //
  // EVERY token has to look like geometry, not just one of them. A colour stop
  // carries a position — `red 0%` — and `0%` on its own reads as a radial
  // size, so testing whether ANY token looked like geometry swallowed the
  // first stop as though it were a prelude. On a two-stop gradient that left
  // one stop, which is not a gradient, and the whole thing came back
  // unparseable: `radial-gradient(red 0%, blue 100%)` — ordinary, valid CSS —
  // could not be read by the editor at all.
  if (normalized.startsWith('circle') || normalized.startsWith('ellipse') || normalized.includes(' at ') || normalized.startsWith('at ')) {
    return true;
  }
  if (RADIAL_SIZE_KW.has(normalized)) {
    return true;
  }
  const tokens = splitTopLevelSpaces(normalized);
  return tokens.length > 0 && tokens.every((token) => RADIAL_SIZE_KW.has(token.toLowerCase()) || isLength(token));
}

export function parseGradient(image: string): Gradient | undefined {
  const match = GRADIENT_RE.exec(image.trim());
  if (!match) {
    return undefined;
  }
  const typeText = (match[2] ?? '').toLowerCase();
  if (typeText !== 'linear' && typeText !== 'radial' && typeText !== 'conic') {
    return undefined;
  }
  const type: GradientType = typeText;
  const parts = splitTopLevelCommas(match[3] ?? '').filter((part) => part.length);
  if (!parts.length) {
    return undefined;
  }
  const hasPrelude = isPrelude(type, parts[0] ?? '');
  const geometry = hasPrelude ? parsePrelude(type, parts[0] ?? '') : {};
  const rest = hasPrelude ? parts.slice(1) : parts;
  const stops = rest.map(parseStop).filter((stop) => stop.color);
  if (stops.length < 2) {
    return undefined;
  } // not a usable gradient
  return { ...blankGradientOf(type), repeating: !!match[1], ...geometry, stops };
}

type Geometry = Partial<Pick<Gradient, 'angle' | 'shape' | 'size' | 'from' | 'posX' | 'posY'>>;

// The geometry a prelude spells: a linear angle, a conic `from … at …`, or a radial
// `<shape?> <size?> at <pos?>`. Fields it doesn't mention are left out.
function parsePrelude(type: GradientType, prelude: string): Geometry {
  const trimmed = prelude.trim();
  if (type === 'linear') {
    return { angle: trimmed };
  }
  const at = trimmed.split(/\bat\b/i);
  const center = at[1] ? parseCenter(at[1]) : {};
  if (type === 'conic') {
    const fromPart = (at[0] ?? '').replace(/^from\s+/i, '').trim();
    return { ...(fromPart ? { from: fromPart } : {}), ...center };
  }
  let shape = '';
  let size = '';
  for (const token of splitTopLevelSpaces(at[0] ?? '')) {
    const lower = token.toLowerCase();
    if (lower === 'circle' || lower === 'ellipse') {
      shape = lower;
    } else if (RADIAL_SIZE_KW.has(lower) || isLength(token)) {
      size = size ? `${size} ${token}` : token;
    }
  }
  return { shape, size, ...center };
}

/** The effective center as percentages (defaults to 50%/50% = center). */
export function gradientCenter(gradient: Gradient): { x: string; y: string } {
  return { x: gradient.posX.trim() || '50%', y: gradient.posY.trim() || '50%' };
}

function radialPrelude(gradient: Gradient): string {
  const shapeSize = [gradient.shape.trim(), gradient.size.trim()].filter(Boolean).join(' ');
  const x = gradient.posX.trim();
  const y = gradient.posY.trim();
  // Emit `at x y` only when the center isn't the default center.
  const centered = (!x || x === '50%') && (!y || y === '50%');
  const at = centered ? '' : `at ${x || '50%'} ${y || '50%'}`;
  return [shapeSize, at].filter(Boolean).join(' ');
}

function conicPrelude(gradient: Gradient): string {
  const from = gradient.from.trim() ? `from ${gradient.from.trim()}` : '';
  const x = gradient.posX.trim();
  const y = gradient.posY.trim();
  const centered = (!x || x === '50%') && (!y || y === '50%');
  const at = centered ? '' : `at ${x || '50%'} ${y || '50%'}`;
  return [from, at].filter(Boolean).join(' ');
}

/**
 * A gradient of `type` with no colours and no geometry set.
 *
 * Used when switching a layer between gradient kinds: the stops carry over,
 * the geometry does not. An angle is a direction for a linear gradient and
 * means nothing to a radial one; a centre point is the other way round. So each
 * kind starts on its own CSS defaults — every field `''` — and the caller puts
 * the colours back.
 */
export function blankGradientOf(type: GradientType): Gradient {
  return {
    type,
    repeating: false,
    angle: '',
    shape: '',
    size: '',
    from: '',
    posX: '',
    posY: '',
    stops: [],
  };
}

export function serializeGradient(gradient: Gradient): string {
  const functionName = `${gradient.repeating ? 'repeating-' : ''}${gradient.type}-gradient`;
  const prelude = gradient.type === 'linear' ? gradient.angle.trim() : gradient.type === 'radial' ? radialPrelude(gradient) : conicPrelude(gradient);
  const stops = gradient.stops.map((stop) => (stop.pos.trim() ? `${stop.color.trim()} ${stop.pos.trim()}` : stop.color.trim())).join(', ');
  return `${functionName}(${prelude ? `${prelude}, ` : ''}${stops})`;
}

/** A horizontal CSS gradient string previewing the stops (for the editor bar). */
export function stopsBarCss(stops: GradientStop[]): string {
  if (stops.length < 2) {
    return 'transparent';
  }
  const parts = stops.map((stop, i) => {
    const position = stop.pos.trim() || `${Math.round((i / (stops.length - 1)) * 100)}%`;
    return `${stop.color.trim() || 'transparent'} ${position}`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** A stop's numeric position (0–100), inferring evenly-spaced when unset. */
export function stopPercent(stops: GradientStop[], i: number): number {
  const raw = stops[i]?.pos.trim();
  const match = raw ? /^(-?[\d.]+)%$/.exec(raw) : undefined;
  if (match) {
    return Math.max(0, Math.min(100, parseFloat(match[1] ?? '')));
  }
  return stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0;
}

// ── Angle in degrees (for the dial) ────────────────────────────────────────────

// A linear gradient's angle keyword → degrees (CSS: 0 = up, 90 = right, 180 = down),
// keyed by the side words sorted alphabetically so `to top right` == `to right top`.
const SIDE_DEG: Record<string, number> = {
  top: 0,
  right: 90,
  bottom: 180,
  left: 270,
  'right top': 45,
  'bottom right': 135,
  'bottom left': 225,
  'left top': 315,
};

/** A linear gradient's direction in degrees (defaults to 180 = top→bottom, per CSS). */
export function angleToDegrees(angle: string): number {
  const normalized = angle.trim().toLowerCase();
  if (!normalized) {
    return 180;
  }
  const match = normalized.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/);
  if (match) {
    const amount = parseFloat(match[1] ?? '');
    switch (match[2]) {
      case 'turn':
        return amount * 360;
      case 'grad':
        return amount * 0.9;
      case 'rad':
        return (amount * 180) / Math.PI;
      case 'deg':
        return amount;
      case undefined:
        return amount;
    }
  }
  if (normalized.startsWith('to ')) {
    const sides = normalized.slice(3).trim().split(/\s+/).filter(Boolean).sort().join(' ');
    return SIDE_DEG[sides] ?? 180;
  }
  return 180;
}

/** Degrees → a normalized `<n>deg` string (0–359). */
export function degreesToAngle(deg: number): string {
  return `${((Math.round(deg) % 360) + 360) % 360}deg`;
}

// ── Colour interpolation (inserting a stop between two others) ──────────────────

type RGBA = [number, number, number, number];

/** Parse a hex or rgb()/rgba() colour to RGBA; undefined for names/var()/hsl (no mix). */
function parseColor(input: string): RGBA | undefined {
  const normalized = input.trim().toLowerCase();
  const hex = normalized.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let hexDigits = hex[1] ?? '';
    if (hexDigits.length === 3 || hexDigits.length === 4) {
      hexDigits = hexDigits
        .split('')
        .map((x) => x + x)
        .join('');
    }
    if (hexDigits.length === 6) {
      hexDigits += 'ff';
    }
    if (hexDigits.length !== 8) {
      return undefined;
    }
    return [
      parseInt(hexDigits.slice(0, 2), 16),
      parseInt(hexDigits.slice(2, 4), 16),
      parseInt(hexDigits.slice(4, 6), 16),
      parseInt(hexDigits.slice(6, 8), 16) / 255,
    ];
  }
  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = (rgb[1] ?? '').split(',').map((part) => parseFloat(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((channel) => Number.isNaN(channel))) {
      return undefined;
    }
    const [red = 0, green = 0, blue = 0, alpha] = parts;
    return [red, green, blue, alpha === undefined || Number.isNaN(alpha) ? 1 : alpha];
  }
  return undefined;
}

function formatColor([red, green, blue, alpha]: RGBA): string {
  const hx = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, '0');
  if (alpha >= 1) {
    return `#${hx(red)}${hx(green)}${hx(blue)}`;
  }
  const channels = `${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}`;
  return `rgba(${channels}, ${Math.round(alpha * 100) / 100})`;
}

/** Mix two colours (t in 0–1). Falls back to `a` when either can't be parsed. */
export function mixColors(left: string, right: string, amount: number): string {
  const leftColor = parseColor(left);
  const rightColor = parseColor(right);
  if (!leftColor || !rightColor) {
    return left;
  }
  return formatColor([
    leftColor[0] + (rightColor[0] - leftColor[0]) * amount,
    leftColor[1] + (rightColor[1] - leftColor[1]) * amount,
    leftColor[2] + (rightColor[2] - leftColor[2]) * amount,
    leftColor[3] + (rightColor[3] - leftColor[3]) * amount,
  ]);
}

/** The interpolated colour of the ramp at percentage `p` (0–100) — for a new stop. */
export function colorAt(stops: GradientStop[], percent: number): string {
  if (!stops.length) {
    return 'transparent';
  }
  const last = stops.length - 1;
  const percents = stops.map((_, i) => stopPercent(stops, i));
  const firstStop = stops[0];
  const lastStop = stops[last];
  if (firstStop === undefined || lastStop === undefined) {
    throw new Error('Gradient stop invariant failed');
  }
  if (percent <= (percents[0] ?? 0)) {
    return firstStop.color;
  }
  if (percent >= (percents[last] ?? 100)) {
    return lastStop.color;
  }
  for (let i = 0; i < last; i += 1) {
    const leftPercent = percents[i];
    const rightPercent = percents[i + 1];
    const leftStop = stops[i];
    const rightStop = stops[i + 1];
    if (leftPercent === undefined || rightPercent === undefined) {
      continue;
    }
    if (leftStop === undefined || rightStop === undefined) {
      continue;
    }
    if (percent >= leftPercent && percent <= rightPercent) {
      const span = rightPercent - leftPercent;
      return mixColors(leftStop.color, rightStop.color, span === 0 ? 0 : (percent - leftPercent) / span);
    }
  }
  return lastStop.color;
}
