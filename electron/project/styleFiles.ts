// The stylesheets a project holds: plain CSS files, and Astro components
// whose <style> blocks the style panel can edit.

import { MAIN_LIMITS, readSource, directoryBudget } from '../lib/mainLimits';
import { assert } from '../../shared/core/assert';
import type { StyleFile } from '../lib/mainTypes';
import * as path from 'path';
import * as fs from 'fs';
import { toPosix } from '../lib/mainHelpers';
import { isStudioDirectory } from '../lib/studioDirectory';

export const CSS_SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.astro',
  'release',
  '.avb',
]);

// The top-level folders a site's stylesheets live in, matching the variables
// panel (cssVarRead.ts). The project root also holds whatever else its owner
// keeps there: a 1.7 GB backup folder beside the site made this synchronous
// walk stall the main process, dev server start included (issue #67).
export const CSS_ROOT_DIRECTORIES = new Set(['src', 'public', 'styles']);

export function listCssFiles(root: string) {
  const out: StyleFile[] = [];
  const checkDirectory = directoryBudget(root);
  const walk = (directory: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    checkDirectory(directory, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listCssFiles: the budget bounds depth');
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }
      const full = path.join(directory, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CSS_SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (depth === 0) {
          if (!CSS_ROOT_DIRECTORIES.has(entry.name)) {
            continue;
          }
        }
        if (isStudioDirectory(full, entry.name)) {
          continue;
        }
        walk(full, relPath, depth + 1);
      } else if (/\.(css|scss|sass|less)$/i.test(entry.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* unreadable — still list it, the read will report the error */
        }
        out.push({ rel: toPosix(relPath), name: entry.name, path: full, size });
      }
    }
  };
  walk(root, '', 0);
  // Shallow paths first (src/styles/global.css before a deeply nested partial),
  // then alphabetical — the file you want is usually near the top of the tree.
  return out.sort((left, right) => {
    const da = left.rel.split('/').length;
    const db = right.rel.split('/').length;
    return da - db || left.rel.localeCompare(right.rel);
  });
}

// A component's `<style is:global>` is page CSS. Astro leaves those rules
// unhashed, so they style whatever the page renders — including elements that
// live in a different file from the one being edited, which is exactly the case
// the style panel used to be blind to. Scoped `<style>` blocks are deliberately
// left out: Astro hashes them to their own component's elements, so their rules
// can't reach a selection made from another file.
export const ASTRO_GLOBAL_STYLE = /<style\b[^>]*\bis:global\b[^>]*>/i;
export const ASTRO_SCAN_LIMIT = 512 * 1024; // a .astro file this big isn't a component

export function listAstroStyleFiles(root: string) {
  const out: StyleFile[] = [];
  const checkDirectory = directoryBudget(root);
  const walk = (directory: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    checkDirectory(directory, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listAstroStyleFiles: the budget bounds depth');
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(directory, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CSS_SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (isStudioDirectory(full, entry.name)) {
          continue;
        }
        walk(full, relPath, depth + 1);
        continue;
      }
      if (!/\.astro$/i.test(entry.name)) {
        continue;
      }
      try {
        const { size } = fs.statSync(full);
        if (size > ASTRO_SCAN_LIMIT) {
          continue;
        }
        if (!ASTRO_GLOBAL_STYLE.test(readSource(full))) {
          continue;
        }
        out.push({ rel: toPosix(relPath), name: entry.name, path: full, size });
      } catch {
        /* unreadable — nothing to offer for it */
      }
    }
  };
  // Only src/: components elsewhere aren't part of the page's CSS, and this
  // keeps the scan off node_modules and build output entirely.
  walk(path.join(root, 'src'), 'src', 0);
  return out.sort((left, right) => left.rel.localeCompare(right.rel));
}
