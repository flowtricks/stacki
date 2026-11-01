// The project scan IPC: the pages, layouts and components a project holds with
// their prop schemas, and the classes its sources use.

import { MAIN_LIMITS, readSource, directoryBudget } from '../lib/mainLimits';
import { sameFilesystemPath } from '../lib/platform';
import { ensureExcluded } from '../lib/projectExclusions';
import { isAtomicTemporary } from '../documents/atomicWrite';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import * as fs from 'fs';
import { aliasMap, type Alias } from '../content/cmsRefs';
import { instanceCounts, instancesIn } from '../properties/componentUsage';
import { toPosix, capture } from '../lib/mainHelpers';
import { listAstroFiles, routeForPage } from '../project/projectFiles';
import { scanPageTitles } from '../properties/pageTitles';
import { safeSchema } from '../properties/propDefaults';
import type { MainHost } from './mainHost';
import { packageComponentFiles, packageComponentImport } from '../lib/componentSources';
import { packageOf } from '../lib/installedPackages';

export function registerProjectScanHandlers(host: Pick<MainHost, 'ipcMain' | 'noteProjectRoot' | 'readTrailingSlash'>): void {
  registerProjectScanHandler(host);
  registerProjectClassesHandler(host);
}

function registerProjectScanHandler({
  ipcMain,
  noteProjectRoot,
  readTrailingSlash,
}: Pick<MainHost, 'ipcMain' | 'noteProjectRoot' | 'readTrailingSlash'>): void {
  ipcMain.handle('project:scan', async (_event, projectPath) => {
    // Also set here, not just in watch:start — the Assets panel can render
    // thumbnails before the watcher starts, and they'd be refused.
    noteProjectRoot(projectPath);
    ensureExcluded(projectPath);
    const sourceDirectory = path.join(projectPath, 'src');
    const pagesDirectory = path.join(sourceDirectory, 'pages');
    const layoutsDirectory = path.join(sourceDirectory, 'layouts');
    const componentsDirectory = path.join(sourceDirectory, 'components');

    const pages = listAstroFiles(pagesDirectory).map((filePath) => ({
      path: filePath,
      name: toPosix(path.relative(pagesDirectory, filePath)),
      route: routeForPage(projectPath, filePath),
    }));

    const pageFolders = listPageFolders(pagesDirectory);

    // `folder` groups these in the components panel. Layouts are relative to
    // src, so they read as the folder they're actually in ("layouts", or
    // "layouts/marketing"); components are relative to src/components, whose
    // own root is the ungrouped case.
    const layouts = listAstroFiles(layoutsDirectory).map((filePath) => ({
      path: filePath,
      name: path.basename(filePath, '.astro'),
      folder: toPosix(path.relative(sourceDirectory, path.dirname(filePath))),
      instances: 0,
      isLayout: true,
      ...safeSchema(filePath, projectPath),
    }));

    const components = [...listAstroFiles(componentsDirectory), ...packageComponentFiles(projectPath).map((file) => path.join(projectPath, file))].map(
      (filePath) => ({
        path: filePath,
        name: path.basename(filePath, '.astro'),
        folder: toPosix(path.relative(componentsDirectory, path.dirname(filePath))),
        instances: 0,
        ...safeSchema(filePath, projectPath),
        ...scanComponentOrigin(projectPath, filePath),
      }),
    );

    // Instance counts: how often each component is used across every .astro
    // file in src (pages, layouts, and other components).
    const importAliases = aliasMap(projectPath);
    const allSources = listAstroFiles(sourceDirectory).map((file) => scanCountSource(file, importAliases));
    // Layouts are counted too: they show up in the palette alongside
    // components, so the instance line has to mean the same thing for both.
    // Counted by the same function the "where is it used" list counts with —
    // when the number and the list disagree, nothing says which one is wrong.
    // That function counts under the name each FILE imports it as: a layout
    // imported as `Layout` is never written `<BaseLayout>`, and counting the
    // filename found none of them.
    for (const comp of [...components, ...layouts]) {
      comp.instances = allSources.reduce(
        (count, { file, text, counts }) =>
          count +
          (sameFilesystemPath(file, comp.path)
            ? 0 // a file is not one of its own users
            : instancesIn(text, {
                file,
                targetPath: comp.path,
                name: comp.name,
                counts,
              })),
        0,
      );
    }

    return {
      pages: scanPageTitles(pages, allSources, importAliases),
      layouts,
      components,
      pageFolders,
      trailingSlash: readTrailingSlash(projectPath),
    };
  });
}

