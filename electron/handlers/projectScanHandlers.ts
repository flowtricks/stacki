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
import { toPosix } from '../lib/mainHelpers';
import { classNamesIn, classSourceKind } from '../../shared/page/classNames';
import { listAstroFiles, routeForPage } from '../project/projectFiles';
import { scanPageTitles } from '../properties/pageTitles';
import { safeSchema } from '../properties/propDefaults';
import type { MainHost } from './mainHost';
import { packageComponentFiles, packageComponentImport } from '../lib/componentSources';
import { packageOf } from '../lib/installedPackages';
import { readLengthUnit } from '../project/lengthUnitMarkers';
import { readProjectFolders } from '../lib/projectFolders';
import { readAstroPages, type AstroPages } from '../lib/astroConfig';
import { componentGroup, configOf, foldersFor } from '../../shared/properties/projectFolders';

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
    // Which folders hold components and layouts is the project's choice
    // (.stacki/folders.json); without one, src/components and src/layouts.
    const folders = configOf(readProjectFolders(projectPath));
    const layoutFolders = foldersFor('layouts', folders);
    const componentFolders = foldersFor('components', folders);

    const pages = listAstroFiles(pagesDirectory).map((filePath) => ({
      path: filePath,
      name: toPosix(path.relative(pagesDirectory, filePath)),
      route: routeForPage(projectPath, filePath),
    }));

    const pageFolders = listPageFolders(pagesDirectory);

    // `folder` groups these in the components panel. Layouts are relative to
    // src, so they read as the folder they're actually in ("layouts", or
    // "layouts/marketing"); components are relative to their component folder,
    // whose own root is the ungrouped case (componentGroup in projectFolders.ts).
    const layoutFiles = filesUnder(projectPath, layoutFolders);
    const layouts = layoutFiles.map((filePath) => ({
      path: filePath,
      file: toPosix(path.relative(projectPath, filePath)),
      name: path.basename(filePath, '.astro'),
      folder: toPosix(path.relative(sourceDirectory, path.dirname(filePath))),
      instances: 0,
      isLayout: true,
      ...safeSchema(filePath, projectPath),
    }));

    // A file in a layout folder is a layout, even when a component folder also covers it.
    const isLayoutFile = new Set(layoutFiles);
    const ownComponents = filesUnder(projectPath, componentFolders)
      .filter((filePath) => !isLayoutFile.has(filePath))
      .map((filePath) => {
        const file = toPosix(path.relative(projectPath, filePath));
        return {
          path: filePath,
          file,
          name: path.basename(filePath, '.astro'),
          folder: componentGroup(componentFolders, file),
          instances: 0,
          ...safeSchema(filePath, projectPath),
        };
      });
    const packageComponents = packageComponentFiles(projectPath)
      .map((file) => path.join(projectPath, file))
      .map((filePath) => ({
        path: filePath,
        name: path.basename(filePath, '.astro'),
        // Relative to src/components, as a package component always has been.
        folder: toPosix(path.relative(path.join(sourceDirectory, 'components'), path.dirname(filePath))),
        instances: 0,
        ...safeSchema(filePath, projectPath),
        ...scanComponentOrigin(projectPath, filePath),
      }));
    const components = [...ownComponents, ...packageComponents];

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
      lengthUnit: readLengthUnit(projectPath),
      // Shown in Settings → Folders; the scan itself still reads src/pages (docs/contracts.md).
      ...astroPagesFields(readAstroPages(projectPath)),
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
  // Every CSS class name used anywhere under src/ and public/ — written in
  // markup, added or queried by scripts, styled by stylesheets and <style>
  // blocks — for the class field's suggestions in the props panel. public/
  // holds files served as they are: a stylesheet linked from the page, a
  // script, plain HTML, each with classes the page uses.
  ipcMain.handle('project:classes', async (_event, projectPath) => {
    const out = new Set<string>();
    const exts = /\.(astro|css|scss|sass|less|html|jsx|tsx|js|mjs|cjs|ts|mts|cts|vue|svelte|mdx)$/i;
    const files: string[] = [];
    // One budget over both folders: together they are bounded as one walk.
    const checkDirectory = directoryBudget(projectPath);
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
    for (const folder of ['src', 'public']) {
      walk(path.join(projectPath, folder), 1);
    }

    // shared/page/classNames.ts reads each file: markup, scripts and stylesheets alike.
    for (const file of files) {
      const kind = classSourceKind(file);
      if (kind === undefined) {
        continue;
      }
      let content;
      try {
        content = readSource(file);
      } catch {
        continue;
      }
      for (const name of classNamesIn(content, kind)) {
        out.add(name);
      }
    }
    return [...out].sort();
  });
}

// The .astro files under each project-relative folder, once each, in folder order.
function filesUnder(projectPath: string, folders: readonly string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const folder of folders) {
    for (const file of listAstroFiles(path.join(projectPath, ...folder.split('/')))) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  assert(files.length === seen.size, 'filesUnder: each file is listed once');
  return files;
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

function astroPagesFields(pages: AstroPages) {
  return { pagesFolder: pages.pagesFolder, ...(pages.configFile === undefined ? {} : { astroConfig: pages.configFile }) };
}
