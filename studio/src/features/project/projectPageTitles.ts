import path from 'node:path';
import { aliasMap } from '../../../vendor/stacki/electron/content/cmsRefs';
import { resolvePageTitles, scanPageTitleSource } from '../../../vendor/stacki/electron/properties/pageTitles';
import { batchedRead } from '../../shared/batchedRead';
import { readSource } from './projectServer';

export async function projectPageTitles(root: string, files: readonly string[]) {
  // Parse one bounded batch at a time and retain only summaries, not all project source bytes.
  const summaries = await batchedRead(
    files.filter((file) => file.endsWith('.astro')),
    async (file) => [path.resolve(root, file), scanPageTitleSource(await readSource(root, file))] as const,
  );
  const sources = new Map(summaries);
  const pages = files
    .filter((file) => /^src\/pages\/.+\.astro$/.test(file))
    .map((file) => ({
      path: path.resolve(root, file),
      name: file.slice('src/pages/'.length),
      route:
        '/' +
        file
          .slice('src/pages/'.length)
          .replace(/\.astro$/, '')
          .replace(/(^|\/)index$/, ''),
    }));
  return resolvePageTitles(pages, aliasMap(root), (file) => sources.get(file)).map((page) => ({
    ...page,
    path: path.relative(root, page.path).split(path.sep).join('/'),
  }));
}
