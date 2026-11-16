import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { runSync, type SlicedWork } from '../lib/slicedWork';

export interface RenameFile {
  readonly file: string;
  readonly source: string;
}
export interface PageRenameInventory {
  readonly pages: readonly string[];
  readonly folders: readonly string[];
  readonly files: readonly string[];
}
const ignored = new Set([
  'node_modules',
  '.git',
  '.astro',
  '.studio-state',
  'dist',
  'build',
  'coverage',
  '.next',
  '.vercel',
  '.netlify',
  '.wrangler',
  '.cache',
]);
const binary = /\.(png|jpe?g|webp|gif|ico|avif|pdf|woff2?|ttf|otf|eot|mp[34]|mov|webm|zip|gz|br|wasm)$/i;

/**
 * Inventory authored files once; never follow links into dependencies or another project.
 *
 * No size limit (owner requirement): a project of any number of files, folders
 * and levels is inventoried. A link is refused outright, so the walk cannot
 * cycle and ends within the number of folders it discovers. The walk yields
 * after each folder, so a caller on the main thread can run it sliced.
 */
export function* pageRenameInventoryWork(root: string): SlicedWork<PageRenameInventory> {
  const pending = [''];
  const files: string[] = [];
  const folders: string[] = [];
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index];
    assert(directory !== undefined, 'Inventory queue contains its current directory');
    const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const file = directory ? directory + '/' + entry.name : entry.name;
      if (ignored.has(entry.name) || /^\.stacki\/(preview|canvas|io|studio)(\/|$)/.test(file)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Cannot safely update links through symbolic link ${file}.`);
      }
      if (entry.isDirectory()) {
        pending.push(file);
        if (file.startsWith('src/pages/')) {
          folders.push(file.slice(10));
        }
      } else if (entry.isFile()) {
        files.push(file);
      }
    }
    yield;
  }
  return {
    files,
    folders,
    pages: files.filter((file) => /^src\/pages\/.*\.(astro|mdx?)$/i.test(file)).map((file) => file.slice(10)),
  };
}

/** The inventory in one go, for callers that already block. */
export function pageRenameInventory(root: string): PageRenameInventory {
  return runSync(pageRenameInventoryWork(root));
}

/** Whether a rewrite may read this file as text at all: binaries and lockfiles never. */
export function isRenameTextCandidate(file: string): boolean {
  return !binary.test(file) && !/(^|\/)(package-lock.json|pnpm-lock.yaml|yarn.lock)$/.test(file);
}

/**
 * One file's text, of any size, or undefined when it is not UTF-8 text (a NUL
 * byte, or bytes that do not survive a decode and encode). Reading the file
 * whole is the point: a rewrite must see every byte it may change.
 */
export function readRenameText(root: string, file: string): RenameFile | undefined {
  const full = path.join(root, file);
  const size = fs.statSync(full).size;
  const bytes = fs.readFileSync(full);
  if (bytes.length !== size) {
    throw new Error(`${file} changed while preparing the rename. Try again.`);
  }
  if (bytes.includes(0)) {
    return undefined;
  }
  const source = bytes.toString('utf8');
  return Buffer.from(source).equals(bytes) ? { file, source } : undefined;
}
