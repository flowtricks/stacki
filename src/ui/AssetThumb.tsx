import { assetSources } from '../ipc/editorEnvironment';
import React, { useRef, useState } from 'react';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { FileIcon, CodeIcon } from './Icons';
import type { WireAssetEntry } from '../../shared/ipc/ipcResults';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|oga|ogg)$/i;
export const TEXT_EXT = /\.(css|js|mjs|cjs|ts|json|txt|md|xml|csv|webmanifest|toml|yml|yaml)$/i;
const FONT_DOCUMENT_EXT = /\.(woff2?|ttf|otf|eot|pdf|zip)$/i;

const cleanPath = (value: unknown): string =>
  String(value || '')
    .trim()
    .split(/[?#]/)[0] ?? '';

// True for values that name a file inside public/ — a root-relative path
// with a known asset extension ("/videos/clip.webm"), not a URL or a route.
export function looksLikeAssetPath(value: unknown) {
  const path = cleanPath(value);
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false;
  }
  return IMAGE_EXT.test(path) || VIDEO_EXT.test(path) || AUDIO_EXT.test(path) || TEXT_EXT.test(path) || FONT_DOCUMENT_EXT.test(path);
}

// Which picker filter suits a value ("image" | "video" | "audio" | "asset").
export function mediaKindFor(value: unknown) {
  const path = cleanPath(value);
  if (VIDEO_EXT.test(path)) {
    return 'video';
  }
  if (AUDIO_EXT.test(path)) {
    return 'audio';
  }
  if (IMAGE_EXT.test(path)) {
    return 'image';
  }
  return 'asset';
}

// Per-segment encoding, so '#', '?' and '%' in a filename survive the trip.
const encodePath = (abs: string): string =>
  abs
    .replace(/\\/g, '/')
    .replace(/^\/(?!\/)/, '')
    .split('/')
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');

const fileURL = (encodedPath: string): string => (encodedPath.startsWith('//') ? `file:${encodedPath}` : `file:///${encodedPath}`);

// Served by the main process (see ASSET_SCHEME in electron/main.js). A plain
// file:// URL only loads when the window itself came from file:// — true of a
// packaged build, but in dev the renderer is on http and Chromium blocks
// file:// subresources from it. Try our scheme first, then fall back to
// file:// so a packaged build still works if the scheme is unavailable.
export const sourceCandidates = (abs: string): readonly [string, string] =>
  assetSources(abs, [`stacki-asset://local/${encodePath(abs)}`, fileURL(encodePath(abs))]);

// Formats Chromium can load through FontFace. .eot can't, so it keeps the
// badge.
export const FONT_EXT = /\.(woff2?|ttf|otf)$/i;

// One CSS family per file, derived from its path so two tiles showing the
// same font share it.
const familyFor = (abs: string): string => {
  assert(abs.length <= BOUNDARY_LIMITS.pathLengthMax, 'AssetThumb: font path limit exceeded');
  let hash = 0;
  for (let i = 0; i < abs.length; i++) {
    hash = (hash * 31 + abs.charCodeAt(i)) | 0;
  }
  return `avb-font-${(hash >>> 0).toString(36)}`;
};

// Registers a font file so a tile can render "Aa" in it. Loaded fonts stay
// registered: a project has few, and scrolling the Assets panel (which
// unmounts tiles) shouldn't refetch them. Resolves to undefined when the file
// isn't a usable font, so the caller falls back to the badge.
const FONT_LOADS_MAX = 256;
const fontLoads = new Map<string, Promise<string | undefined>>(); // Keyed by absolute path.
function loadFontPreview(abs: string, sources: readonly [string, string]): Promise<string | undefined> {
  const existing = fontLoads.get(abs);
  if (existing) {
    return existing;
  }
  // Registered faces live for the document; keep both the cache and font set bounded.
  if (fontLoads.size >= FONT_LOADS_MAX) {
    return Promise.resolve(undefined);
  }
  if (!fontLoads.has(abs)) {
    const family = familyFor(abs);
    fontLoads.set(
      abs,
      (async () => {
        for (const source of new Set(sources)) {
          try {
            const face = new FontFace(family, `url("${source}")`);
            await face.load();
            document.fonts.add(face);
            return family;
          } catch {
            /* unreachable source or unsupported file — try the next */
          }
        }
        return undefined;
      })(),
    );
  }
  const result = fontLoads.get(abs);
  assert(result !== undefined, 'AssetThumb: new font load is cached');
  return result;
}

// Warm a small, fixed budget as soon as the catalog arrives. Fonts otherwise wait
// for their folder to open, adding a network round trip to every first preview.
const FONT_PRELOAD_COUNT_MAX = 4;
const FONT_PRELOAD_BYTES_MAX = 256 * 1024;
export function preloadFontPreviews(entries: readonly WireAssetEntry[]): void {
  assert(entries.length <= BOUNDARY_LIMITS.itemsMax, 'Font catalog stays bounded');
  let count = 0;
  for (const entry of entries) {
    if (entry.isDir) {
      continue;
    }
    if (!FONT_EXT.test(entry.name) || entry.size > FONT_PRELOAD_BYTES_MAX) {
      continue;
    }
    void loadFontPreview(entry.abs, sourceCandidates(entry.abs));
    count++;
    if (count === FONT_PRELOAD_COUNT_MAX) {
      break;
    }
  }
  assert(count <= FONT_PRELOAD_COUNT_MAX, 'Font preloads stay within their request budget');
}

// Thumbnail for one asset: images render directly, videos show their first
// frame and play muted on loop while hovered, everything else gets a badge.
// `onImageLoad` reports natural dimensions to the caller when available.
export interface AssetDimensions {
  readonly w: number;
  readonly h: number;
}
interface AssetThumbProps {
  readonly file: { readonly abs: string; readonly name: string };
  readonly className?: string;
  readonly onImageLoad?: ((dimensions: AssetDimensions) => void) | undefined;
  readonly onClick?: React.MouseEventHandler<HTMLDivElement>;
}
export default function AssetThumb({ file, className = '', onImageLoad, onClick }: AssetThumbProps) {
  const { videoRef, source, failed, nextSource, isText, isVideo, isImage, isFont, fontFamily } = useAssetPreview(file);
  return (
    <div
      className={`asset-thumb ${className}`}
      onClick={onClick}
      onMouseEnter={isVideo ? () => assetHoverPlay(videoRef) : undefined}
      onMouseLeave={isVideo ? () => assetHoverStop(videoRef) : undefined}
    >
      {isImage && !failed ? (
        <img
          key={source}
          src={source}
          alt=""
          draggable={false}
          onLoad={(event) =>
            onImageLoad?.({
              w: event.currentTarget.naturalWidth,
              h: event.currentTarget.naturalHeight,
            })
          }
          onError={nextSource}
        />
      ) : isVideo && !failed ? (
        <video
          key={source}
          ref={videoRef}
          // The #t fragment makes Chromium decode and paint a real first
          // frame instead of leaving the element blank until playback.
          src={`${source}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          draggable={false}
          onLoadedMetadata={(event) => onImageLoad?.({ w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight })}
          onError={nextSource}
        />
      ) : isFont && fontFamily ? (
        <span className="asset-font" style={{ fontFamily: `"${fontFamily}"` }}>
          Aa
        </span>
      ) : (
        <span className="asset-ext">
          {isText ? <CodeIcon size={16} /> : <FileIcon size={16} />}
          {(file.name.split('.').pop() || '').toUpperCase().slice(0, 5)}
        </span>
      )}
      {isVideo && !failed && <span className="asset-badge">▶</span>}
    </div>
  );
}

function useAssetPreview(file: AssetThumbProps['file']) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Index into sourceCandidates; past the end means every source errored.
  const [sourceIndex, setSourceIndex] = useState(0);
  React.useEffect(() => setSourceIndex(0), [file.abs]);
  const candidates = React.useMemo(() => sourceCandidates(file.abs), [file.abs]);
  const source = candidates[sourceIndex];
  const failed = sourceIndex >= candidates.length;
  const nextSource = () => setSourceIndex((i) => Math.min(i + 1, candidates.length));
  const isText = TEXT_EXT.test(file.name);
  const isVideo = !isText && VIDEO_EXT.test(file.name);
  const isImage = !isText && !isVideo && IMAGE_EXT.test(file.name);
  const isFont = !isText && !isVideo && !isImage && FONT_EXT.test(file.name);

  // Undefined until the face loads (or for good, if it can't) — the badge shows
  // meanwhile, so a font that never loads looks exactly as it did before.
  const [fontFamily, setFontFamily] = useState<string | undefined>(undefined);
  React.useEffect(() => {
    setFontFamily(undefined);
    if (!isFont) {
      return undefined;
    }
    let alive = true;
    // The load catches every failure and resolves undefined, so it never rejects.
    void loadFontPreview(file.abs, candidates).then((family) => {
      if (alive) {
        setFontFamily(family);
      }
    });
    return () => {
      alive = false;
    };
  }, [isFont, file.abs, candidates]);

  return {
    videoRef,
    source,
    failed,
    nextSource,
    isText,
    isVideo,
    isImage,
    isFont,
    fontFamily,
  };
}

function assetHoverPlay(video: React.RefObject<HTMLVideoElement>): void {
  const player = video.current;
  if (!player) {
    return;
  }
  player.loop = true;
  player.muted = true;
  player.play().catch(() => {});
}
function assetHoverStop(video: React.RefObject<HTMLVideoElement>): void {
  const player = video.current;
  if (!player) {
    return;
  }
  player.pause();
  try {
    player.currentTime = 0.1;
  } catch {
    /* not seekable yet */
  }
}
