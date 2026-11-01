// Whether a folder is an installed Astro Studio. Studio's own source (and the
// Stacki editor it vendors) lives inside the website as `studio/`, but its
// styles and code belong to the editor, never to the site. Its package identity
// is checked, so an unrelated website folder named studio is still the site's.
import * as fs from 'node:fs';
import * as path from 'node:path';

export function isStudioDirectory(directory: string, name: string): boolean {
  if (name !== 'studio') {
    return false;
  }
  const manifestBytesMax = 64 * 1024;
  try {
    const file = path.join(directory, 'package.json');
    if (fs.statSync(file).size > manifestBytesMax) {
      return false;
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length > manifestBytesMax) {
      return false;
    }
    const manifest: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof manifest !== 'object') {
      return false;
    }
    if (manifest === null) {
      return false;
    }
    if ('name' in manifest) {
      return manifest.name === '@stacki/studio';
    }
    return false;
  } catch {
    // Missing, unreadable or malformed metadata does not identify an editor installation.
    return false;
  }
}
