// The content reader's worker modules as one object literal, for the bake bundles to
// embed: the demo's bake tool is a single file, with no vendor tree beside it to read
// them from (src/features/bake/bakeContent.ts writes them out again when it runs).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = fileURLToPath(new URL('../vendor/stacki/electron/content/workers/', import.meta.url));

export async function contentWorkersDefine(): Promise<string> {
  const workers: Record<string, string> = {};
  for (const name of (await readdir(WORKERS)).filter((file) => /^[a-zA-Z]+\.mjs$/.test(file))) {
    workers[name] = await readFile(path.join(WORKERS, name), 'utf8');
  }
  return JSON.stringify(workers);
}
