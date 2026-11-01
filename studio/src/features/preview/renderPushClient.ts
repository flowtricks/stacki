import { createVariantPreview } from './variantClient';
import { previewHost } from '../../../vendor/stacki/electron/previewClient/morphAnchors';

export interface PreviewHot {
  readonly on: (event: string, callback: (data: unknown) => void) => void;
  readonly send: (event: string, data: unknown) => void;
}

export function receiveRenderPush(hot: PreviewHot) {
  if (previewHost(location.hash) !== 'stacki') {
    return;
  }
  const variants = createVariantPreview(hot);
  let path = location.pathname + location.search;
  let ready = false;
  let renderRevision = 0;
  const announce = () => document.dispatchEvent(new CustomEvent('studio:render-push', { detail: ready }));
  document.addEventListener('avb:preview-route', () => {
    renderRevision++;
    ready = false;
    path = location.pathname + location.search;
    variants.receive({ action: 'reset' });
    announce();
    hot.send('studio:render-subscribe', { path, encoding: 'gzip' });
  });
  hot.on('studio:render-ready', (data) => {
    if (matchesPage(data, path)) {
      ready = true;
      announce();
    }
  });
  hot.on('studio:render-pending', (data) => {
    if (matchesPage(data, path)) {
      renderRevision++;
      document.dispatchEvent(new Event('studio:render-pending'));
    }
  });
  hot.on('studio:render', (data) => {
    if (matchesPage(data, path)) {
      const revision = ++renderRevision;
      void decodeRenderedHTML(data)
        .then((html) => {
          if (html !== undefined && revision === renderRevision) {
            variants.authoritative(html);
          }
        })
        .catch(() => document.dispatchEvent(new Event('studio:render-fallback')));
    }
  });
  hot.on('studio:render-failed', (data) => {
    if (matchesPage(data, path)) {
      document.dispatchEvent(new Event('studio:render-fallback'));
    }
  });
  hot.on('vite:ws:disconnect', () => {
    renderRevision++;
    ready = false;
    announce();
  });
  hot.on('vite:ws:connect', () => hot.send('studio:render-subscribe', { path, encoding: 'gzip' }));
  document.addEventListener('studio:render-listening', announce);
  hot.send('studio:render-subscribe', { path, encoding: 'gzip' });
  return variants;
}

function matchesPage(data: unknown, path: string): data is object & { path: string } {
  return !!data && typeof data === 'object' && 'path' in data && data.path === path;
}
import { decodeRenderedHTML } from './renderDecoding';
