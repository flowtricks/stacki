import { cmsIncludesGeneral } from '../lib/contentPaths';
// The CMS panel's IPC: the collections and entries a project keeps as files,
// read and written as data, with their asset references and field metadata.

import { MAIN_LIMITS, readSource, directoryBudget } from '../lib/mainLimits';
import { createProjectText, writeProjectText } from '../documents/documentWrites';
import { assert } from '../../shared/core/assert';
import { parseData } from '../app/mainValidation';
import type { CmsFile } from '../lib/mainTypes';
import * as path from 'path';
import * as fs from 'fs';
import { findCollections, replaceCollection, readGeneral, writeGeneral, GENERAL } from '../content/jsCollections';
import { defaultImports, addImport, importName, importSpecFor, withAssets } from '../project/assetRefs';
import { importersOf } from '../content/cmsRefs';
import { toPosix, capture, readJson, parseDataList } from '../lib/mainHelpers';
import { resolveImportPath } from '../properties/importPaths';
import {
  CMS_SKIP,
  PAGE_SCAN,
  isAstroRel,
  frontmatterSpan,
  frontmatterOf,
  splitCmsRel,
  cmsAbs,
  assetOfImport,
  cmsMetaPath,
  readCmsMeta,
  readCmsSource,
  readCmsJson,
} from './cmsFiles';
import type { MainHost } from './mainHost';

export function registerCmsHandlers(host: Pick<MainHost, 'ipcMain' | 'send' | 'shell'>): void {
  registerCmsListHandler(host);
  registerCmsReadHandler(host);
  registerCmsAssetRefHandler(host);
  registerCmsWriteHandler(host);
  registerCmsCreateHandlers(host);
}

function registerCmsListHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // Data modules and root constants files may hold one record of site settings.
  // Other source files retain the stricter collection rule, so internal utility
  // constants do not become CMS entries.
  ipcMain.handle('cms:list', async (_event, projectPath) => {
    const root = path.join(projectPath, 'src');
    const files: CmsFile[] = [];
    if (!fs.existsSync(root)) {
      return { files };
    }
    const checkDirectory = directoryBudget(root);
    const walk = (directory: string, rel: string, depth: number): void => {
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      checkDirectory(directory, entries.length);
      assert(depth <= MAIN_LIMITS.directoryDepthMax, 'cms:list: the budget bounds depth');
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        const full = path.join(directory, entry.name);
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          // src/assets holds files the site imports (images, Lottie JSON), not content.
          if (entryRel !== 'assets') {
            walk(full, entryRel, depth + 1);
          }
        } else if (/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(entry.name)) {
          if (!/\.d\.[cm]?ts$/i.test(entry.name)) {
            files.push(
              ...readCmsSource(full, entryRel, {
                page: false,
                includeGeneralOnly: cmsIncludesGeneral(entryRel),
              }),
            );
          }
        } else if (/\.astro$/i.test(entry.name)) {
          files.push(...readCmsSource(full, entryRel, { page: true }));
        } else if (/\.json$/i.test(entry.name) && !CMS_SKIP.test(entry.name)) {
          files.push(readCmsJson(full, entryRel, rel, entry.name));
        }
      }
    };
    walk(root, '', 0);
    files.sort((left, right) => left.rel.localeCompare(right.rel));
    return { files };
  });
}

function registerCmsReadHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('cms:read', async (_event, { projectPath, rel }) => {
    const { fileRel, exportName } = splitCmsRel(rel);
    const abs = cmsAbs(projectPath, fileRel);
    if (!exportName) {
      return { data: parseData(readJson(abs)) };
    }
    const file = readSource(abs);
    // A page's data lives in its frontmatter; everything below it is markup the
    // scanners must never see.
    const page = isAstroRel(fileRel);
    const source = page ? frontmatterOf(file) : file;
    if (source === undefined) {
      throw new Error(`src/${fileRel} has no frontmatter.`);
    }
    const scan = page ? PAGE_SCAN : undefined;
    if (exportName === GENERAL) {
      const general = readGeneral(source, scan);
      if (!general) {
        throw new Error(`src/${fileRel} has no single values left to edit.`);
      }
      return { data: general };
    }
    const col = findCollections(source, scan).find((candidate) => candidate.name === exportName);
    if (!col) {
      throw new Error(page ? `${exportName} is no longer declared in src/${fileRel}.` : `${exportName} is no longer exported from src/${fileRel}.`);
    }
    if (!col.data) {
      throw new Error(`${exportName} isn't plain data — ${col.reason}.`);
    }
    return { data: withAssets(col.data, assetOfImport(projectPath, abs, source)) };
  });
}

function registerCmsAssetRefHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // Points a data file's field at a picture. A file under public/ is served as it
  // is and needs nothing written; one under src/ is imported, so the import is
  // made — or the file's existing one for that image reused, since importing the
  // same picture twice under two names is noise — and the name handed back for
  // the value.
  ipcMain.handle('cms:assetRef', async (_event, { projectPath, rel, assetRel }) => {
    const { fileRel } = splitCmsRel(rel);
    const abs = cmsAbs(projectPath, fileRel);
    const clean = String(assetRel || '').replace(/^\/+/, '');
    const root = clean.split('/')[0];
    if (root === 'public') {
      return { value: '/' + clean.split('/').slice(1).join('/') };
    }
    if (root !== 'src') {
      throw new Error('Invalid asset path');
    }
    const target = path.resolve(projectPath, clean);
    if (!fs.existsSync(target)) {
      throw new Error(`${clean} no longer exists.`);
    }
    const file = readSource(abs);
    const page = isAstroRel(fileRel);
    const span = page ? frontmatterSpan(file) : undefined;
    if (page && !span) {
      throw new Error(`src/${fileRel} has no frontmatter.`);
    }
    const source = span ? file.slice(span.start, span.end) : file;
    const imports = defaultImports(source);
    const already = imports.find((i) => resolveImportPath(projectPath, abs, i.spec) === target);
    if (already) {
      return { name: already.name, asset: clean };
    }
    const fromHere = toPosix(path.relative(path.dirname(abs), target));
    const spec = importSpecFor({
      imports,
      srcRelative: toPosix(path.relative(path.join(projectPath, 'src'), target)),
      relative: fromHere.startsWith('.') ? fromHere : './' + fromHere,
    });
    const name = importName(
      clean,
      imports.map((i) => i.name),
    );
    const next = addImport(source, name, spec);
    const written = span ? file.slice(0, span.start) + next + file.slice(span.end) : next;
    writeProjectText(abs, written);
    return { name, asset: clean };
  });
}

