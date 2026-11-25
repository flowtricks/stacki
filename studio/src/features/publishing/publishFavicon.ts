import { stackiPublishingFavicon } from '../../shared/stackiBrand';

export function showPublishingFavicon(document: Document): () => void {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const icon = existing ?? document.createElement('link');
  const original = { href: icon.getAttribute('href'), type: icon.getAttribute('type') };
  icon.rel = 'icon';
  icon.type = 'image/svg+xml';
  icon.href = stackiPublishingFavicon;
  if (!existing) {
    document.head.append(icon);
  }
  return () => {
    if (!existing) {
      icon.remove();
      return;
    }
    for (const attribute of ['href', 'type'] as const) {
      const value = original[attribute];
      if (value === null) {
        icon.removeAttribute(attribute);
      } else {
        icon.setAttribute(attribute, value);
      }
    }
  };
}
