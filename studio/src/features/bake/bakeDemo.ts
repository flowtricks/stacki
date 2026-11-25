// The bake tool's entry: `bakeSite`, then the asset URL map beside its snapshot. A site
// that builds the demo imports `bakeSite` from this bundle (bake.mjs), so the map comes
// with every bake without changing the snapshot or its protocol: the file is optional
// and a client without it shows `src/` asset previews as missing, as before.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Result } from '../../../vendor/stacki/shared/core/result';
import { MEDIA_EXT } from '../assets/assetStateTypes';
import { walk } from '../project/projectServer';
import { BAKE_RUNTIME_DIRECTORY } from './bakeProtocol';
import { ASSET_URL_LIMITS, BAKE_ASSET_URLS_FILE, matchAssetURLs, parseAssetURLs, type HashedFile } from './bakeAssetURLs';
import { bakeSite as bakeDocuments, type BakeError, type BakeOptions, type BakeReport } from './bakeSite';

export type { BakeError, BakeOptions, BakeReport } from './bakeSite';

const OUTPUT_FILES_MAX = 20_000;
/** Larger files are skipped: hashing them would slow the bake for no preview. */
const ASSET_BYTES_MAX = 50_000_000;

export async function bakeSite(options: BakeOptions): Promise<Result<BakeReport, BakeError>> {
  const result = await bakeDocuments(options);
  if (result.ok) {
    await writeAssetURLs(options);
  }
  return result;
}

async function hashed(root: string, files: readonly string[]): Promise<HashedFile[]> {
  const found: HashedFile[] = [];
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    if (bytes.length <= ASSET_BYTES_MAX) {
      found.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return found;
}

async function emittedFiles(out: string): Promise<string[]> {
  const entries = await readdir(out, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(out, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => MEDIA_EXT.test(file) && !file.startsWith(`${BAKE_RUNTIME_DIRECTORY}/`))
    .slice(0, OUTPUT_FILES_MAX);
}

async function writeAssetURLs(options: Pick<BakeOptions, 'root' | 'out' | 'base'>): Promise<void> {
  const sources = (await walk(options.root, 'src')).filter((file) => MEDIA_EXT.test(file)).slice(0, ASSET_URL_LIMITS.entriesMax);
  const urls = matchAssetURLs(await hashed(options.root, sources), await hashed(options.out, await emittedFiles(options.out)), options.base);
  const text = JSON.stringify(urls);
  // Read back with the browser's parser, so a map it would refuse never ships.
  parseAssetURLs(text, options.base);
  await writeFile(path.join(options.out, BAKE_RUNTIME_DIRECTORY, BAKE_ASSET_URLS_FILE), text);
}
