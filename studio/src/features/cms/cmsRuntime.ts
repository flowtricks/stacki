import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A folder holding the workers, for a bundle shipped without the vendor tree beside it
 * (the demo's bake tool writes its embedded copies there). */
export const CONTENT_WORKERS_ENV = 'STACKI_CONTENT_WORKERS';
// Bundled integration and source tests resolve the same shipped upstream workers.
export function contentWorkerPath(name: string) {
  if (!/^[a-zA-Z]+\.mjs$/.test(name)) {
    throw new Error('Invalid content worker');
  }
  const folder = process.env[CONTENT_WORKERS_ENV];
  if (folder !== undefined && existsSync(path.join(folder, name))) {
    return path.join(folder, name);
  }
  const candidates = [
    new URL(`../vendor/stacki/electron/content/workers/${name}`, import.meta.url),
    new URL(`../../../vendor/stacki/electron/content/workers/${name}`, import.meta.url),
  ];
  const found = candidates.find((url) => existsSync(url));
  if (!found) {
    throw new Error('Content worker is missing');
  }
  return fileURLToPath(found);
}
