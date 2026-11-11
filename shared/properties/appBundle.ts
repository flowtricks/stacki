// A Stacki app bundle is one zip archive (docs/apps.md, "Bundle format"). This
// module reads one from bytes, with the platform's raw inflate passed in so the
// same reader runs in Desktop's main process and on the Studio server: no zip
// library is needed (AGENTS.md §17), and every bound is checked before memory
// is spent on it.
//
// What the reader refuses: zip64, encryption, symlinks, methods other than
// stored and deflate, duplicate or unsafe paths (parseBundlePath), file types an
// app may not hold, a CRC mismatch, and any size or count past APP_LIMITS. A
// bundle zipped with its folder (`my-app/stacki-app.json`) has that one folder
// removed, so both `zip -r app.zip .` and zipping the folder itself work.
import { assert } from '../core/assert';
import { APP_HOST_FOLDER, APP_LIMITS, APP_MANIFEST_FILE, APP_SDK_FILE, parseAppManifestSource, parseBundlePath, type AppManifest } from './apps';

export interface BundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface AppBundle {
  readonly manifest: AppManifest;
  /** Every file, the manifest included, sorted by path. */
  readonly files: readonly BundleFile[];
}

/** Raw DEFLATE decompression, refusing output past `sizeBytesMax`. */
export type InflateRaw = (data: Uint8Array, sizeBytesMax: number) => Uint8Array;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_BYTES = 22;
const COMMENT_BYTES_MAX = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const ZIP64_MARKER = 0xffffffff;
// Entries a central directory may list, directories included: the file bound plus room for folders.
const ENTRIES_MAX = APP_LIMITS.filesMax * 2;

/** Reads, checks and returns an app bundle from a zip archive's bytes. Throws with the reason. */
export function readAppBundle(archive: Uint8Array, inflateRaw: InflateRaw): AppBundle {
  if (archive.byteLength === 0) {
    throw new Error('The app file is empty');
  }
  if (archive.byteLength > APP_LIMITS.archiveBytesMax) {
    throw new Error(`The app file exceeds ${APP_LIMITS.archiveBytesMax} bytes`);
  }
  const entries = readZipEntries(archive, inflateRaw);
  return bundleFromFiles(withoutCommonFolder(entries));
}

/**
 * A bundle from files already held to the path and size bounds: an archive's
 * entries, or a folder's files (electron/project/appScan.ts). Checks what makes
 * the files one app: the manifest at the root, its entry and icon present, the
 * icon's shape, and no copy of the host's SDK or its UI kit folder. Throws with the reason.
 */
export function bundleFromFiles(files: readonly BundleFile[]): AppBundle {
  assert(files.length <= APP_LIMITS.filesMax, 'A bundle’s files are bounded before they are checked');
  const manifestFile = files.find((file) => file.path === APP_MANIFEST_FILE);
  if (manifestFile === undefined) {
    throw new Error(`The app has no ${APP_MANIFEST_FILE} at its root`);
  }
  const manifest = parseAppManifestSource(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes));
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has(manifest.entry)) {
    throw new Error(`The entry file ${manifest.entry} is missing from the bundle`);
  }
  if (manifest.icon !== undefined) {
    const icon = files.find((file) => file.path === manifest.icon);
    if (icon === undefined) {
      throw new Error(`The icon ${manifest.icon} is missing from the bundle`);
    }
    checkAppIcon(icon);
  }
  if (paths.has(APP_SDK_FILE)) {
    throw new Error(`${APP_SDK_FILE} is served by Stacki; remove it from the bundle`);
  }
  // The host answers every path under `__stacki/` itself (the UI kit, shared/properties/appUiKit.ts), so a file there would never be served.
  const reserved = files.find((file) => (file.path.split('/')[0] ?? '').toLowerCase() === APP_HOST_FOLDER);
  if (reserved !== undefined) {
    throw new Error(`${APP_HOST_FOLDER}/ is served by Stacki (its UI kit); remove ${reserved.path} from the bundle`);
  }
  const remote = findRemoteCode(files);
  if (remote.length > 0) {
    throw new Error(remoteCodeMessage(remote));
  }
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : 1));
  assert(sorted.length <= APP_LIMITS.filesMax, 'A read bundle is within the file bound');
  return { manifest, files: sorted };
}

