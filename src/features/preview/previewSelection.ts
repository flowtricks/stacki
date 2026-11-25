// A canvas may still show the last saved version while Astro renders a local edit.
// Resolve its index through that version's stable node handle, then validate the
// current disk version before selecting. Never reinterpret an old index as a new one.
import { toDigest, type Digest } from '../../../shared/core/brand';
import { canonicalManifest, judgeEventToken, type PreviewRender, type PreviewVerdict } from '../../../shared/page/previewToken';
import type { PageOrigin } from '../../editor/pageEdits';
import { nodeAtPath, pathOfNode } from '../../editor/editorTree';
import { judgeCanvasEvent, judgeLocally, type CheckRender, type ShownFile } from './previewGate';

export type CanvasSelectionVerdict = PreviewVerdict | { readonly tag: 'current'; readonly path: string };

// Only the open file is retained. Eight saves cover a short render backlog without
// keeping an unbounded editing history or sharing handles between file sessions.
const ORIGINS_MAX = 8;
export class PreviewOrigins {
  private file: string | undefined;
  private readonly origins = new Map<Digest, PageOrigin>();

  remember(file: string | undefined, origin: PageOrigin | undefined): void {
    if (this.file !== file) {
      this.origins.clear();
      this.file = file;
    }
    if (origin === undefined) {
      this.origins.clear();
      return;
    }
    this.origins.set(origin.checksum, origin);
    if (this.origins.size > ORIGINS_MAX) {
      const oldest = this.origins.keys().next().value;
      if (oldest !== undefined) {
        this.origins.delete(oldest);
      }
    }
  }

  get(checksum: Digest): PageOrigin | undefined {
    return this.origins.get(checksum);
  }
}

export async function judgeRememberedClick(
  token: Digest | undefined,
  render: PreviewRender | undefined,
  path: string | undefined,
  origins: PreviewOrigins,
  check: CheckRender,
  shown: () => ShownFile | undefined,
): Promise<CanvasSelectionVerdict> {
  const current = shown();
  if (judgeLocally(token, render, current).tag === 'current') {
    return judgeCanvasEvent(token, render, check, shown);
  }
  const target = rememberedTarget(render, path, origins, current);
  if (target === undefined || render === undefined) {
    return judgeCanvasEvent(token, render, check, shown);
  }
  const latest = judgeEventToken(token, render);
  if (latest.tag === 'stale') {
    return latest;
  }
  // Replacing one known stamp must not launder a malformed original manifest.
  if ((await manifestDigest(render)) !== render.token) {
    return { tag: 'stale', reason: 'token-mismatch', file: undefined };
  }
  const stamps = render.stamps.map((stamp) => (stamp.file === target.file ? { ...stamp, checksum: target.checksum } : stamp));
  const checked = { stamps, token: await manifestDigest({ stamps }) };
  const verdict = await check(checked);
  if (verdict.tag === 'stale') {
    return verdict;
  }
  // Saving, navigation or another edit can finish while main checks the disk.
  const after = shown();
  if (after?.file === target.file && after.state.editable) {
    if (after.state.origin === target.origin) {
      const resolved = pathOfNode(after.state.model.nodes, target.id);
      if (resolved !== undefined) {
        return { tag: 'current', path: target.prefix + resolved.join('.') };
      }
    }
  }
  return { tag: 'stale', reason: 'shown-page-differs', file: target.file };
}

function rememberedTarget(render: PreviewRender | undefined, path: string | undefined, origins: PreviewOrigins, shown: ShownFile | undefined) {
  if (path === undefined || shown === undefined || !shown.state.editable) {
    return undefined;
  }
  const prefix = shown.scope ?? (path.includes('|') ? `${shown.file}|` : '');
  if (!path.startsWith(prefix)) {
    return undefined;
  }
  const stamp = render?.stamps.find((entry) => entry.file === shown.file);
  const origin = stamp === undefined ? undefined : origins.get(stamp.checksum);
  const current = shown.state.origin;
  if (origin === undefined || current === undefined) {
    return undefined;
  }
  const relative = path.slice(prefix.length);
  if (!/^\d+(?:\.\d+)*$/.test(relative)) {
    return undefined;
  }
  const indices = relative.split('.').map(Number);
  if (!indices.every((index) => Number.isSafeInteger(index) && index >= 0)) {
    return undefined;
  }
  const node = nodeAtPath(origin.model.nodes, indices);
  if (node === undefined) {
    return undefined;
  }
  return { file: shown.file, checksum: current.checksum, origin: current, id: node.id, prefix };
}

async function manifestDigest(render: Pick<PreviewRender, 'stamps'>): Promise<Digest> {
  const bytes = new TextEncoder().encode(canonicalManifest(render.stamps));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toDigest(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}
