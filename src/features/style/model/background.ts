import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../../shared/properties/i18n/messageRef';
import { assert } from '../../../../shared/core/assert';
// Multi-layer `background` model. CSS backgrounds are parallel comma-separated
// lists — background-image holds the layers (index 0 = the TOP layer), and
// background-size / -position / -repeat / -attachment hold one entry per layer.
// background-color is a single value painted behind every layer. This module
// parses those longhands into an ordered layer list and serializes it back,
// splitting on TOP-LEVEL commas only (gradients / rgba() have inner commas).

export type LayerKind = 'image' | 'linear' | 'radial' | 'conic' | 'color' | 'other';

export type BgLayer = {
  /** The background-image value for this layer: `url(…)` or a `*-gradient(…)`. */
  image: string;
  /** Per-layer longhands ('' = unset → the CSS initial value). */
  size: string;
  position: string;
  repeat: string;
  attachment: string;
};

export type BackgroundLonghands = {
  image: string;
  size: string;
  position: string;
  repeat: string;
  attachment: string;
};

/** Split on commas that are NOT inside parentheses, brackets or quotes — so
 *  gradients, rgba(), clamp(), grid line names and quoted font families all
 *  survive intact. */
export function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

/** A "color overlay" is a solid-fill layer, expressed in CSS as a linear-gradient
 *  whose stops are all the SAME colour (Webflow's Color-overlay layer type). Returns
 *  that colour, or undefined when the value isn't a solid-colour gradient. */
export function colorOverlayOf(image: string): string | undefined {
  const match = image.trim().match(/^linear-gradient\((.*)\)$/is);
  if (!match) {
    return undefined;
  }
  const parts = splitTopLevelCommas(match[1] ?? '');
  if (!parts.length) {
    return undefined;
  }
  const isDirection = (text: string) => /^to\s/i.test(text.trim()) || /^-?[\d.]+(deg|grad|rad|turn)$/i.test(text.trim());
  const stops = isDirection(parts[0] ?? '') ? parts.slice(1) : parts;
  if (stops.length < 2) {
    return undefined;
  }
  // Strip a trailing stop position (e.g. `#000 0%`, `red 10px`) to compare colours.
  const colours = stops.map((stop) =>
    stop
      .trim()
      .replace(/\s+-?[\d.]+(%|px|em|rem|vw|vh|vmin|vmax)?$/i, '')
      .trim(),
  );
  const first = colours[0];
  return first && colours.every((colour) => colour === first) ? first : undefined;
}

/** Build a color-overlay layer image from a single colour. Matches Webflow's
 *  canonical solid-overlay serialization (explicit 180deg + duplicated stop) so
 *  Webflow's own panel has the best chance of categorizing it as a Color layer. */
export function colorOverlayImage(color: string): string {
  const trimmed = color.trim() || '#000000';
  return `linear-gradient(180deg, ${trimmed}, ${trimmed})`;
}

/** Split on whitespace runs that are NOT inside parentheses, brackets or
 *  quotes. `clamp(4rem, 8vw, 6rem) 2rem` is two tokens, not five. */