/** The archive's files (directories skipped), each checked and decompressed. */
export function readZipEntries(archive: Uint8Array, inflateRaw: InflateRaw): readonly BundleFile[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndRecord(view);
  const entryCount = view.getUint16(end + 10, true);
  const directoryBytes = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entryCount === 0xffff || directoryOffset === ZIP64_MARKER) {
    throw new Error('Zip64 archives are not supported');
  }
  if (entryCount > ENTRIES_MAX) {
    throw new Error(`An app holds at most ${APP_LIMITS.filesMax} files`);
  }
  if (directoryOffset + directoryBytes > end) {
    throw new Error('The zip central directory is out of range');
  }
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = readCentralEntry(view, archive, cursor);
    cursor = entry.next;
    if (entry.name.endsWith('/')) {
      continue; // A directory: its files carry their own paths.
    }
    const path = parseBundlePath(entry.name);
    if (seen.has(path)) {
      throw new Error(`"${path}" is in the archive twice`);
    }
    seen.add(path);
    if (files.length >= APP_LIMITS.filesMax) {
      throw new Error(`An app holds at most ${APP_LIMITS.filesMax} files`);
    }
    totalBytes += entry.sizeBytes;
    if (totalBytes > APP_LIMITS.bundleBytesMax) {
      throw new Error(`The app's files exceed ${APP_LIMITS.bundleBytesMax} bytes uncompressed`);
    }
    files.push({ path, bytes: readEntryData(view, archive, entry, inflateRaw) });
  }
  assert(files.length <= APP_LIMITS.filesMax, 'Zip files are bounded');
  return files;
}

/**
 * Checks an app icon: at most APP_LIMITS.iconBytesMax, square, and for PNG and
 * WebP at most APP_LIMITS.iconPxMax pixels a side, read from the image header.
 * An SVG must say its shape with a viewBox (or width and height).
 */
export function checkAppIcon(icon: BundleFile): void {
  if (icon.bytes.byteLength > APP_LIMITS.iconBytesMax) {
    throw new Error(`The icon is larger than ${Math.floor(APP_LIMITS.iconBytesMax / 1024)} KiB`);
  }
  const size = iconSize(icon);
  if (size === undefined) {
    throw new Error(`The icon ${icon.path} is not a readable ${icon.path.split('.').pop()?.toUpperCase() ?? 'image'}`);
  }
  if (size.width <= 0 || size.height <= 0) {
    throw new Error('The icon has no size');
  }
  if (Math.abs(size.width - size.height) > Math.max(size.width, size.height) * 0.01) {
    throw new Error(`The icon must be square; it is ${size.width}×${size.height}`);
  }
  if (!icon.path.toLowerCase().endsWith('.svg') && size.width > APP_LIMITS.iconPxMax) {
    throw new Error(`The icon is at most ${APP_LIMITS.iconPxMax}×${APP_LIMITS.iconPxMax} pixels`);
  }
}

function iconSize(icon: BundleFile): { readonly width: number; readonly height: number } | undefined {
  const bytes = icon.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lower = icon.path.toLowerCase();
  if (lower.endsWith('.png')) {
    const signature = bytes.byteLength >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452;
    return signature ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined;
  }
  if (lower.endsWith('.webp')) {
    return webpSize(bytes, view);
  }
  if (lower.endsWith('.svg')) {
    return svgSize(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096)));
  }
  return undefined;
}

function webpSize(bytes: Uint8Array, view: DataView): { readonly width: number; readonly height: number } | undefined {
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 30 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
    return undefined;
  }
  const chunk = tag(12);
  const uint24 = (offset: number) => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
  if (chunk === 'VP8X') {
    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function svgSize(head: string): { readonly width: number; readonly height: number } | undefined {
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (tag === undefined) {
    return undefined;
  }
  const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  if (viewBox !== null) {
    return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }
  const width = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag);
  const height = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag);
  if (width === null || height === null) {
    return undefined;
  }
  return { width: Number(width[1]), height: Number(height[1]) };
}

