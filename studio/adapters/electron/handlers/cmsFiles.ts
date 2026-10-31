// The files behind the CMS panel: collection folders, an entry's
// frontmatter, its asset imports, and the panel's own field metadata.

import { MAIN_LIMITS, readSource } from '../lib/mainLimits';
import { isPathWithin } from '../lib/platform';
import { parseContentConfig } from '../app/mainValidation';
import type { CmsFile } from '../lib/mainTypes';
import * as path from 'path';
import * as fs from 'fs';
import { findCollections, readGeneral, GENERAL } from '../content/jsCollections';
import { defaultImports } from '../project/assetRefs';
import { readContentConfig } from '../content/contentConfig';
import { toPosix, errorMessage, readJson, parseData, parseRecord } from '../lib/mainHelpers';
import { resolveImportPath } from '../properties/importPaths';
import { MEDIA_EXT } from '../project/assetFiles';

// ---------------------------------------------------------------------------
// CMS — JSON data files under src/ edited as collections
// ---------------------------------------------------------------------------

// Config files that happen to live in src/ aren't content.
export const CMS_SKIP =
  /^(tsconfig|jsconfig|package|package-lock|studio-cms-schema|studio-cms-deleted|env\.d)\.json$/i;

// How a page's frontmatter is scanned: no exports there, and a list of plain
// strings is the content itself rather than a constant.
export const PAGE_SCAN = { requireExport: false, allowPlainLists: true };

export const isAstroRel = (rel: string) => /\.astro$/i.test(String(rel || ''));

// The frontmatter's own span, so a page's data can be read and written without
// the scanners ever seeing its markup.
export function frontmatterSpan(source: string) {
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) {
    return undefined;
  }
  const start = open[0].length;
  const close = source.slice(start).search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (close === -1) {
    return undefined;
  }
  return { start, end: start + close };
}

export function frontmatterOf(source: string) {
  const span = frontmatterSpan(source);
  return span ? source.slice(span.start, span.end) : undefined;
}

// A JS/TS collection is addressed as `path/to/file.ts#EXPORT_NAME` — the file
// holds several, so the export name picks which one. A page's frontmatter uses
// the same form: `pages/index.astro#rotatingWords`.
export function splitCmsRel(rel: string) {
  const at = String(rel || '').lastIndexOf('#');
  return at === -1
    ? { fileRel: String(rel || ''), exportName: undefined }
    : { fileRel: String(rel).slice(0, at), exportName: String(rel).slice(at + 1) };
}

// Refuses paths that escape src/.
export function cmsAbs(projectPath: string, rel: string) {
  const root = path.resolve(projectPath, 'src');
  const abs = path.resolve(root, rel || '');
  if (!isPathWithin(root, abs)) {
    throw new Error('Invalid data path');
  }
  return abs;
}

// What a name in a data file is bound to, when it is bound to a picture: the
// project-relative file, or undefined for anything else. Only imports are read —
// `image: dailyDevotionals` says nothing on its own, and the import above it
// says everything.
export function assetOfImport(projectPath: string, abs: string, source: string) {
  const imports = defaultImports(source);
  return (name: string) => {
    const imp = imports.find((i) => i.name === name);
    if (!imp) {
      return undefined;
    }
    const target = resolveImportPath(projectPath, abs, imp.spec);
    if (!target || !MEDIA_EXT.test(target)) {
      return undefined;
    }
    const rel = toPosix(path.relative(projectPath, target));
    return rel && !rel.startsWith('..') ? rel : undefined;
  };
}

// A field's type is inferred from its values, which can't tell a phone number
// from a line of text — or anything at all from an empty field. Types the user
// picked explicitly are remembered here, keyed by collection and field path.
export const cmsMetaPath = (projectPath: string) =>
  path.join(projectPath, 'src', 'data', 'studio-cms-schema.json');

export function readCmsMeta(projectPath: string) {
  try {
    return parseRecord(parseData(readJson(cmsMetaPath(projectPath))));
  } catch {
    return {};
  }
}

// One collection's entries: where each one lives, what it holds, and what
// identifies it. A collection whose loader builds its entries has none to give.
export const collectionOf = async (projectPath: string, name: string) => {
  const config = parseContentConfig(await readContentConfig(projectPath));
  const collection = (config.collections || []).find((candidate) => candidate.name === name);
  if (!collection) {
    throw new Error(`${name} is not a collection in this project.`);
  }
  return { config, collection };
};

// A file's single values go by the file's own name: they are what the file is.
const fileName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

export function readCmsSource(
  full: string,
  entryRel: string,
  options: { readonly page: boolean; readonly includeGeneralOnly?: boolean },
): CmsFile[] {
  let source: string;
  try {
    if (fs.statSync(full).size > MAIN_LIMITS.cmsFileBytesMax) {
      return [];
    }
    source = readSource(full);
  } catch {
    return [];
  }
  if (options.page) {
    const body = frontmatterOf(source);
    if (!body) {
      return [];
    }
    source = body;
  }
  const scan = options.page ? PAGE_SCAN : undefined;
  const collections = findCollections(source, scan);
  // Source files outside src/data still need an exported record list before
  // they count as CMS content. Otherwise every constants module in the project
  // would appear as a content file merely because it exports a string.
  if (!options.page) {
    if (!options.includeGeneralOnly) {
      if (collections.length === 0) {
        return [];
      }
    }
  }
  const metadata = {
    dir: entryRel,
    abs: full,
    fromFile: true,
    ...(options.page ? { fromPage: true } : {}),
  };
  const general = readGeneral(source, scan);
  const files: CmsFile[] = general
    ? [{ ...metadata, rel: `${entryRel}#${GENERAL}`, name: fileName(entryRel), data: general }]
    : [];
  for (const collection of collections) {
    if (collection.data) {
      files.push({
        ...metadata,
        rel: `${entryRel}#${collection.name}`,
        name: collection.name,
        data: collection.data,
      });
    }
  }
  return files;
}

export function readCmsJson(full: string, entryRel: string, rel: string, name: string): CmsFile {
  let file: CmsFile = { rel: entryRel, name, dir: rel, abs: full };
  try {
    const stat = fs.statSync(full);
    file = { ...file, size: stat.size };
    if (stat.size > MAIN_LIMITS.cmsFileBytesMax) {
      return { ...file, error: 'This file is too large to edit here (over 2 MB).' };
    }
    return { ...file, data: parseData(readJson(full)) };
  } catch (error: unknown) {
    return {
      ...file,
      error: `Not valid JSON — ${errorMessage(error).replace(/\s+in JSON.*$/, '')}`,
    };
  }
}
