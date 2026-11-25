// A site's package.json, read as text the renderer already has: which packages
// it depends on. Used where a feature only makes sense with a package installed
// (a Sanity loop needs @sanity/astro) or hints at one (a Sanity site, in CMS
// connections). Malformed or oversized text depends on nothing.
import { toRecord } from '../../shared/core/record';

/** The longest package.json text read. */
export const PACKAGE_MANIFEST_CHARS_MAX = 1_000_000;

/** Whether a package.json's text lists `name` as a dependency of either kind. */
export function hasDependency(text: string, name: string): boolean {
  if (text.length === 0 || text.length > PACKAGE_MANIFEST_CHARS_MAX) {
    return false;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return false;
  }
  const record = toRecord(manifest);
  const dependencies = toRecord(record?.['dependencies']);
  const development = toRecord(record?.['devDependencies']);
  return typeof dependencies?.[name] === 'string' || typeof development?.[name] === 'string';
}
