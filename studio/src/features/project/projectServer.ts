import { projectPageFolders } from '../pages/pageFolders';
import { readWorkspaceId } from './projectIdentity';
import { projectPageTitles } from './projectPageTitles';
import { ComponentAnalysis } from './componentAnalysis';
import { batchedRead } from '../../shared/batchedRead';
import { opendir, readFile, realpath, stat, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { sourcePath, filePath, MAX_SOURCE } from '../../shared/validation';
import { packageComponentFiles, readPackageSource, packageComponentImport } from '../../../vendor/stacki/electron/lib/componentSources';
import { componentSpecifier } from '../../../vendor/stacki/electron/properties/componentImports';
import { packageOf } from '../../../vendor/stacki/electron/lib/installedPackages';

export async function safePath(root: string, relative: string): Promise<string> {
  filePath(relative);
  const absolute = path.resolve(root, relative);
  const canonicalRoot = await realpath(root);
  // Walk existing ancestors before creating anything. Reject symlinks rather than
  // allowing an uploaded/project-authored link to redirect a later write.
  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('Symbolic links are not editable');
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
  try {
    const actual = await realpath(absolute);
    if (!actual.startsWith(canonicalRoot + path.sep)) {
      throw new Error('Path is outside the project');
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return absolute;
}
export async function preparePath(root: string, relative: string) {
  const absolute = await safePath(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  return safePath(root, relative);
}
export async function readSource(root: string, relative: string): Promise<string> {
  sourcePath(relative);
  const absolute = await safePath(root, relative);
  if ((await stat(absolute)).size > MAX_SOURCE) {
    throw new Error('File exceeds 1 MB limit');
  }
  return readFile(absolute, 'utf8');
}
export async function walk(root: string, directory: string): Promise<string[]> {
  const queue = [directory];
  const files: string[] = [];
  for (let index = 0; index < queue.length && index < 10_000; index++) {
    const current = queue[index];
    if (!current) {
      break;
    }
    let entries;
    try {
      entries = await opendir(path.join(root, current));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > 110_000) {
        throw new Error('Project directory exceeds its entry limit');
      }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        continue;
      }
      const relative = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (queue.length >= 10_000) {
          throw new Error('Project directory limit exceeded');
        }
        queue.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
      if (files.length > 100_000) {
        throw new Error('Project file limit exceeded');
      }
    }
  }
  return files.sort();
}
export async function scanProject(root: string, analysis = new ComponentAnalysis()) {
  const files = [...(await walk(root, 'src')), ...(await walk(root, 'public'))];
  const componentFiles = [...packageComponentFiles(root), ...files.filter((file) => file.endsWith('.astro') && !file.startsWith('src/pages/'))];
  const classes = new Set<string>();
  const components = await Promise.all(
    componentFiles.map(async (file) => {
      const source = await readComponentSource(root, file);
      // Reuse the validated component source instead of reading it twice.
      if (!file.startsWith('node_modules/')) {
        for (const name of sourceClasses(file, source)) {
          classes.add(name);
        }
      }
      const importPath = componentSpecifier(root, file);
      const owner = packageOf(file);
      return {
        file,
        name: path.basename(file, '.astro'),
        ...(importPath === undefined ? {} : { importPath }),
        ...(owner === undefined
          ? {}
          : {
              origin: {
                kind: 'package' as const,
                package: owner,
                importPath: packageComponentImport(root, file) ?? '',
              },
            }),
        ...(await analysis.read(file, source, (candidate) => readComponentSource(root, candidate))),
      };
    }),
  );
  const componentPaths = new Set(componentFiles);
  const styleFiles = files.filter((file) => /\.(css|astro)$/.test(file) && !componentPaths.has(file));
  for (const name of await scanStyleClasses(root, styleFiles)) {
    classes.add(name);
  }
  return {
    workspaceId: await readWorkspaceId(root),
    name: path.basename(root) === 'workspace' ? 'Example site' : path.basename(root),
    pages: files.filter((file) => /^src\/pages\/.+\.(astro|md|mdx)$/.test(file)),
    pageMetadata: await projectPageTitles(root, files),
    pageFolders: await projectPageFolders(root),
    collections: files.filter((file) => /^src\/(content|data)\/.+\.(json|md|mdx)$/.test(file) && !/\/studio-cms-(schema|deleted)\.json$/.test(file)),
    assets: files.filter((file) => /\.(svg|png|jpe?g|gif|webp|avif|mp4|pdf|woff2?)$/i.test(file)),
    components,
    classes: [...classes].sort(),
  };
}

async function readComponentSource(root: string, file: string): Promise<string> {
  return file.startsWith('node_modules/') ? readPackageSource(root, file) : readSource(root, file);
}

async function scanStyleClasses(root: string, files: readonly string[]) {
  const batches = await batchedRead(files, async (file) => sourceClasses(file, await readSource(root, file)));
  return new Set(batches.flat());
}

function sourceClasses(file: string, source: string): readonly string[] {
  const styles = file.endsWith('.astro') ? [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n') : source;
  return [...styles.matchAll(/\.([a-zA-Z_][\w-]*)/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}
