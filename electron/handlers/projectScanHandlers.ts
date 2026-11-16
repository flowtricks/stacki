// The project scan IPC: the pages, layouts and components a project holds with
// their prop schemas, and the classes its sources use.

import { readSource } from '../lib/mainLimits';
import { sameFilesystemPath } from '../lib/platform';
import { ensureExcluded } from '../lib/projectExclusions';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import { aliasMap, type Alias } from '../content/cmsRefs';
import { instanceCounts, instancesIn } from '../properties/componentUsage';
import { toPosix } from '../lib/mainHelpers';
import { classNamesIn, classSourceKind } from '../../shared/page/classNames';
import { astroListingSliced, foldersSliced, hasDependencies, routeForPage } from '../project/projectFiles';
import { walkFolderSliced, type WalkProblem } from '../project/projectWalk';
import { detectPackageManager } from '../project/packageManager';
import { configWarnings, dependencyWarning, stepFailedWarning, walkWarnings } from '../project/scanWarnings';
import type { ScanPage, ScanWarning } from '../../shared/properties/projectScan';
import { pageTitlesSliced } from '../properties/pageTitles';
import { safeSchema } from '../properties/propDefaults';
import type { MainHost } from './mainHost';
import { packageComponentFilesSliced, packageComponentImport } from '../lib/componentSources';
import { runSliced, type SlicedWork } from '../lib/slicedWork';
import { packageOf } from '../lib/installedPackages';
import { readLengthUnit } from '../project/lengthUnitMarkers';
import { readProjectFolders } from '../lib/projectFolders';
import { readAstroPages, type AstroPages } from '../lib/astroConfig';
import { componentGroup, configOf, foldersFor, type ProjectFolders } from '../../shared/properties/projectFolders';

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
    const run = new ScanRun(projectPath);
    run.step('git exclusions', undefined, () => ensureExcluded(projectPath));
    const scan = await runSliced(projectScanSliced(projectPath, run));
    return { ...scan, trailingSlash: run.step('trailing slash', 'ignore', () => readTrailingSlash(projectPath)), warnings: run.warnings() };
  });
}

// The scan is written once for both drivers (lib/slicedWork.ts). Its cost grows with the project:
// every page is listed, parsed for its title and read to count component instances. None of it is
// capped, so a project of thousands of pages and hundreds of components is one long run that
// yields to the event loop after each unit (a folder, a file, a component), never a refusal.
function* projectScanSliced(projectPath: string, run: ScanRun) {
  const config = run.step('astro.config', readAstroPages(projectPath), () => readAstroPages(projectPath));
  const sourceDirectory = path.join(projectPath, 'src');
  // Pages come from `<srcDir>/pages` (a literal srcDir in the config); a computed one reads as src.
  const pagesDirectory = path.join(projectPath, ...config.pagesFolder.split('/'));
  // Which folders hold components and layouts is the project's choice
  // (.stacki/folders.json); without one, src/components and src/layouts.
  const folders = run.step<ProjectFolders | undefined>('folder settings', undefined, () => configOf(readProjectFolders(projectPath)));
  const layoutFolders = foldersFor('layouts', folders);
  const componentFolders = foldersFor('components', folders);

  const pages = (yield* run.listing('pages', pagesDirectory, { pagesDirectory })).map((filePath) => ({
    path: filePath,
    name: toPosix(path.relative(pagesDirectory, filePath)),
    route: routeForPage(pagesDirectory, filePath),
  }));

  const pageFolders = [...(yield* run.folders(pagesDirectory))];

  // `folder` groups these in the components panel. Layouts are relative to
  // src, so they read as the folder they're actually in ("layouts", or
  // "layouts/marketing"); components are relative to their component folder,
  // whose own root is the ungrouped case (componentGroup in projectFolders.ts).
  const layoutFiles = yield* run.filesUnder(projectPath, layoutFolders);
  const layouts = [];
  for (const filePath of layoutFiles) {
    layouts.push({
      path: filePath,
      file: toPosix(path.relative(projectPath, filePath)),
      name: path.basename(filePath, '.astro'),
      folder: toPosix(path.relative(sourceDirectory, path.dirname(filePath))),
      instances: 0,
      isLayout: true,
      ...safeSchema(filePath, projectPath),
    });
    yield;
  }

  // A file in a layout folder is a layout, even when a component folder also covers it.
  const isLayoutFile = new Set(layoutFiles);
  const ownComponents = [];
  for (const filePath of (yield* run.filesUnder(projectPath, componentFolders)).filter((candidate) => !isLayoutFile.has(candidate))) {
    const file = toPosix(path.relative(projectPath, filePath));
    ownComponents.push({
      path: filePath,
      file,
      name: path.basename(filePath, '.astro'),
      folder: componentGroup(componentFolders, file),
      instances: 0,
      ...safeSchema(filePath, projectPath),
    });
    yield;
  }
  const packageComponents = [];
  for (const file of yield* run.guard('package components', [], () => packageComponentFilesSliced(projectPath))) {
    const filePath = path.join(projectPath, file);
    packageComponents.push({
      path: filePath,
      name: path.basename(filePath, '.astro'),
      // Relative to src/components, as a package component always has been.
      folder: toPosix(path.relative(path.join(sourceDirectory, 'components'), path.dirname(filePath))),
      instances: 0,
      ...safeSchema(filePath, projectPath),
      ...scanComponentOrigin(projectPath, filePath),
    });
    yield;
  }
  const components = [...ownComponents, ...packageComponents];

  // Instance counts: how often each component is used across every .astro
  // file in src (pages, layouts, and other components).
  const importAliases = run.step('import aliases', [], () => aliasMap(projectPath));
  const allSources: Array<ReturnType<typeof scanCountSource>> = [];
  for (const file of yield* run.listing('sources', sourceDirectory, { pagesDirectory })) {
    allSources.push(scanCountSource(file, importAliases));
    yield;
  }
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
    // One component against every source is the unit: components times pages is the work, and it
    // is the product of two counts that nothing bounds, so it yields per component.
    yield;
  }

  const manager = run.step('package manager', undefined, () => detectPackageManager(projectPath));
  run.addAll(configWarnings(config));
  if (!hasDependencies(projectPath)) {
    run.add(dependencyWarning(manager ?? 'npm'));
  }

  return {
    pages: yield* run.guard<readonly ScanPage[]>('page titles', pages, () => pageTitlesSliced(pages, allSources, importAliases)),
    layouts,
    components,
    pageFolders,
    lengthUnit: run.step<ReturnType<typeof readLengthUnit>>('length unit', { kind: 'px' }, () => readLengthUnit(projectPath)),
    // Shown in Settings → Folders; pages are read from this folder (docs/contracts.md).
    ...astroPagesFields(config),
    ...(manager === undefined ? {} : { packageManager: manager }),
  };
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
  ipcMain.handle('project:classes', async (_event, projectPath) => runSliced(projectClassesSliced(projectPath)));
}