export function splitTopLevelSpaces(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  const chars = [...value.trim()];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < chars.length) {
        current += chars[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

const REPEAT_KW = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round']);
const ATTACH_KW = new Set(['scroll', 'fixed', 'local']);
const BOX_KW = new Set(['border-box', 'padding-box', 'content-box']);
const isImageToken = (token: string) => /^(url|(repeating-)?(linear|radial|conic)-gradient)\(/i.test(token) || token.toLowerCase() === 'none';
const isPositionToken = (token: string) => /^(left|right|top|bottom|center)$/i.test(token) || /^-?[\d.]+(px|%|em|rem|vw|vh|vmin|vmax|ch|fr)?$/i.test(token);

/** Parse a `background` shorthand into the five longhands + the (single) color.
 *  Order-tolerant per CSS; a `pos / size` group is split on the top-level slash.
 *  Longhands only some layer sets come back ''; color only from the last layer. */
export function splitBackgroundShorthand(bg: string): BackgroundLonghands & { color: string } {
  const layerTexts = splitTopLevelCommas(bg);
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  const repeats: string[] = [];
  const attachments: string[] = [];
  let color = '';
  layerTexts.forEach((layerText, layerIndex) => {
    const isLastLayer = layerIndex === layerTexts.length - 1;
    const layer = parseBackgroundLayer(layerText, { isLastLayer });
    if (layer.color) {
      color = layer.color;
    }
    // A layer with no image is just the trailing colour — don't emit it as a layer.
    if (!layer.image) {
      if (isLastLayer && !color) {
        color = layer.positionTokens.join(' ').trim();
      }
      return;
    }
    images.push(layer.image || 'none');
    sizes.push(layer.sizeTokens.join(' '));
    positions.push(layer.positionTokens.join(' '));
    repeats.push(layer.repeat);
    attachments.push(layer.attachment);
  });
  const join = (list: string[], initial: string) => (list.some((item) => item.trim()) ? list.map((item) => item.trim() || initial).join(', ') : '');
  return {
    image: images.join(', '),
    size: join(sizes, 'auto'),
    position: join(positions, '0% 0%'),
    repeat: join(repeats, 'repeat'),
    attachment: join(attachments, 'scroll'),
    color,
  };
}

/** One layer as `background` shorthand text: its image, then position / size,
 *  tiling and attachment where set. What the code view of a layer edits. */
export function layerShorthand(layer: BgLayer): string {
  const parts = [layer.image.trim()];
  const position = layer.position.trim();
  const size = layer.size.trim();
  if (size !== '') {
    parts.push(`${position !== '' ? position : '0 0'} / ${size}`);
  } else if (position !== '') {
    parts.push(position);
  }
  for (const part of [layer.repeat, layer.attachment]) {
    if (part.trim() !== '') {
      parts.push(part.trim());
    }
  }
  const text = parts.join(' ');
  assert(text.startsWith(parts[0] ?? ''), 'layerShorthand: the image leads');
  return text;
}

/** The layer a shorthand text describes, or undefined when it names no image
 *  (an empty or colour-only text is not a layer). */
export function parseLayerShorthand(text: string): BgLayer | undefined {
  if (splitTopLevelCommas(text).length !== 1) {
    return undefined; // One layer per code block: a comma here would start a second.
  }
  const tokens = parseBackgroundLayer(text.trim(), { isLastLayer: false });
  if (!tokens.image) {
    return undefined;
  }
  return {
    image: tokens.image,
    size: tokens.sizeTokens.join(' '),
    position: tokens.positionTokens.join(' '),
    repeat: tokens.repeat,
    attachment: tokens.attachment,
  };
}

type BackgroundLayerTokens = {
  image: string;
  repeat: string;
  attachment: string;
  positionTokens: string[];
  sizeTokens: string[];
  /** The leftover token that names the background colour ('' when none). */
  color: string;
};

// Sort one layer's tokens into its longhands. Only the LAST layer may carry the colour.
function parseBackgroundLayer(layerText: string, options: { readonly isLastLayer: boolean }): BackgroundLayerTokens {
  // Normalize `a / b` (with or without spaces around the slash) into tokens.
  const tokens = splitTopLevelSpaces(layerText.replace(/\s*\/\s*/g, ' / '));
  const layer: BackgroundLayerTokens = {
    image: '',
    repeat: '',
    attachment: '',
    positionTokens: [],
    sizeTokens: [],
    color: '',
  };
  let afterSlash = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (token === '/') {
      afterSlash = true;
    } else if (isImageToken(token)) {
      layer.image = token;
    } else if (REPEAT_KW.has(lower)) {
      layer.repeat = layer.repeat ? `${layer.repeat} ${lower}` : lower;
    } else if (ATTACH_KW.has(lower)) {
      layer.attachment = lower;
    } else if (BOX_KW.has(lower)) {
      // Origin / clip — not modeled here.
    } else if (afterSlash) {
      layer.sizeTokens.push(token);
    } else if (isPositionToken(token)) {
      layer.positionTokens.push(token);
    } else if (options.isLastLayer) {
      // A leftover (non-position) token in the LAST layer is the background-color
      // (covers named colours like `white` too, without a colour lookup table).
      layer.color = token;
    } else {
      layer.positionTokens.push(token); // best effort for a stray token in a non-final layer
    }
  }
  return layer;
}

/** Which kind of layer an image value is, from its function/keyword. */
export function layerKind(image: string): LayerKind {
  const normalized = image.trim().toLowerCase();
  if (normalized.startsWith('url(')) {
    return 'image';
  }
  if (colorOverlayOf(image) !== undefined) {
    return 'color';
  }
  if (normalized.startsWith('linear-gradient') || normalized.startsWith('repeating-linear-gradient')) {
    return 'linear';
  }
  if (normalized.startsWith('radial-gradient') || normalized.startsWith('repeating-radial-gradient')) {
    return 'radial';
  }
  if (normalized.startsWith('conic-gradient') || normalized.startsWith('repeating-conic-gradient')) {
    return 'conic';
  }
  return 'other';
}

/** The file name inside a `url(…)`, or undefined when the value isn't a url(). */
export function urlFileName(image: string): string | undefined {
  const match = image.match(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/i);
  if (!match) {
    return undefined;
  }
  const path = (match[1] ?? '').split('?')[0] ?? '';
  const file = path.split(/[\\/]/).pop() ?? path;
  return file || path;
}

/** A short human label for a layer (Webflow-style). */
export function layerLabel(image: string, translate: Translator = ENGLISH_TRANSLATE): string {
  switch (layerKind(image)) {
    case 'image':
      return urlFileName(image) ?? translate('styleModel.background.layer.image');
    case 'color':
      return colorOverlayOf(image) ?? translate('styleModel.background.layer.colorOverlay');
    case 'linear':
      return translate('styleModel.background.layer.linear');
    case 'radial':
      return translate('styleModel.background.layer.radial');
    case 'conic':
      return translate('styleModel.background.layer.conic');
    case 'other':
      return image.trim() || translate('styleModel.background.layer.other');
  }
}

/** Parse the five longhands into an ordered layer list (top layer first). */
export function parseLayers(props: BackgroundLonghands): BgLayer[] {
  const images = props.image.trim() ? splitTopLevelCommas(props.image) : [];
  // `none` (the initial value, or an explicit reset) means there are no layers.
  const cleaned = images.filter((img) => img && img.toLowerCase() !== 'none');
  if (!cleaned.length) {
    return [];
  }
  const sizes = props.size.trim() ? splitTopLevelCommas(props.size) : [];
  const positions = props.position.trim() ? splitTopLevelCommas(props.position) : [];
  const repeats = props.repeat.trim() ? splitTopLevelCommas(props.repeat) : [];
  const attachments = props.attachment.trim() ? splitTopLevelCommas(props.attachment) : [];
  return cleaned.map((image, i) => ({
    image,
    size: sizes[i] ?? '',
    position: positions[i] ?? '',
    repeat: repeats[i] ?? '',
    attachment: attachments[i] ?? '',
  }));
}

// CSS initial values used to pad a longhand list when only SOME layers set it
// (the list must stay index-aligned with background-image).
const INITIAL = {
  size: 'auto',
  position: '0% 0%',
  repeat: 'repeat',
  attachment: 'scroll',
} as const;

/** Serialize a layer list back to the five longhands. A longhand only every layer
 *  leaves unset comes back '' (→ clear the property); otherwise it's the full
 *  comma list, padding unset layers with the CSS initial so indexes line up. */
export function serializeLayers(layers: BgLayer[]): BackgroundLonghands {
  if (!layers.length) {
    return { image: '', size: '', position: '', repeat: '', attachment: '' };
  }
  const list = (key: 'size' | 'position' | 'repeat' | 'attachment'): string =>
    layers.some((layer) => layer[key].trim()) ? layers.map((layer) => layer[key].trim() || INITIAL[key]).join(', ') : '';
  return {
    image: layers.map((layer) => layer.image.trim()).join(', '),
    size: list('size'),
    position: list('position'),
    repeat: list('repeat'),
    attachment: list('attachment'),
  };
}

/** A blank layer of the given kind, seeded with a sensible template. */
export function blankLayer(kind: LayerKind): BgLayer {
  const image =
    kind === 'linear'
      ? 'linear-gradient(180deg, #000000, #ffffff)'
      : kind === 'radial'
        ? 'radial-gradient(circle, #000000, #ffffff)'
        : kind === 'conic'
          ? 'conic-gradient(from 0deg, #000000, #ffffff)'
          : kind === 'color'
            ? colorOverlayImage('rgba(0, 0, 0, 0.5)')
            : 'url()';
  return { image, size: '', position: '', repeat: '', attachment: '' };
}
