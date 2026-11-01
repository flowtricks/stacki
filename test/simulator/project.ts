// Bytes → snapshot, through the real parsers (plan §10: the simulator drives
// the real parser, not a model of it). `.astro` files get a page projection,
// and so do Markdown and MDX pages (step 10), through the Markdown parser;
// every other file is an opaque document addressed only whole. Invalid UTF-8
// is a parse-error projection, never a lossy decode (plan §3.2).
import { createHash } from 'node:crypto';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parseMarkdownPage } from '#dist/electron/parse/markdownParser.js';
import { assert } from '#dist/shared/core/assert.js';
import { toDigest, type Digest, type FilePath } from '#dist/shared/core/brand.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { createSnapshot, type Snapshot } from '#dist/shared/page/snapshot.js';
import { projectOpaqueDocument, projectPage, type Projection } from '#dist/shared/page/sourceProjection.js';
import { decodeUtf8, type ByteString } from '#dist/shared/core/span.js';

export function sha256(bytes: ByteString): Digest {
  return toDigest(createHash('sha256').update(bytes).digest('hex'));
}

export function projectBytes(path: FilePath, bytes: ByteString): Projection {
  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) {
    const diagnostic = { message: decoded.error.message, near: undefined };
    return { tag: 'parse-error', byteLength: bytes.length, diagnostics: [diagnostic] };
  }
  const text = decoded.value;
  const projection = projectText(path, text);
  assert(projection.byteLength === bytes.length, 'The projection measures the bytes it read');
  return projection;
}

function projectText(path: FilePath, text: string): Projection {
  if (path.endsWith('.astro')) {
    return projectPage(text, parsePageResult(parsePage(text, { locs: true })));
  }
  if (path.endsWith('.md') || path.endsWith('.mdx')) {
    const mdx = path.endsWith('.mdx');
    return projectPage(text, parsePageResult(parseMarkdownPage(text, { mdx })));
  }
  return projectOpaqueDocument(text);
}

export function snapshotOf(path: FilePath, bytes: ByteString): Snapshot {
  const snapshot = createSnapshot({ path, bytes, projection: projectBytes(path, bytes) }, sha256);
  assert(snapshot.bytes === bytes, 'The snapshot keeps the bytes it was built from');
  return snapshot;
}