// Written once for both drivers (lib/slicedWork.ts): a project with tens of thousands of files is
// a longer walk and a longer read, each file a unit the sliced driver yields after.
function* projectClassesSliced(projectPath: string): SlicedWork<string[]> {
  const out = new Set<string>();
  const exts = /\.(astro|css|scss|sass|less|html|jsx|tsx|js|mjs|cjs|ts|mts|cts|vue|svelte|mdx)$/i;
  const files: string[] = [];
  // src/ and public/ are walked with the project walker: links are followed once, and a folder
  // that cannot be read is skipped, so one odd folder does not hide every class.
  for (const folder of ['src', 'public']) {
    yield* walkFolderSliced(path.join(projectPath, folder), (entry) => {
      if (entry.kind === 'directory') {
        return entry.name === 'node_modules' ? 'skip' : 'descend';
      }
      if (exts.test(entry.name)) {
        files.push(entry.path);
      }
      return undefined;
    });
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
    yield;
  }
  return [...out].sort();
}

// One scan's bookkeeping. A step that throws is reported and replaced by its fallback, so one
// odd file or folder cannot hide the rest of the project: the scan is read-only inventory, so
// a partial answer with a named warning serves the user better than an error with none.
class ScanRun {
  private readonly problems: WalkProblem[] = [];
  private readonly added: ScanWarning[] = [];

  constructor(private readonly projectPath: string) {}

  step<T>(name: string, fallback: T, work: () => T): T {
    try {
      return work();
    } catch (error: unknown) {
      this.added.push(stepFailedWarning(name, error));
      return fallback;
    }
  }

  *guard<T>(name: string, fallback: T, work: () => SlicedWork<T>): SlicedWork<T> {
    try {
      return yield* work();
    } catch (error: unknown) {
      this.added.push(stepFailedWarning(name, error));
      return fallback;
    }
  }

  add(warning: ScanWarning): void {
    this.added.push(warning);
  }

  addAll(warnings: readonly ScanWarning[]): void {
    this.added.push(...warnings);
  }

  /** The .astro files (and a pages folder's Markdown) under `directory`; what could not be read becomes a warning. */
  *listing(name: string, directory: string, options: { readonly pagesDirectory?: string }): SlicedWork<readonly string[]> {
    const listing = yield* this.guard(name, { files: [], problems: [] }, () => astroListingSliced(directory, options));
    this.problems.push(...listing.problems);
    return listing.files;
  }

  *folders(directory: string): SlicedWork<readonly string[]> {
    const listing = yield* this.guard('page folders', { folders: [], problems: [] }, () => foldersSliced(directory));
    this.problems.push(...listing.problems);
    return listing.folders;
  }

  // The .astro files under each project-relative folder, once each, in folder order.
  *filesUnder(projectPath: string, folders: readonly string[]): SlicedWork<string[]> {
    const seen = new Set<string>();
    const files: string[] = [];
    for (const folder of folders) {
      for (const file of yield* this.listing(folder, path.join(projectPath, ...folder.split('/')), {})) {
        if (!seen.has(file)) {
          seen.add(file);
          files.push(file);
        }
      }
    }
    assert(files.length === seen.size, 'filesUnder: each file is listed once');
    return files;
  }

  warnings(): readonly ScanWarning[] {
    return [...walkWarnings(this.projectPath, this.problems), ...this.added];
  }
}

function astroPagesFields(pages: AstroPages) {
  return { pagesFolder: pages.pagesFolder, ...(pages.configFile === undefined ? {} : { astroConfig: pages.configFile }) };
}
