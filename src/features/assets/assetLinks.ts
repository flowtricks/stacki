// "Copy link" and "Open link" on an asset tile. A hosted file's link is its
// public URL. A project file's link is the path a page references it by:
//   - public/ files are served from the site root, so `public/images/x.png`
//     is `/images/x.png`, the same value a picked public asset writes
//     (src/ui/assetPath.ts, assetValueFor);
//   - src/ files are imported, not served, and the import is relative to the
//     file that writes it, which the panel does not know. The link is the
//     project-root import `/src/assets/x.png`, which Vite (and so Astro)
//     resolves from any file in the project.
import { assert } from '../../../shared/core/assert';
import { openHostedLink } from '../../ipc/mediaHostingBridge';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

export function localAssetLink(rel: string): string {
  assert(rel.length > 0, 'An asset link names a file');
  assert(!rel.startsWith('/'), 'An asset path is relative to the project');
  const link = rel.startsWith('public/') ? `/${rel.slice('public/'.length)}` : `/${rel}`;
  assert(link.startsWith('/'), 'A link is root-relative');
  return link;
}

/** Copies a link and says so; a refused clipboard says that instead. */
export async function copyLink(link: string, translate: Translator, showToast: (message: string, kind: 'error' | 'success') => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(link);
  } catch (error: unknown) {
    showToast(translate('assets.link.copyFailed', { error: error instanceof Error ? error.message : String(error) }), 'error');
    return;
  }
  showToast(translate('assets.link.copied'), 'success');
}

/** Opens a hosted file in the browser. */
export function openLink(url: string): Promise<void> {
  return openHostedLink(url);
}
