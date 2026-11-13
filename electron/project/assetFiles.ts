// A project's asset files: the folders they live in, a path inside one,
// a name that is free, the tree the assets panel lists, and an image's pixel
// size read from its header.

import { MAIN_LIMITS, directoryBudget } from '../lib/mainLimits';
import { isPathWithin } from '../lib/platform';
import { assert } from '../../shared/core/assert';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import type { AssetEntry } from '../lib/mainTypes';
import * as path from 'path';
import * as fs from 'fs';
import { capture, toPosix } from '../lib/mainHelpers';
import { projectFoldersFor } from '../lib/projectFolders';
import { folderHolding, isAboveFolder } from '../../shared/properties/projectFolders';

// ---------------------------------------------------------------------------
// Assets (public/) — list, upload, move, rename, folders
// ---------------------------------------------------------------------------

export const publicDirectoryOf = (projectPath: string) => path.join(projectPath, 'public');

// Assets live in two places and they mean different things:
//
//   public/  copied to the site as-is; referenced by URL ("/hero.png")
//   src/     imported by the build; referenced by ESM import, and optimised
//            (this is where <Image> wants its images)
//
// So an asset is addressed by a ROOTED rel — "public/img/hero.png" or
// "src/assets/hero.png" — and every handler below takes that. The root is the
// first segment, which keeps one string identifying a file across listing,
// moving, renaming and picking, and makes a cross-root move just a move.
export const ASSET_ROOTS = ['public', 'src'];

// Media only under src/: everything else there is code. public/ lists whatever
// is in it — that folder exists to be served.
export const MEDIA_EXT = new RegExp(
  '\\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|' + 'mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|flac|aac|woff2?|ttf|otf|eot)$',
  'i',
);

export const rootOfRel = (rel: string) => String(rel || '').split('/')[0] ?? '';

// Refuses anything that escapes the two roots, and anything outside the
// project's asset folders (.stacki/folders.json; by default the whole of both
// roots), so configuring a folder can only narrow where the panel writes.
export function assetAbs(projectPath: string, rel: string) {
  const clean = String(rel || '').replace(/^\/+/, '');
  const root = rootOfRel(clean);
  if (!ASSET_ROOTS.includes(root)) {
    throw new Error('Invalid asset path');
  }
  const rootAbs = path.resolve(projectPath, root);
  const abs = path.resolve(projectPath, clean);
  if (!isPathWithin(rootAbs, abs)) {
    throw new Error('Invalid asset path');
  }
  // The resolved path, not the text: `src/assets/../pages` names src/pages.
  const resolved = toPosix(path.relative(path.resolve(projectPath), abs));
  if (folderHolding(projectFoldersFor(projectPath, 'assets'), resolved) === undefined) {
    throw new Error(`${resolved} is not in one of the project's asset folders.`);
  }
  return abs;
}

/**
 * Why a write may not touch the file at `rel`, or undefined when it may. Under
 * public/ every file is an asset: the folder exists to be served. Anywhere
 * else only media is: the rest is code (pages, components, stylesheets) that
 * only the document actors write, so a raw byte copy or a rename must never
 * reach it, whichever folders the project lists as asset folders
 * (test/electron/documents/singleWriter.test.ts).
 */
export function assetWriteRefusal(rel: string): Described | undefined {
  assert(rel.length > 0, 'assetWriteRefusal: the asset is named');
  if (rootOfRel(rel) === 'public') {
    return undefined;
  }
  assert(rootOfRel(rel) === 'src', 'assetWriteRefusal: an asset is under public/ or src/');
  if (MEDIA_EXT.test(rel)) {
    return undefined;
  }
  return described('assets.error.sourceCode', { name: path.posix.basename(rel) });
}

/**
 * Everything the assets panel lists: each root (`public`, `src`) that holds a
 * configured asset folder, the folders between a root and a configured folder
 * (so the tree reaches it), and each configured folder's tree. Under src/ only
 * media is listed. With the default folders this is both roots' whole trees,
 * as it always was.
 */
export function listAssetEntries(projectPath: string): { readonly entries: AssetEntry[]; readonly hasPublic: boolean } {
  const folders = projectFoldersFor(projectPath, 'assets');
  const entries: AssetEntry[] = [];
  let hasPublic = false;
  for (const root of ASSET_ROOTS) {
    const rootFolders = folders.filter((folder) => rootOfRel(folder) === root);
    const rootDirectory = path.join(projectPath, root);
    if (rootFolders.length === 0 || !fs.existsSync(rootDirectory)) {
      continue;
    }
    if (root === 'public') {
      hasPublic = true;
    }
    // The roots themselves are entries, so the panel navigates and drops into
    // them with the folder handling it already has.
    entries.push({ rel: root, name: root, parent: '', isDir: true, root, isRoot: true });
    const listed = new Set<string>([root]);
    for (const folder of rootFolders) {
      const directory = path.join(projectPath, ...folder.split('/'));
      if (!fs.existsSync(directory)) {
        continue;
      }
      // Folders between the root and the configured one, then the folder itself.
      const segments = folder.split('/');
      for (let depth = 2; depth <= segments.length; depth++) {
        const rel = segments.slice(0, depth).join('/');
        assert(depth === 2 || isAboveFolder(folders, segments.slice(0, depth - 1).join('/')), 'listAssetEntries: each step leads to the folder');
        if (!listed.has(rel)) {
          listed.add(rel);
          entries.push({ rel, name: segments[depth - 1] ?? rel, parent: segments.slice(0, depth - 1).join('/'), isDir: true, root });
        }
      }
      for (const entry of listAssetTree(directory, folder, { mediaOnly: root === 'src' })) {
        if (!listed.has(entry.rel)) {
          listed.add(entry.rel);
          entries.push(entry);
        }
      }
    }
  }
  assert(entries.length === new Set(entries.map((entry) => entry.rel)).size, 'listAssetEntries: each path is listed once');
  return { entries, hasPublic };
}

