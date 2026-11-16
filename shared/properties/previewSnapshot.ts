// What a component preview is made of once it has been rendered: a snapshot (the rendered markup with
// only the CSS it uses), the key that says when it is out of date, the message the preview page posts to
// hand it over, and the arithmetic that fits it into a tile. Everything here is pure: the dev server's
// route, the palette and Studio all use the same functions, so a key computed in one is the key read in
// another.
//
// Why a snapshot and not a live frame per tile: a live frame runs a whole render of the component on the
// dev server each time it loads. Scrolling a tile out of view used to unmount it and scrolling back reloaded
// it, which is the flicker. A snapshot is rendered once, kept, and shown without any server.

import { assert } from '../core/assert';

/** Bounds of a snapshot, stated once: the page enforces them while capturing, the parser again on arrival. */
export const PREVIEW_SNAPSHOT_LIMITS = {
  /** The attempt labels a page reports (previewAttemptLabels), so a message names one of a few words. */
  attemptsMax: 4,
  /** One snapshot's markup. A cache policy, not a limit on any project file: a larger render is shown live instead. */
  htmlCharsMax: 3_000_000,
  /** A rendered box's side, in CSS pixels; a stage cannot be wider than the 1200 px layout, but may be tall. */
  boxPixelsMax: 100_000,
  /** Characters of a key: two 53-bit hashes in hexadecimal. */
  keyChars: 28,
  reasonCharsMax: 500,
} as const;

/** The order a page tries to render a component in; the first that renders wins. */
export const PREVIEW_ATTEMPT_LABELS = ['authored', 'sample', 'sample-minimal', 'sample-bare'] as const;
export type PreviewAttemptLabel = (typeof PREVIEW_ATTEMPT_LABELS)[number];

/**
 * A 106-bit hash of text, 28 hexadecimal characters. Not cryptographic: it names a version of a file for a
 * cache, where a collision costs one stale tile and nothing else. Two independent cyrb53 passes; it needs no
 * platform hashing, so the browser and Node agree on it.
 */
export function hashText(text: string): string {
  assert(typeof text === 'string', 'hashText: expected a string');
  const first = cyrb53(text, 0x9e3779b9);
  const second = cyrb53(text, 0x85ebca6b);
  const result = first.toString(16).padStart(14, '0') + second.toString(16).padStart(14, '0');
  assert(result.length === PREVIEW_SNAPSHOT_LIMITS.keyChars, 'hashText: a hash is a fixed width');
  return result;
}

function cyrb53(text: string, seed: number): number {
  let high = 0xdeadbeef ^ seed;
  let low = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return 4294967296 * (2097151 & low) + (high >>> 0);
}

/** Bump when the snapshot's shape or what it captures changes, so every older snapshot is rendered again. */
export const PREVIEW_SNAPSHOT_VERSION = 'snapshot-1';

/** Everything that changes what a component's preview looks like. A part that is absent is hashed as empty. */
export interface SnapshotKeyParts {
  /** The component's own source. */
  readonly source: string;
  /** The sources of the files it imports (components, types, data), in a stable order. */
  readonly dependencies: readonly string[];
  /** The project's global styles and page context: what `virtual:stacki-component-preview-context` carries. */
  readonly styles: string;
  /** The insertion recipe and the instance the preview samples, serialised. */
  readonly inputs: string;
  /** The project's theme: the attributes the preview puts on `<html>` and `<body>`. */
  readonly theme: string;
}

/** The key of a snapshot: equal parts give an equal key, and any part that differs gives another. */
export function snapshotKey(parts: SnapshotKeyParts): string {
  assert(parts.dependencies.length <= 4096, 'snapshotKey: dependencies are bounded');
  const key = hashText(
    [
      PREVIEW_SNAPSHOT_VERSION,
      hashText(parts.source),
      // Length-prefixed so that moving text from one dependency to the next cannot give the same key.
      hashText(parts.dependencies.map((dependency) => `${dependency.length}:${hashText(dependency)}`).join('|')),
      hashText(parts.styles),
      hashText(parts.inputs),
      hashText(parts.theme),
    ].join('/'),
  );
  assert(isSnapshotKey(key), 'snapshotKey: a key is well formed');
  return key;
}

export function isSnapshotKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{28}$/.test(value);
}

/**
 * Whether rendered markup holds nothing but the component's own name: the preview route puts the name in
 * the component's slot when it has nothing better, and a component that only wraps its slot then draws just
 * that word. That is a failed render, not a preview. Markup with no text at all is not this case (it is empty).
 *
 * Emitted into the generated preview page with `toString()`, so it uses no outside names.
 */
