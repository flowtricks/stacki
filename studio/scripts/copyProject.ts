import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const excluded = new Set([
  'node_modules',
  '.git',
  '.astro',
  '.studio',
  '.stacki-studio',
  'dist',
  '.studio-state',
  'astro.studio.config.ts',
  'astro.studio.config.mjs',
]);

export async function copyProject(source: string, workspace: string, packageRoot: string) {
  const project = path.resolve(source);
  const destination = path.resolve(workspace);
  const studio = path.resolve(packageRoot);
  if (project === destination || project.startsWith(destination + path.sep)) {
    throw new Error('The draft workspace must not contain the source project');
  }
  // Copy children individually: the draft may live inside the site's studio folder.
  // Exclude the CMS and draft ancestors before cp can recurse into its own output.
  const include = (file: string) => {
    const absolute = path.resolve(file);
    return (
      !excluded.has(path.basename(file)) &&
      absolute !== path.join(project, '.stacki', 'preview') &&
      absolute !== path.join(project, '.stacki', 'canvas') &&
      // Studio's own drafts, history and backups are this machine's, not the site's.
      absolute !== path.join(project, '.stacki', 'studio') &&
      absolute !== studio &&
      absolute !== destination &&
      !destination.startsWith(absolute + path.sep)
    );
  };
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(project)) {
    const file = path.join(project, entry);
    if (include(file)) {
      await cp(file, path.join(destination, entry), { recursive: true, filter: include });
    }
  }
}