// A destination name that doesn't collide: name.ext, name-1.ext, name-2.ext and on.
export function uniqueTarget(directory: string, name: string) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(directory, candidate))) {
    if (i > MAIN_LIMITS.fileNameAttemptsMax) {
      throw new Error('File name attempts exceed limit');
    }
    candidate = `${base}-${i++}${ext}`;
  }
  return path.join(directory, candidate);
}

// An image's pixel size, read from the file's own header.
//
// Astro takes the intrinsic size straight from a local asset — only a remote
// source gets `inferSize`. So a width/height field over a project file should
// say what that size IS, and to do that the app has to know it without waiting
// for a thumbnail somewhere to finish decoding.
export function imageSizeOf(abs: string) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(32768);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);

    // PNG: IHDR is always the first chunk.
    if (buf.length > 24 && buf.toString('binary', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF: little-endian in the logical screen descriptor.
    if (buf.length > 10 && buf.toString('binary', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    const webp = webpImageSize(buf);
    if (webp) {
      return webp;
    }
    // JPEG: walk the segments to the start-of-frame, which carries the size.
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let at = 2;
      while (at + 9 < buf.length) {
        if (buf[at] !== 0xff) {
          at += 1;
          continue;
        }
        const marker = buf.readUInt8(at + 1);
        const segmentLength = buf.readUInt16BE(at + 2);
        // SOF0…SOF15, minus the four that aren't frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc, 0xd8].includes(marker)) {
          return { h: buf.readUInt16BE(at + 5), w: buf.readUInt16BE(at + 7) };
        }
        at += 2 + segmentLength;
      }
    }
    // SVG: width/height when they're absolute, else the viewBox's own units.
    if (/\.svg$/i.test(abs)) {
      const text = buf.toString('utf8');
      const tag = text.match(/<svg\b[^>]*>/i)?.[0] || '';
      const dimension = (name: string) => {
        const raw = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
        return raw && /^[\d.]+(px)?$/i.test(raw.trim()) ? Math.round(parseFloat(raw)) : undefined;
      };
      const width = dimension('width');
      const height = dimension('height');
      if (width && height) {
        return { w: width, h: height };
      }
      const box = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
      if (box) {
        return {
          w: Math.round(parseFloat(capture(box, 1))),
          h: Math.round(parseFloat(capture(box, 2))),
        };
      }
    }
  } catch {
    /* unreadable or a format we don't decode — the caller falls back */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
  return undefined;
}

export function listAssetTree(root: string, rel: string, options: { readonly mediaOnly: boolean }): AssetEntry[] {
  const entries: AssetEntry[] = [];
  // Folders are only worth showing when something is in them, which for src/
  // means "holds media somewhere below" — otherwise every component folder in
  // the project would show up as an empty asset folder.
  const checkDirectory = directoryBudget(root);
  const mediaOnly = options.mediaOnly;
  const walk = (directory: string, rel: string, depth: number): boolean => {
    let held = false;
    let names = [];
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    checkDirectory(directory, names.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listAssetTree: the budget bounds depth');
    for (const entry of names) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const full = path.join(directory, entry.name);
      const entryRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        const at = entries.length;
        const placeholder: AssetEntry = {
          rel: entryRel,
          name: entry.name,
          parent: rel,
          isDir: true,
          root: rootOfRel(rel),
        };
        entries.push(placeholder);
        const any = walk(full, entryRel, depth + 1);
        if (any) {
          held = true;
        } else if (mediaOnly) {
          entries.splice(at, 1);
        } // nothing below it — not an asset folder
      } else {
        if (mediaOnly && !MEDIA_EXT.test(entry.name)) {
          continue;
        }
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* race */
        }
        held = true;
        entries.push({
          rel: entryRel,
          name: entry.name,
          parent: rel,
          isDir: false,
          size,
          abs: full,
          root: rootOfRel(rel),
        });
      }
    }
    return held;
  };

  walk(root, rel, 0);
  return entries;
}

export function webpImageSize(buf: Buffer) {
  // WebP: VP8 (lossy), VP8L (lossless) and VP8X (extended) each differ.
  if (buf.length > 30 && buf.toString('binary', 0, 4) === 'RIFF' && buf.toString('binary', 8, 12) === 'WEBP') {
    const kind = buf.toString('binary', 12, 16);
    if (kind === 'VP8 ') {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { w: width, h: height };
    }
  }
  return undefined;
}
