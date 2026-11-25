// The file a piece of frontmatter lives in, as a chip names it. A popup showing a
// declaration can be opened from a component nested in a page, and the same line
// reads differently depending on which of the two it is written in.

import { assert } from '../../../shared/core/assert';

export interface SourceFileLabel {
  readonly kind: 'page' | 'component';
  readonly name: string;
}

const PAGES_FOLDER = 'pages';
const INDEX_NAME = 'index';

/** The file's name and kind, or undefined when no file is open. */
export function sourceFileLabel(filePath: string | undefined): SourceFileLabel | undefined {
  if (filePath === undefined || filePath === '') {
    return undefined;
  }
  const parts = filePath.split(/[\\/]/).filter((part) => part !== '');
  const file = parts[parts.length - 1];
  if (file === undefined) {
    return undefined;
  }
  const stem = file.replace(/\.[^.]+$/, '');
  assert(stem.length > 0 || file.startsWith('.'), 'A file has a name before its extension');
  const pagesAt = parts.lastIndexOf(PAGES_FOLDER);
  if (pagesAt === -1) {
    return { kind: 'component', name: stem };
  }
  // `about/index.astro` is the about page; only the site's root is called index.
  const folder = parts[parts.length - 2];
  const nested = stem === INDEX_NAME && parts.length - 2 > pagesAt && folder !== undefined;
  return { kind: 'page', name: nested ? folder : stem };
}
