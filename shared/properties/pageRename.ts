import { pathText, record } from '../core/boundary';
import { DescribedError } from './describedError';
import { described } from './i18n/messageRef';

export interface PageRename {
  readonly kind: 'page' | 'folder';
  /** Source identities are relative to src/pages, never display labels. */
  readonly from: string;
  readonly to: string;
}

export function parsePageRename(input: unknown): PageRename {
  const value = record(input);
  const kind = value['kind'];
  if (kind !== 'page' && kind !== 'folder') {
    throw new DescribedError(described('pages.rename.error.nothingChosen'));
  }
  const from = renamePath(value['from']);
  const to = renamePath(value['to']);
  if (kind === 'page') {
    if (!/\.(astro|md|mdx)$/i.test(from) || !/\.(astro|md|mdx)$/i.test(to)) {
      throw new DescribedError(described('pages.rename.error.pageExtension'));
    }
  }
  const parameters = (file: string) => file.match(/\[[^\]]+\]/g)?.join('/') ?? '';
  if (parameters(from) !== parameters(to)) {
    throw new DescribedError(described('pages.rename.error.dynamicParameters'));
  }
  return { kind, from, to };
}

export function renamePath(input: unknown): string {
  const value = pathText(input);
  if (value.length === 0 || value.length > 500 || /[\\?#%\x00-\x1f]/.test(value)) {
    throw new DescribedError(described('pages.rename.error.invalidPath'));
  }
  const parts = value.split('/');
  if (parts.length > 32 || parts.some((part) => ['', '.', '..'].includes(part))) {
    throw new DescribedError(described('pages.rename.error.outsidePages'));
  }
  if (parts.some((part) => !/^[\w.\[\] -]+$/.test(part))) {
    throw new DescribedError(described('pages.rename.error.pathCharacters'));
  }
  return value;
}

export function renamedPagePath(file: string, change: PageRename): string {
  if (file === change.from) {
    return change.to;
  }
  if (change.kind === 'folder' && file.startsWith(change.from + '/')) {
    return change.to + file.slice(change.from.length);
  }
  return file;
}

export function pageURLPath(file: string): string {
  const route = file.replace(/\.(astro|mdx?)$/i, '').replace(/(^|\/)index$/, '');
  return '/' + route.replace(/\/$/, '');
}
