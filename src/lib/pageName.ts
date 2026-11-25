import type { ScanPage } from '../../shared/properties/projectScan';
import { BOUNDARY_LIMITS, pathText } from '../../shared/core/boundary';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../shared/properties/i18n/messageRef';

// The one source of a page's display name. It lives in the lowest layer because
// the Pages panel and the link field are separate features, and they must never
// disagree on what a page is called.
export function pageDisplayName(page: Pick<ScanPage, 'name' | 'title'>): string {
  return pageDisplayLabel(page, ENGLISH_TRANSLATE);
}

/** The same name in the language on screen: "Home" and "Template" are words of the interface, the rest comes from the project. */
export function pageDisplayLabel(page: Pick<ScanPage, 'name' | 'title'>, translate: Translator): string {
  if (/^index\.(astro|mdx?)$/i.test(page.name)) {
    return translate('ui.page.home');
  }
  const parts = pageSegments(page.name);
  const base = stripPageExtension(parts.at(-1) ?? page.name);
  if (/^\[(?:\.\.\.)?[^\]]+\]$/.test(base)) {
    // Template names explain the collection; file and route identities remain untouched.
    const folder = parts.at(-2);
    const folderName = folder === undefined ? translate('ui.page.fallback') : pageFolderDisplayName(folder.replace(/[\[\]]/g, ''));
    return translate('ui.page.template', { name: folderName });
  }
  const title = page.title?.trim();
  return title || base;
}

export function pageFolderDisplayName(name: string): string {
  pathText(name);
  const words = name.split(/[-\s]+/).filter((word) => word.length > 0);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || name;
}

export function stripPageExtension(base: string): string {
  return base.replace(/\.(astro|mdx?)$/i, '');
}

export function pageSegments(rel: string): readonly string[] {
  pathText(rel);
  const parts = rel.split('/');
  if (parts.length > BOUNDARY_LIMITS.depthMax) {
    throw new Error('Page tree: path depth exceeds limit');
  }
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Page tree: expected relative path segments');
  }
  return parts;
}