export function previewRendersOnlyName(markup: string, name: string): boolean {
  if (typeof markup !== 'string' || typeof name !== 'string') {
    throw new Error('previewRendersOnlyName: expected strings');
  }
  const body = markup.replace(/<(script|style|template|noscript)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  // A picture, a control or a frame is content, whatever words come with it.
  if (/<(img|svg|video|canvas|picture|iframe|object|embed|input|textarea|select|hr)\b/i.test(body)) {
    return false;
  }
  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[#\w]+;/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (text === '') {
    return false;
  }
  return text === name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** A snapshot as the preview page hands it over (`avb:component-preview-snapshot`). */
export interface PreviewSnapshotMessage {
  readonly key: string;
  /** The stage's markup with the CSS it uses; never scripts. */
  readonly html: string;
  /** The rendered box inside the 1200 px stage: where it starts and how big it is, in CSS pixels. */
  readonly box: SnapshotBox;
  readonly attempt: PreviewAttemptLabel;
}

export interface SnapshotBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The page's answer to a request that named the key it already holds, and the key has not moved. */
export interface PreviewUnchangedMessage {
  readonly key: string;
}

export function parsePreviewSnapshotMessage(input: unknown): PreviewSnapshotMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:component-preview-snapshot') {
    return undefined;
  }
  const key = 'key' in input ? input.key : undefined;
  const html = 'html' in input ? input.html : undefined;
  const box = 'box' in input ? parseBox(input.box) : undefined;
  const attempt = 'attempt' in input ? parseAttempt(input.attempt) : undefined;
  if (!isSnapshotKey(key) || typeof html !== 'string' || box === undefined || attempt === undefined) {
    return undefined;
  }
  if (html.length === 0 || html.length > PREVIEW_SNAPSHOT_LIMITS.htmlCharsMax) {
    return undefined;
  }
  return { key, html, box, attempt };
}

export function parsePreviewUnchangedMessage(input: unknown): PreviewUnchangedMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:component-preview-unchanged') {
    return undefined;
  }
  const key = 'key' in input ? input.key : undefined;
  return isSnapshotKey(key) ? { key } : undefined;
}

function parseAttempt(input: unknown): PreviewAttemptLabel | undefined {
  return PREVIEW_ATTEMPT_LABELS.find((label) => label === input);
}

function parseBox(input: unknown): SnapshotBox | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const left = 'left' in input ? input.left : undefined;
  const top = 'top' in input ? input.top : undefined;
  const width = 'width' in input ? input.width : undefined;
  const height = 'height' in input ? input.height : undefined;
  if (typeof left !== 'number' || typeof top !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return undefined;
  }
  const max = PREVIEW_SNAPSHOT_LIMITS.boxPixelsMax;
  const finite = [left, top, width, height].every((value) => Number.isFinite(value) && Math.abs(value) <= max);
  if (!finite || width < 1 || height < 1) {
    return undefined;
  }
  return { left, top, width, height };
}

/** The padding around a snapshot inside its tile, in CSS pixels: the same 12 px the live preview page leaves. */
export const SNAPSHOT_TILE_PADDING = 12;

export interface SnapshotFit {
  readonly scale: number;
  /** Where the snapshot's top-left corner sits in the tile, after scaling. */
  readonly x: number;
  readonly y: number;
}

/**
 * Where a snapshot sits in a tile: shrunk (never enlarged) to fit inside the padding and centred. The live
 * preview page does the same sum for its popup layout, so a snapshot and a live frame agree.
 */
export function fitSnapshot(box: SnapshotBox, tile: { readonly width: number; readonly height: number }): SnapshotFit {
  assert(box.width >= 1, 'fitSnapshot: the box has width');
  assert(box.height >= 1, 'fitSnapshot: the box has height');
  const availableWidth = Math.max(1, tile.width - SNAPSHOT_TILE_PADDING * 2);
  const availableHeight = Math.max(1, tile.height - SNAPSHOT_TILE_PADDING * 2);
  const scale = Math.min(1, availableWidth / box.width, availableHeight / box.height);
  const x = SNAPSHOT_TILE_PADDING + (availableWidth - box.width * scale) / 2;
  const y = SNAPSHOT_TILE_PADDING + (availableHeight - box.height * scale) / 2;
  assert(scale > 0, 'fitSnapshot: the scale is positive');
  assert(scale <= 1, 'fitSnapshot: a snapshot is never enlarged');
  return { scale, x, y };
}
