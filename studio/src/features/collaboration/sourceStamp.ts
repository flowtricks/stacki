// The stamp of the source an edit is planned over, for the canvas changes shown ahead of the
// server (electron/preload/frameMove.ts, pendingKeptFrom). The dev plugin stamps every marked file
// with the SHA-256 of its bytes (shared/page/previewToken.ts); the room writes the shared text to
// the file byte for byte, so the editor can name a rendering of that text before it exists. A
// rendering that carries an edit's base was rendered from before the edit, and the canvas keeps
// showing it. Why: with a slow render, the first delete's rendering arrived after a second delete
// was shown, and the second node came back for a whole render.
//
// Web Crypto has no synchronous digest, so the stamp is worked out after each change and read
// synchronously when an edit is made; an edit made before it is ready carries no base and settles
// on the next rendering, as before.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { toDigest } from '../../../vendor/stacki/shared/core/brand';
import { stampData, stampPathProblem } from '../../../vendor/stacki/shared/page/previewToken';
import { MAX_SOURCE } from '../../shared/validation';

export class SourceStamp {
  private known: { readonly source: string; readonly stamp: string } | undefined;
  private wanted: string | undefined;
  private working = false;
  private readonly stamped: boolean;
  constructor(private readonly file: string) {
    // Only marked files carry a stamp: .astro under src.
    this.stamped = file.endsWith('.astro') && file.startsWith('src/') && stampPathProblem(file) === undefined;
  }

  /** The stamp of `source` once it is worked out; undefined until then, or for a file the canvas does not stamp. */
  of(source: string): string | undefined {
    return this.known?.source === source ? this.known.stamp : undefined;
  }

  /** Works out the stamp of `source` in the background; a newer source replaces one still waiting. */
  refresh(source: string): void {
    if (!this.stamped || source.length > MAX_SOURCE || this.known?.source === source) {
      return;
    }
    this.wanted = source;
    if (!this.working) {
      void this.work();
    }
  }

  // One digest at a time, always of the latest text: bounded by the edits, not by their rate.
  private async work(): Promise<void> {
    assert(!this.working, 'SourceStamp: one digest at a time');
    this.working = true;
    try {
      for (let round = 0; round < 64 && this.wanted !== undefined; round++) {
        const source = this.wanted;
        this.wanted = undefined;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
        const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        assert(checksum.length === 64, 'SourceStamp: a SHA-256 is 64 hex digits');
        this.known = { source, stamp: stampData({ file: this.file, checksum: toDigest(checksum) }) };
      }
    } catch {
      this.known = undefined; // No Web Crypto (an insecure origin): edits carry no base.
    } finally {
      this.working = false;
    }
  }
}
