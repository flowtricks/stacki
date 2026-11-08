// A rendering names the exact source bytes it was made from, one stamp per file
// (`avb-d:<sha256>:<file>`). The canvas opens text editing only when the stamp for
// the page matches the checksum of the source the editor holds, so a rendering made
// from an older source can never take a text edit meant for the newer one. The dev
// server's render carries fresh stamps because Astro marks the new bytes. A demo
// rendering is the baked page with the edits applied in place, so its stamps would
// keep naming the baked bytes forever and text editing would wait for a render that
// never comes. Each rendering therefore restamps every edited file it was made from.
import { assert } from '../vendor/stacki/shared/core/assert';
import { PREVIEW_STAMP_PREFIX } from '../vendor/stacki/shared/page/previewToken';
import { sha256Hex } from './nodeCrypto';

/** Distinct source texts whose digest is kept; past this the oldest is recomputed. */
const DIGESTS_MAX = 64;

const digests = new Map<string, string>();

/** The same digest the client computes for its source, synchronously, because the
 * frame's first-moment rendering cannot wait for Web Crypto. */
export function sourceChecksum(text: string): string {
  const known = digests.get(text);
  if (known !== undefined) {
    return known;
  }
  const digest = sha256Hex(text);
  assert(/^[0-9a-f]{64}$/.test(digest), 'A source checksum is a SHA-256 hex digest');
  if (digests.size >= DIGESTS_MAX) {
    const oldest = digests.keys().next().value;
    if (oldest !== undefined) {
      digests.delete(oldest);
    }
  }
  digests.set(text, digest);
  return digest;
}

/** Rewrites the stamps of each edited file from its baked checksum to its current one.
 * A stamp ends where a comment, an attribute value or a newline-joined list ends. */
export function restampRendering(html: string, edited: ReadonlyMap<string, string>, baked: (file: string) => string | undefined): string {
  let result = html;
  for (const [file, text] of edited) {
    const source = baked(file);
    if (source !== undefined) {
      const before = `${PREVIEW_STAMP_PREFIX}${sourceChecksum(source)}:${file}`;
      const after = `${PREVIEW_STAMP_PREFIX}${sourceChecksum(text)}:${file}`;
      assert(before.length === after.length, 'A restamp keeps the stamp length');
      result = result.replace(new RegExp(`${escapePattern(before)}(?=-->|"|\\n|&)`, 'g'), after);
    }
  }
  return result;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
