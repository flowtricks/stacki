// The Sanity project a site names in its own config files, read without running
// them: a site often writes `projectId: '…'` in astro.config or in its Studio's
// sanity.config / sanity.cli rather than in a .env file. Comments and strings
// are skipped (sanitySource.ts), so a commented-out id does not count. A found
// id is only ever a suggestion matched against the person's own projects.

import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { ownString, walk } from './sanitySource';

// The folders a site keeps its config in (the root, and an embedded Studio), the
// files read there, the longest file read, and the ids kept from one file.
const CONFIG_FOLDERS = ['', 'studio'] as const;
const CONFIG_FILES = [
  'astro.config.mjs',
  'astro.config.ts',
  'astro.config.js',
  'astro.config.mts',
  'astro.config.cjs',
  'sanity.config.ts',
  'sanity.config.js',
  'sanity.config.mjs',
  'sanity.config.tsx',
  'sanity.config.jsx',
  'sanity.cli.ts',
  'sanity.cli.js',
  'sanity.cli.mjs',
] as const;
const CONFIG_BYTES_MAX = 256 * 1024;
const IDS_PER_FILE_MAX = 8;
// Sanity project ids are short lowercase letters and digits.
const PROJECT_ID = /^[a-z0-9]{1,32}$/;
const PROJECT_ID_KEY = /(?<![\w$])projectId\s*:/y;

/** The project ids this source text writes as `projectId: '<id>'`, at any depth, in order. */
export function configProjectIds(source: string): readonly string[] {
  const ids: string[] = [];
  walk(source, (index) => {
    PROJECT_ID_KEY.lastIndex = index;
    if (PROJECT_ID_KEY.test(source)) {
      const value = ownString(source.slice(index), 'projectId');
      if (value !== undefined && PROJECT_ID.test(value) && !ids.includes(value)) {
        ids.push(value);
      }
    }
    return ids.length < IDS_PER_FILE_MAX;
  });
  assert(ids.length <= IDS_PER_FILE_MAX, 'One file gives a bounded number of ids');
  return ids;
}

/** The project ids the site's config files name, root files first; unreadable files are skipped. */
export function siteConfigProjectIds(projectRoot: string): readonly string[] {
  assert(path.isAbsolute(projectRoot), 'The project root is an absolute path');
  const ids: string[] = [];
  for (const folder of CONFIG_FOLDERS) {
    for (const name of CONFIG_FILES) {
      for (const id of configProjectIds(readConfig(path.join(projectRoot, folder, name)))) {
        if (!ids.includes(id)) {
          ids.push(id);
        }
      }
    }
  }
  assert(ids.length <= CONFIG_FOLDERS.length * CONFIG_FILES.length * IDS_PER_FILE_MAX, 'The site gives a bounded number of ids');
  return ids;
}

// A config file's text, or nothing when it is missing, unreadable or too long.
function readConfig(file: string): string {
  try {
    if (fs.statSync(file).size > CONFIG_BYTES_MAX) {
      return '';
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