// ---------------------------------------------------------------------------
// Remote code
// ---------------------------------------------------------------------------

/**
 * An app installs fully into the project (docs/apps.md, "Local first"): code it
 * runs comes from its own bundle, never from another host at run time, so an
 * installed app keeps working offline and runs exactly the bytes that were
 * reviewed. The scan is a bounded, best-effort read of the text files that can
 * load code: HTML, JavaScript and CSS. Runtime calls (`fetch`) are not code; the
 * manifest's `network` list declares those.
 */
export const REMOTE_CODE_LIMITS = {
  /** Findings one scan collects; past it the bundle is refused anyway. */
  findingsMax: 20,
  /** Findings the refusal names; the rest are counted. */
  findingsShownMax: 3,
  /** A URL as a message quotes it. */
  urlCharsMax: 200,
  /** Characters between `import` or `export` and its `from`: keeps the static import pattern linear. */
  importClauseCharsMax: 1000,
} as const satisfies Record<string, number>;

/** One remote load in a bundle: the file, the URL, and whether it is code or a file a stylesheet loads. */
export interface RemoteCodeFinding {
  readonly path: string;
  readonly url: string;
  readonly kind: 'code' | 'file';
}

/** Every remote code load in a bundle's HTML, JavaScript and CSS files, up to REMOTE_CODE_LIMITS.findingsMax. */
export function findRemoteCode(files: readonly BundleFile[]): readonly RemoteCodeFinding[] {
  const findings: RemoteCodeFinding[] = [];
  const seen = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const file of files) {
    if (findings.length >= REMOTE_CODE_LIMITS.findingsMax) {
      break;
    }
    const scanner = remoteScannerFor(file.path);
    if (scanner === undefined) {
      continue;
    }
    assert(file.bytes.byteLength <= APP_LIMITS.fileBytesMax, 'A scanned file is within the file bound');
    for (const found of scanner(decoder.decode(file.bytes))) {
      const key = `${found.kind} ${found.url}`;
      if (seen.has(`${file.path} ${key}`)) {
        continue;
      }
      seen.add(`${file.path} ${key}`);
      if (findings.length < REMOTE_CODE_LIMITS.findingsMax) {
        findings.push({ path: file.path, url: found.url.slice(0, REMOTE_CODE_LIMITS.urlCharsMax), kind: found.kind });
      }
    }
  }
  assert(findings.length <= REMOTE_CODE_LIMITS.findingsMax, 'Findings are bounded');
  return findings;
}

/** The refusal for a bundle with remote code: each finding names its file and URL. */
export function remoteCodeMessage(findings: readonly RemoteCodeFinding[]): string {
  assert(findings.length > 0, 'A refusal names at least one finding');
  const shown = findings.slice(0, REMOTE_CODE_LIMITS.findingsShownMax).map(remoteFindingSentence);
  const rest = findings.length - shown.length;
  const more = rest > 0 ? `; and ${rest} more` : '';
  return `${shown.join('; ')}${more}`;
}

/** `index.html loads remote code from https://…: vendor it into the bundle`. */
export function remoteFindingSentence(finding: RemoteCodeFinding): string {
  const what = finding.kind === 'code' ? 'remote code' : 'a remote file';
  return `${finding.path} loads ${what} from ${finding.url}: vendor it into the bundle`;
}

type RemoteLoad = Pick<RemoteCodeFinding, 'url' | 'kind'>;

function remoteScannerFor(path: string): ((source: string) => readonly RemoteLoad[]) | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html')) {
    return remoteInHTML;
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
    return remoteInScript;
  }
  if (lower.endsWith('.css')) {
    return remoteInStyle;
  }
  return undefined;
}

// `https://`, `http://` or protocol-relative `//`: another host. Relative paths and `data:` are the bundle's own.
function isRemote(url: string): boolean {
  return /^\s*(?:https?:)?\/\//i.test(url);
}