function registerCmsWriteHandler({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>): void {
  // Writes the collection back, matching the file's existing indentation so
  // the diff stays limited to what the user actually changed.
  ipcMain.handle('cms:write', async (_event, { projectPath, rel, data }) => {
    const { fileRel, exportName } = splitCmsRel(rel);
    if (exportName) {
      const abs = cmsAbs(projectPath, fileRel);
      if (!fs.existsSync(abs)) {
        throw new Error(`src/${fileRel} no longer exists.`);
      }
      // Only the edited span is rewritten — imports, comments and the file's
      // other exports are left exactly as they were.
      const file = readSource(abs);
      // Only the frontmatter is handed to the writer for a page, and only its
      // span is spliced back — the markup below is never re-serialized.
      const page = isAstroRel(fileRel);
      const span = page ? frontmatterSpan(file) : undefined;
      if (page && !span) {
        throw new Error(`src/${fileRel} has no frontmatter.`);
      }
      const source = span ? file.slice(span.start, span.end) : file;
      const scan = page ? PAGE_SCAN : undefined;
      const written =
        exportName === GENERAL
          ? writeGeneral(source, data && typeof data === 'object' && !Array.isArray(data) ? data : {}, scan)
          : replaceCollection(source, exportName, parseDataList(data), scan);
      if (written === undefined) {
        throw new Error(`Couldn't write ${exportName} back into src/${fileRel}.`);
      }
      const next = span ? file.slice(0, span.start) + written + file.slice(span.end) : written;
      writeProjectText(abs, next);
      // Editing a page's own frontmatter changes a file the editor may have
      // open. Our writes are invisible to the watcher, so say so directly —
      // otherwise the model would keep the old data and write it back over this.
      if (page) {
        send('fs:changed', { files: [abs] });
      }
      return { ok: true as const };
    }
    const abs = cmsAbs(projectPath, rel);
    // A save still in flight when the collection is deleted must not recreate
    // the file — the editor closes a moment after the delete lands.
    if (!fs.existsSync(abs)) {
      throw new Error(`src/${rel} no longer exists.`);
    }
    let indent: string | number = 2;
    let trailingNewline = true;
    const before = readSource(abs);
    const match = before.match(/\n([ \t]+)\S/);
    if (match) {
      indent = capture(match, 1) === '\t' ? '\t' : capture(match, 1).length;
    }
    trailingNewline = /\n$/.test(before);
    const json = JSON.stringify(data, null, indent) + (trailingNewline ? '\n' : '');
    writeProjectText(abs, json);
    return { ok: true as const };
  });
}

function registerCmsCreateHandlers({ ipcMain, send, shell }: Pick<MainHost, 'ipcMain' | 'send' | 'shell'>): void {
  // New collections land in src/data/, the conventional home for Astro content
  // that isn't a content collection.
  ipcMain.handle('cms:create', async (_event, { projectPath, name }) => {
    const slug = String(name)
      .trim()
      .toLowerCase()
      .replace(/\.json$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) {
      throw new Error('Give the collection a name.');
    }
    const rel = `data/${slug}.json`;
    const abs = cmsAbs(projectPath, rel);
    if (fs.existsSync(abs)) {
      throw new Error(`src/${rel} already exists.`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    createProjectText(abs, '[]\n');
    send('cms:changed', {});
    return { rel };
  });

  ipcMain.handle('cms:meta', async (_event, projectPath) => ({ meta: readCmsMeta(projectPath) }));

  ipcMain.handle('cms:setMeta', async (_event, { projectPath, rel, fields }) => {
    const meta = readCmsMeta(projectPath);
    if (fields && Object.keys(fields).length) {
      meta[rel] = fields;
    } else {
      delete meta[rel];
    }
    const file = cmsMetaPath(projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return { ok: true as const };
  });

  // Deleting a collection rewrites the pages that imported it (see cmsRefs.js):
  // the import becomes `const clients = []`, which leaves every
  // `clients.map(...)` on the page working and rendering nothing.

  ipcMain.handle('cms:usage', async (_event, { projectPath, rel }) => {
    const abs = cmsAbs(projectPath, splitCmsRel(rel).fileRel);
    return { files: importersOf(projectPath, abs).map((hit) => hit.rel) };
  });

  ipcMain.handle('cms:delete', async (_event, { projectPath, rel }) => {
    // An export shares its file with other code, so there's no file to trash and
    // removing the statement is a code edit, not a content one.
    if (splitCmsRel(rel).exportName) {
      throw new Error('This collection is an export inside a source file — remove it in code.');
    }
    const abs = cmsAbs(projectPath, rel);
    const hits = importersOf(projectPath, abs);
    for (const hit of hits) {
      writeProjectText(hit.file, hit.next);
    }
    await shell.trashItem(abs);
    const meta = readCmsMeta(projectPath);
    if (meta[rel]) {
      delete meta[rel];
      fs.writeFileSync(cmsMetaPath(projectPath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
    send('cms:changed', {});
    // Our own writes are invisible to the watcher, so tell the app directly —
    // an open page holding the old import needs to reload.
    if (hits.length) {
      send('fs:changed', { files: hits.map((hit) => hit.file) });
    }
    return { ok: true as const, rewritten: hits.map((hit) => hit.rel) };
  });
}
