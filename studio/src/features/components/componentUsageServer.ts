import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { aliasMap } from '../../../vendor/stacki/electron/content/cmsRefs';
import { instanceCounts, instancesIn } from '../../../vendor/stacki/electron/properties/componentUsage';
import type { ComponentUsageFile } from '../../../vendor/stacki/src/features/palette/paletteModel';
import { walk, readSource } from '../project/projectServer';
import { packageComponentFiles } from '../../../vendor/stacki/electron/lib/componentSources';
import { componentFile } from '../../../vendor/stacki/shared/properties/componentDefaults';
import { readProjectFolders } from '../../../vendor/stacki/electron/lib/projectFolders';
import { configOf, folderHolding, foldersFor, type ProjectFolders } from '../../../vendor/stacki/shared/properties/projectFolders';

export async function scanComponentUsage(root: string, selected?: string) {
  const folders = configOf(readProjectFolders(root));
  const paths = (await walk(root, 'src')).filter((file) => file.endsWith('.astro') || /^src\/pages\/.+\.mdx?$/.test(file));
  const targets = [...packageComponentFiles(root), ...paths.filter((file) => file.endsWith('.astro') && !file.startsWith('src/pages/'))];
  if (selected && !targets.includes(selected)) {
    throw new Error('Select a component inside this project');
  }
  if (targets.length > 1000) {
    throw new Error('Component usage scan exceeds 1000 components');
  }
  const aliases = aliasMap(root);
  const sources: {
    readonly file: string;
    readonly text: string;
    readonly counts: ReturnType<typeof instanceCounts>;
  }[] = [];
  let size = 0;
  for (const file of paths) {
    const text = await readSource(root, file);
    size += text.length;
    if (size > 20_000_000) {
      throw new Error('Component usage scan exceeds 20 MB of source');
    }
    sources.push({ file, text, counts: instanceCounts(text, path.resolve(root, file), aliases) });
  }
  if (size * (selected ? 1 : targets.length) > 100_000_000) {
    throw new Error('Component usage scan exceeds the source processing limit');
  }
  return (selected ? [selected] : targets).map((target) => {
    const files: ComponentUsageFile[] = [];
    for (const { file, text, counts } of sources) {
      if (file === target) {
        continue;
      }
      const count = instancesIn(text, {
        file: path.resolve(root, file),
        targetPath: path.resolve(root, target),
        name: path.basename(target, '.astro'),
        counts,
      });
      if (count) {
        files.push({ rel: file, path: file, kind: usageKind(folders, file), count });
      }
    }
    files.sort((left, right) => right.count - left.count || left.rel.localeCompare(right.rel));
    return { file: target, files, total: files.reduce((sum, file) => sum + file.count, 0) };
  });
}

// What a using file is, by the project's folders (.stacki/folders.json; by default src/layouts and src/components).
function usageKind(folders: ProjectFolders | undefined, file: string): ComponentUsageFile['kind'] {
  if (file.startsWith('src/pages/')) {
    return 'page';
  }
  if (folderHolding(foldersFor('layouts', folders), file) !== undefined) {
    return 'layout';
  }
  if (folderHolding(foldersFor('components', folders), file) !== undefined) {
    return 'component';
  }
  return 'file';
}

export async function componentUsageRoute(root: string, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/studio/api/component-usage') {
    return false;
  }
  if (request.method !== 'GET') {
    throw new Error('Use GET for component usage');
  }
  const input = new URL(request.url ?? '/', 'http://studio').searchParams.get('file');
  const usage = await scanComponentUsage(root, input === null ? undefined : componentFile(input));
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(input === null ? usage.map(({ file, total }) => ({ file, total })) : usage[0]));
  return true;
}