function remoteInHTML(source: string): readonly RemoteLoad[] {
  const html = source.replace(/<!--[\s\S]*?-->/g, '');
  const loads: RemoteLoad[] = [];
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attribute = (match[1] ?? '').toLowerCase() === 'script' ? 'src' : 'href';
    const url = attributeValue(match[2] ?? '', attribute);
    if (url !== undefined && isRemote(url)) {
      loads.push({ url: url.trim(), kind: 'code' });
    }
  }
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    loads.push(...remoteInScript(match[1] ?? ''));
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    loads.push(...remoteInStyle(match[1] ?? ''));
  }
  return loads;
}

// One attribute's value in a tag's attribute text; `data-src` is not `src`.
function attributeValue(attributes: string, name: 'src' | 'href'): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(attributes);
  if (match === null) {
    return undefined;
  }
  return match[1] ?? match[2] ?? match[3];
}

function remoteInScript(source: string): readonly RemoteLoad[] {
  // Block comments and whole-line comments only: a `//` inside a string is a URL, not a comment.
  const script = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const clause = REMOTE_CODE_LIMITS.importClauseCharsMax;
  const patterns = [
    new RegExp(`(?<![.\\w$])(?:import|export)\\b[^;'"\`]{0,${clause}}?\\bfrom\\s*(['"])([^'"\\n]*)\\1`, 'g'),
    /(?<![.\w$])import\s*(['"])([^'"\n]*)\1/g,
    /(?<![.\w$])import\s*\(\s*(['"`])([^'"`\n]*)\1/g,
    /(?<![.\w$])importScripts\s*\(\s*(['"`])([^'"`\n]*)\1/g,
  ];
  const loads: RemoteLoad[] = [];
  for (const pattern of patterns) {
    for (const match of script.matchAll(pattern)) {
      const url = match[2] ?? '';
      if (isRemote(url)) {
        loads.push({ url, kind: 'code' });
      }
    }
  }
  return loads;
}

function remoteInStyle(source: string): readonly RemoteLoad[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const loads: RemoteLoad[] = [];
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]*)/gi)) {
    const url = match[2] ?? '';
    if (isRemote(url)) {
      loads.push({ url, kind: 'code' });
    }
  }
  for (const match of css.matchAll(/(?<![\w-])url\(\s*(['"]?)([^'")\s]*)/gi)) {
    const url = match[2] ?? '';
    // An `@import url(…)` is already named as code above.
    if (isRemote(url) && !loads.some((load) => load.url === url)) {
      loads.push({ url, kind: 'file' });
    }
  }
  return loads;
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedBytes: number;
  readonly sizeBytes: number;
  readonly localOffset: number;
  readonly next: number;
}

function findEndRecord(view: DataView): number {
  if (view.byteLength < END_RECORD_BYTES) {
    throw new Error('The app file is not a zip archive');
  }
  const lowest = Math.max(0, view.byteLength - END_RECORD_BYTES - COMMENT_BYTES_MAX);
  for (let offset = view.byteLength - END_RECORD_BYTES; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error('The app file is not a zip archive');
}

function readCentralEntry(view: DataView, archive: Uint8Array, offset: number): CentralEntry {
  if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
    throw new Error('The zip central directory is damaged');
  }
  const flags = view.getUint16(offset + 8, true);
  const method = view.getUint16(offset + 10, true);
  const crc = view.getUint32(offset + 16, true);
  const compressedBytes = view.getUint32(offset + 20, true);
  const sizeBytes = view.getUint32(offset + 24, true);
  const nameBytes = view.getUint16(offset + 28, true);
  const extraBytes = view.getUint16(offset + 30, true);
  const commentBytes = view.getUint16(offset + 32, true);
  const externalAttributes = view.getUint32(offset + 38, true);
  const localOffset = view.getUint32(offset + 42, true);
  const nameStart = offset + 46;
  if (nameStart + nameBytes > view.byteLength) {
    throw new Error('The zip central directory is damaged');
  }
  const name = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(nameStart, nameStart + nameBytes));
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new Error(`"${name.slice(0, 80)}" is encrypted; app bundles cannot be`);
  }
  if (compressedBytes === ZIP64_MARKER || sizeBytes === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
    throw new Error('Zip64 archives are not supported');
  }
  // The upper 16 bits are the Unix mode when the archive was made on Unix.
  const unixMode = Math.floor(externalAttributes / 0x10000);
  if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK) {
    throw new Error(`"${name.slice(0, 80)}" is a symbolic link; app bundles hold files only`);
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    throw new Error(`"${name.slice(0, 80)}" uses an unsupported compression method`);
  }
  if (sizeBytes > APP_LIMITS.fileBytesMax) {
    throw new Error(`"${name.slice(0, 80)}" exceeds ${APP_LIMITS.fileBytesMax} bytes`);
  }
  return { name, method, crc, compressedBytes, sizeBytes, localOffset, next: nameStart + nameBytes + extraBytes + commentBytes };
}

function readEntryData(view: DataView, archive: Uint8Array, entry: CentralEntry, inflateRaw: InflateRaw): Uint8Array {
  const offset = entry.localOffset;
  if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== LOCAL_FILE_HEADER) {
    throw new Error(`"${entry.name.slice(0, 80)}" has a damaged local header`);
  }
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  const stop = start + entry.compressedBytes;
  if (stop > view.byteLength) {
    throw new Error(`"${entry.name.slice(0, 80)}" runs past the end of the archive`);
  }
  const compressed = archive.subarray(start, stop);
  const bytes = entry.method === METHOD_STORED ? compressed.slice() : inflateRaw(compressed, entry.sizeBytes);
  if (bytes.byteLength !== entry.sizeBytes) {
    throw new Error(`"${entry.name.slice(0, 80)}" is not the size the archive says`);
  }
  if (crc32(bytes) !== entry.crc) {
    throw new Error(`"${entry.name.slice(0, 80)}" fails its checksum`);
  }
  return bytes;
}

// A bundle zipped with its folder: every path starts with the same one folder, and the manifest is in it.
function withoutCommonFolder(files: readonly BundleFile[]): readonly BundleFile[] {
  if (files.some((file) => file.path === APP_MANIFEST_FILE)) {
    return files;
  }
  const first = files[0]?.path.split('/')[0];
  if (first === undefined) {
    return files;
  }
  const prefix = `${first}/`;
  if (!files.every((file) => file.path.startsWith(prefix))) {
    return files;
  }
  const stripped = files.map((file) => ({ path: parseBundlePath(file.path.slice(prefix.length)), bytes: file.bytes }));
  assert(stripped.length === files.length, 'Stripping keeps every file');
  return stripped;
}

let crcTable: Uint32Array | undefined;

/** The zip CRC-32 (IEEE 802.3) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  const table = crcTable ?? buildCrcTable();
  crcTable = table;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  assert(table.length === 256, 'The CRC table has one entry per byte');
  return table;
}

/** A stored (uncompressed) zip of `files`: for tests, fixtures and the docs' examples. */
export function writeStoredZip(files: readonly BundleFile[]): Uint8Array {
  return writeZip(files, undefined);
}

/** Raw DEFLATE compression. */
export type DeflateRaw = (data: Uint8Array) => Uint8Array;

/**
 * A zip of a bundle's files, each deflated when that makes it smaller: what a
 * share releases (electron/project/appPublishService.ts). The reader above takes
 * it back, which the share asserts before anything is uploaded.
 */
export function writeDeflatedZip(files: readonly BundleFile[], deflateRaw: DeflateRaw): Uint8Array {
  return writeZip(files, deflateRaw);
}

function writeZip(files: readonly BundleFile[], deflateRaw: DeflateRaw | undefined): Uint8Array {
  assert(files.length <= ENTRIES_MAX, 'A written zip is bounded');
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const deflated = deflateRaw?.(file.bytes);
    const compressed = deflated !== undefined && deflated.byteLength < file.bytes.byteLength;
    const body = compressed ? deflated : file.bytes;
    const method = compressed ? METHOD_DEFLATE : METHOD_STORED;
    const local = new Uint8Array(30 + name.byteLength + body.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, body.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(body, 30 + name.byteLength);
    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_FILE_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, body.byteLength, true);
    centralView.setUint32(24, file.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const directoryBytes = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(END_RECORD_BYTES);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directoryBytes, true);
  endView.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directoryBytes + END_RECORD_BYTES);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  assert(cursor === output.byteLength, 'Every byte of the zip was written');
  return output;
}
