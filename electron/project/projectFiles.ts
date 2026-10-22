// What a folder holds as an Astro project: its page, layout and component
// files, the route a page serves, and whether its dependencies are installed.

import { MAIN_LIMITS, directoryBudget } from '../lib/mainLimits';
import { toRecord } from '../../shared/core/record';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import { PAGE_MD_RE } from '../documents/pageRequests';
import * as fs from 'fs';
import { isWin, toPosix, readJson, parseRecord, parseOptionalString } from '../lib/mainHelpers';

export function listAstroFiles(directory: string) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const out: string[] = [];
  const checkDirectory = directoryBudget(directory);
  const walk = (folder: string, depth: number): void => {
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    checkDirectory(folder, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listAstroFiles: the budget bounds depth');
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
      // Markdown only counts as a page. A .md under src/components isn't a
      // component, it's a README.
      else if (
        entry.name.endsWith('.astro') ||
        (folder.includes(`${path.sep}pages`) && PAGE_MD_RE.test(entry.name))
      ) {
        out.push(full);
      }
    }
  };
  walk(directory, 0);
  return out;
}

export function routeForPage(projectPath: string, pagePath: string) {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  let rel = toPosix(path.relative(pagesDirectory, pagePath)).replace(/\.(astro|mdx?)$/i, '');
  if (rel === 'index') {
    return '/';
  }
  if (rel.endsWith('/index')) {
    rel = rel.slice(0, -'/index'.length);
  }
  return '/' + rel;
}

export function isAstroProject(directory: string) {
  const pkgPath = path.join(directory, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = parseRecord(readJson(pkgPath));
      const deps = { ...toRecord(pkg['dependencies']), ...toRecord(pkg['devDependencies']) };
      if (parseOptionalString(deps['astro'])) {
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  return ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'].some((file) =>
    fs.existsSync(path.join(directory, file)),
  );
}

// Astro has to be installed for a page to be rendered at all; without it the
// card can only offer to open the project.
export function hasDependencies(projectPath: string) {
  const binName = isWin ? 'astro.cmd' : 'astro';
  return fs.existsSync(path.join(projectPath, 'node_modules', '.bin', binName));
}
