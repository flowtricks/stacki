// How a site builds, read as data only: publishing never runs site code to find out.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** A package.json or Astro config larger than this is not one publishing should read; both are a few KiB in practice. */
const SITE_FILE_BYTES_MAX = 262_144;
const ASTRO_CONFIG_NAMES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs'] as const;

export async function astroConfigSource(root: string): Promise<string | undefined> {
  for (const name of ASTRO_CONFIG_NAMES) {
    const source = await siteFile(path.join(root, name));
    if (source !== undefined) {
      return source;
    }
  }
  return undefined;
}

/** The build folder, `./dist` unless the Astro config names a literal one inside the site; undefined when it names one that cannot be trusted. */
export function outputDirectory(config: string | undefined): string | undefined {
  const named = /\boutDir\s*:\s*([^,\n}]+)/.exec(config ?? '');
  if (named === null) {
    return './dist';
  }
  const literal = /^['"`]([^'"`]+)['"`]\s*$/.exec(named[1]?.trim() ?? '');
  const directory = literal?.[1];
  if (directory === undefined) {
    return undefined;
  }
  const normalized = path.posix.normalize(directory.replace(/^\.\//, ''));
  if (path.posix.isAbsolute(normalized)) {
    return undefined;
  }
  if (normalized === '.' || normalized.split('/').includes('..')) {
    return undefined;
  }
  return `./${normalized.replace(/\/$/, '')}`;
}

/** One small site file's text, or undefined when it is missing or too large to be what it claims to be. */
export async function siteFile(filename: string): Promise<string | undefined> {
  try {
    const metadata = await stat(filename);
    if (metadata.size > SITE_FILE_BYTES_MAX) {
      return undefined;
    }
    return await readFile(filename, 'utf8');
  } catch (failure: unknown) {
    if (failure instanceof Error && 'code' in failure && failure.code === 'ENOENT') {
      return undefined;
    }
    throw failure;
  }
}
