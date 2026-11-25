// Git's local exclude is repository bookkeeping, never website source.
import * as fs from 'node:fs';
import * as path from 'node:path';
const EXCLUDE_LINES = ['.stacki/preview/', '.stacki/canvas/', '.stacki/io/'];
// How far above the project a repository may start.
const PARENT_FOLDERS_MAX = 64;

/**
 * Keep generated preview checkouts, defaults canvases and save staging out of project commits.
 *
 * Without this the preview checkout shows up as an untracked folder in the
 * user's own project — in the file picker, in the commit box, in every status
 * the app reads — and the first thing they would do is commit it.
 *
 * The project may be a folder of a larger repository (a monorepo). `ignoredPaths` are from the repository's root, as the exclude
 * file reads them.
 */
export function ensureExcluded(projectPath: string, options: { readonly ignoredPaths: readonly string[] } = { ignoredPaths: [] }): boolean {
  if (options.ignoredPaths.length > 4096) {
    return false;
  }
  const inherited = options.ignoredPaths.map(ignoredPathPattern);
  const root = repositoryRootOf(projectPath);
  if (root === undefined) {
    return false;
  }
  // A line with a slash in it counts from the repository's root, so a project further down names its own folder.
  const prefix = path.relative(root, projectPath).split(path.sep).join('/');
  const generated = prefix === '' ? EXCLUDE_LINES : EXCLUDE_LINES.map((line) => `${ignoredPathPattern(prefix)}/${line}`);
  // In a worktree, `.git` is a file pointing elsewhere; the exclude file we
  // want is always the main repository's.
  const gitDirectory = path.join(root, '.git');
  let infoDirectory: string;
  try {
    const stat = fs.statSync(gitDirectory);
    infoDirectory = stat.isDirectory()
      ? path.join(gitDirectory, 'info')
      : // "gitdir: /path/to/.git/worktrees/x" — the common dir is two up.
        path.join(
          path.resolve(
            path.dirname(gitDirectory),
            fs
              .readFileSync(gitDirectory, 'utf8')
              .replace(/^gitdir:\s*/, '')
              .trim(),
            '..',
            '..',
          ),
          'info',
        );
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(infoDirectory, { recursive: true });
    const file = path.join(infoDirectory, 'exclude');
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) {
      return false;
    }
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // Retire the old blanket exclusion so shared project settings reach Git and Studio.
    const current = previous
      .split('\n')
      .filter((line) => line.trim() !== '.stacki/')
      .join('\n');
    const existing = new Set(current.split('\n'));
    const missing = [...new Set([...generated, ...inherited])].filter((entry) => !existing.has(entry));
    if (missing.length === 0 && current === previous) {
      return true;
    }
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    const next = missing.length === 0 ? current : current + sep + '# Stacki local generated files.\n' + missing.join('\n') + '\n';
    if (Buffer.byteLength(next) > 1_000_000) {
      return false;
    }
    fs.writeFileSync(file, next);
    return true;
  } catch {
    return false;
  }
}

// The nearest folder at or above the project that holds `.git`.
function repositoryRootOf(projectPath: string): string | undefined {
  let folder = path.resolve(projectPath);
  for (let depth = 0; depth < PARENT_FOLDERS_MAX; depth += 1) {
    if (fs.existsSync(path.join(folder, '.git'))) {
      return folder;
    }
    const parent = path.dirname(folder);
    if (parent === folder) {
      return undefined;
    }
    folder = parent;
  }
  return undefined;
}

// Preserve only paths that already exist and are ignored, never another branch's
// general ignore rules. Anchoring and escaping keep filenames from becoming globs.
function ignoredPathPattern(value: string): string {
  if (value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new Error('Cannot preserve an invalid ignored path');
  }
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error('Ignored paths must stay inside the project');
  }
  return '/' + value.replace(/[\\*?\[\]#! ]/g, '\\$&');
}
