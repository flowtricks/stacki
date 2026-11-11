// The cursor a canvas frame shows while a Stacki app captures canvas clicks
// (src/features/apps/useCanvasCapture.ts): a crosshair says the next click
// places something rather than selects. The editor says so with
// `{ type: 'avb:app-cursor', cursor }`, where `cursor` is `'crosshair'`,
// `'default'`, `'none'` (the editor's own cursor back) or an app's own image,
// `{ url, hotspot: { x, y } }`: a PNG or SVG data URL the editor already read
// from the app's bundle and checked (src/features/apps/appCursorImage.ts). The
// frame checks it again, since it trusts no message's shape, and falls back to
// the crosshair where the image cannot be drawn. Desktop's preload
// (frameQueries.ts) and Studio's preview client both hand host messages here.
const STYLE_ID = 'avb-app-cursor-style';

/** A data URL past this is not one the editor sends: a 4 KiB image, base64-encoded, with its prefix. */
const CURSOR_URL_CHARS_MAX = 6000;
/** Browsers draw cursor images up to 32 pixels a side; the hotspot lies within that. */
const CURSOR_PX_MAX = 32;
const CURSOR_URL_PATTERN = /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Applies an app cursor message; false when the message is not one. */
export function receiveAppCursor(data: unknown): boolean {
  if (typeof data !== 'object' || !data || Reflect.get(data, 'type') !== 'avb:app-cursor') {
    return false;
  }
  const value = cursorValue(Reflect.get(data, 'cursor'));
  if (value === undefined) {
    return true; // Ours, but malformed: the cursor stays as it is.
  }
  document.getElementById(STYLE_ID)?.remove();
  if (value !== 'none') {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Over every element, links and text included: a capture click never follows or selects them.
    style.textContent = `html, html * { cursor: ${value} !important; }`;
    (document.head ?? document.documentElement).appendChild(style);
  }
  return true;
}

// The CSS cursor value for a message's cursor, or undefined when it is none the editor sends.
function cursorValue(cursor: unknown): string | undefined {
  if (cursor === 'crosshair' || cursor === 'default' || cursor === 'none') {
    return cursor;
  }
  if (typeof cursor !== 'object' || cursor === null) {
    return undefined;
  }
  const url: unknown = Reflect.get(cursor, 'url');
  const hotspot: unknown = Reflect.get(cursor, 'hotspot');
  if (typeof url !== 'string' || url.length > CURSOR_URL_CHARS_MAX || !CURSOR_URL_PATTERN.test(url)) {
    return undefined;
  }
  if (typeof hotspot !== 'object' || hotspot === null) {
    return undefined;
  }
  const x = pixelOf(Reflect.get(hotspot, 'x'));
  const y = pixelOf(Reflect.get(hotspot, 'y'));
  if (x === undefined || y === undefined) {
    return undefined;
  }
  // The pattern admits no quote, so the URL cannot leave its string.
  return `url("${url}") ${x} ${y}, crosshair`;
}

function pixelOf(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    return undefined;
  }
  return input >= 0 && input < CURSOR_PX_MAX ? input : undefined;
}
