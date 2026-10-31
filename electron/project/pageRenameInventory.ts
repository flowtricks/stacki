import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';

export interface RenameFile {
  readonly file: string;
  readonly source: string;
}
export interface PageRenameInventory {
  readonly pages: readonly string[];
  readonly folders: readonly string[];
  readonly files: readonly string[];
  readonly texts: readonly RenameFile[];
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
const binary =
  /\.(png|jpe?g|webp|gif|ico|avif|pdf|woff2?|ttf|otf|eot|mp[34]|mov|webm|zip|gz|br|wasm)$/i;

/** Inventory authored files once; never follow links into dependencies or another project. */
export function pageRenameInventory(root: string): PageRenameInventory {
  const pending = [''];
  const files: string[] = [];
  const folders: string[] = [];
  let count = 0;
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index];
    assert(directory !== undefined, 'Inventory queue contains its current directory');
    const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
    count += entries.length;
    if (count > 10_000 || directory.split('/').length > 32) {
      throw new Error('Rename supports at most 10,000 project entries and 32 folder levels.');
    }
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
  }
  assert(files.length <= 10_000, 'Rename files stay within the entry budget');
  return {
    files,
    folders,
    pages: files
      .filter((file) => /^src\/pages\/.*\.(astro|mdx?)$/i.test(file))
      .map((file) => file.slice(10)),
    texts: inventoryTexts(root, files),
  };
}
function inventoryTexts(root: string, files: readonly string[]): readonly RenameFile[] {
  const texts: RenameFile[] = [];
  let total = 0;
  for (const file of files) {
    if (binary.test(file) || /(^|\/)(package-lock.json|pnpm-lock.yaml|yarn.lock)$/.test(file)) {
      continue;
    }
    const full = path.join(root, file);
    const size = fs.statSync(full).size;
    total += size;
    if (size > 5_000_000 || total > 100_000_000) {
      throw new Error(`Rename text scan exceeds its 5 MB/file or 100 MB/project limit: ${file}`);
    }
    const bytes = fs.readFileSync(full);
    if (bytes.length !== size) {
      throw new Error(`${file} changed while preparing the rename. Try again.`);
    }
    if (bytes.includes(0)) {
      continue;
    }
    const source = bytes.toString('utf8');
    if (Buffer.from(source).equals(bytes)) {
      texts.push({ file, source });
    }
  }
  return texts;
}
