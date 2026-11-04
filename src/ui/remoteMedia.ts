// What an external media value can preview as, and the exact URL to load.
//
// The Settings panel's src card shows a thumbnail for values the project does
// not hold ("https://cdn.site.com/hero.webm"). Only a small, explicit set of
// schemes may load into the editor's own document: http and https (a
// protocol-relative "//host/x.png" is read as https), data: URLs that declare
// an image type, and blob: URLs. Everything else — javascript:, file:, a
// data:text/html payload — is "unknown" and the card keeps its generic icon.
// The URL is parsed with `URL`, never matched by prefix, so a value cannot
// smuggle a scheme past the check with whitespace or odd casing.

import { assert } from '../../shared/core/assert';

export type RemoteMediaHint = 'image' | 'video' | 'audio' | 'asset';

export type RemoteMedia =
  { readonly kind: 'image'; readonly source: string } | { readonly kind: 'video'; readonly source: string } | { readonly kind: 'unknown' };

export const REMOTE_MEDIA_LIMITS = {
  // A field value longer than this is not previewed. Inline data: images are
  // the long case; two megabytes of text covers any thumbnail-sized image a
  // page would sensibly inline, and keeps one field from handing the decoder
  // an arbitrarily large payload on every render.
  urlLengthMax: 2 * 1024 * 1024,
} as const satisfies Record<string, number>;

// Where a paused video is parked so Chromium decodes and paints one frame.
// Without a start time the element stays blank until playback begins.
export const VIDEO_FRAME_SECONDS = 0.1;

const VIDEO_PATH = /\.(mp4|webm|mov|m4v|ogv)$/i;
// Ogg is a container for either; a field that says it holds audio keeps it.
const OGG_PATH = /\.ogg$/i;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const AUDIO_PATH = /\.(mp3|wav|m4a|aac|flac|oga)$/i;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;

/** Classifies an external value for preview; `unknown` loads nothing. */
export function classifyRemoteMedia(value: string, hint: RemoteMediaHint): RemoteMedia {
  const text = value.trim();
  if (text.length === 0) {
    return { kind: 'unknown' };
  }
  if (text.length > REMOTE_MEDIA_LIMITS.urlLengthMax) {
    return { kind: 'unknown' };
  }
  const url = parseAbsoluteURL(text.startsWith('//') ? `https:${text}` : text);
  if (url === undefined) {
    return { kind: 'unknown' };
  }
  const media = mediaForURL(url, hint);
  assertAllowedSource(media);
  return media;
}

/** The poster a video may show instead of a seeked frame: an allowed image or nothing. */
export function remotePosterSource(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const media = classifyRemoteMedia(value, 'image');
  if (media.kind === 'image') {
    return media.source;
  }
  return undefined;
}

function parseAbsoluteURL(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    // Relative paths, bare words and malformed URLs are not external media.
    return undefined;
  }
}

function mediaForURL(url: URL, hint: RemoteMediaHint): RemoteMedia {
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return mediaForPath(url, hint);
    case 'data:':
      // An image data: URL is inert in an <img>: SVG there runs no script.
      if (DATA_IMAGE.test(url.href)) {
        return { kind: 'image', source: url.href };
      }
      return { kind: 'unknown' };
    case 'blob:':
      // A blob: URL names no type; the field's own kind is the only hint.
      if (hint === 'video') {
        return { kind: 'video', source: videoFrameSource(url) };
      }
      if (hint === 'audio') {
        return { kind: 'unknown' };
      }
      return { kind: 'image', source: url.href };
    default:
      return { kind: 'unknown' };
  }
}

// An http(s) URL is classified by its path's extension first, so a video
// value previews as a video whatever field it sits in. A path without a
// known extension (a CDN transform URL) falls back to the field's kind.
function mediaForPath(url: URL, hint: RemoteMediaHint): RemoteMedia {
  const path = url.pathname;
  if (VIDEO_PATH.test(path)) {
    return { kind: 'video', source: videoFrameSource(url) };
  }
  if (OGG_PATH.test(path)) {
    if (hint === 'audio') {
      return { kind: 'unknown' };
    }
    return { kind: 'video', source: videoFrameSource(url) };
  }
  if (IMAGE_PATH.test(path)) {
    return { kind: 'image', source: url.href };
  }
  if (AUDIO_PATH.test(path)) {
    return { kind: 'unknown' };
  }
  switch (hint) {
    case 'video':
      return { kind: 'video', source: videoFrameSource(url) };
    case 'audio':
      return { kind: 'unknown' };
    case 'image':
    case 'asset':
      return { kind: 'image', source: url.href };
    default: {
      const exhaustive: never = hint;
      return exhaustive;
    }
  }
}

// A media fragment replaces any fragment the value carried; it never reaches
// the server, so the request is the same one the page itself makes.
function videoFrameSource(url: URL): string {
  const framed = new URL(url.href);
  framed.hash = `t=${VIDEO_FRAME_SECONDS}`;
  assert(framed.protocol === url.protocol, 'Video frame source keeps its scheme');
  return framed.href;
}

// The pair to the protocol switch above: whatever it returned, a loadable
// source is one of the allowed schemes, so a later edit cannot widen the set
// by accident.
function assertAllowedSource(media: RemoteMedia): void {
  if (media.kind === 'unknown') {
    return;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(media.source)?.[1]?.toLowerCase();
  assert(scheme === 'http' || scheme === 'https' || scheme === 'data' || scheme === 'blob', 'Remote media loads an allowed scheme');
  if (scheme === 'data') {
    assert(media.kind === 'image', 'Remote data: media is an image');
  }
}