function scanCountSource(file: string, aliases: readonly Alias[]) {
  let text = '';
  try {
    text = readSource(file);
  } catch {
    // Unreadable files contribute no instances, matching the source scan above.
  }
  return { file, text, counts: instanceCounts(text, file, aliases) };
}

function scanComponentOrigin(root: string, file: string) {
  const importPath = packageComponentImport(root, file);
  if (importPath === undefined) {
    return {};
  }
  const owner = packageOf(file);
  assert(owner !== undefined, 'Package components have an installed owner');
  return { origin: { kind: 'package' as const, package: owner, importPath } };
}

function registerProjectClassesHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // Every CSS class name used anywhere under src/ — class attributes in markup
  // plus selectors in stylesheets and <style> blocks — for the class-prop
  // autocomplete in the props panel.
  ipcMain.handle('project:classes', async (_event, projectPath) => {
    const out = new Set<string>();
    const exts = /\.(astro|css|scss|less|html|jsx|tsx|js|ts|vue|svelte)$/i;
    const files: string[] = [];
    const checkDirectory = directoryBudget(path.join(projectPath, 'src'));
    const walk = (folder: string, depth: number): void => {
      let entries;
      try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
      } catch {
        return;
      }
      checkDirectory(folder, entries.length);
      assert(depth <= MAIN_LIMITS.directoryDepthMax, 'project:classes: the budget bounds depth');
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (exts.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(path.join(projectPath, 'src'), 0);

    const addCssClasses = (css: string) => {
      const re = /(?:^|[\s,{>~+()])\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
      let match;
      while ((match = re.exec(css)) !== null) {
        out.add(capture(match, 1));
      }
    };
    for (const file of files) {
      let content;
      try {
        content = readSource(file);
      } catch {
        continue;
      }
      if (/\.(css|scss|less)$/i.test(file)) {
        addCssClasses(content);
        continue;
      }
      const attrRe = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let match;
      while ((match = attrRe.exec(content)) !== null) {
        for (const token of (match[1] ?? match[2] ?? '').split(/\s+/)) {
          if (token) {
            out.add(token);
          }
        }
      }
      const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
      let sm;
      while ((sm = styleRe.exec(content)) !== null) {
        addCssClasses(capture(sm, 1));
      }
    }
    return [...out].sort();
  });
}

// Folders under src/pages (including empty ones) for the pages tree.
function listPageFolders(pagesDirectory: string): string[] {
  const pageFolders: string[] = [];
  if (fs.existsSync(pagesDirectory)) {
    const checkDirectory = directoryBudget(pagesDirectory);
    const walkDirectories = (folder: string, depth: number): void => {
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      checkDirectory(folder, entries.length);
      assert(depth <= MAIN_LIMITS.directoryDepthMax, 'project:scan: the budget bounds depth');
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const full = path.join(folder, entry.name);
        // Internal save folders, including old staging, are never page folders.
        if (entry.name === '.stacki' || isAtomicTemporary(full)) {
          continue;
        }
        pageFolders.push(toPosix(path.relative(pagesDirectory, full)));
        walkDirectories(full, depth + 1);
      }
    };
    walkDirectories(pagesDirectory, 0);
  }
  return pageFolders;
}
