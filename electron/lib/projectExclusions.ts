// Git's local exclude is repository bookkeeping, never website source.
import * as fs from 'node:fs';
import * as path from 'node:path';
const EXCLUDE_LINES = ['.stacki/preview/', '.stacki/canvas/', '.stacki/feedback.json'];

/**
 * Keep generated preview checkouts, defaults canvases and the editor's
 * feedback notes out of project commits.
 *
 * Without this the preview checkout shows up as an untracked folder in the
 * user's own project — in the file picker, in the commit box, in every status
 * the app reads — and the first thing they would do is commit it.
 */
export function ensureExcluded(projectPath: string): boolean {
  // In a worktree, `.git` is a file pointing elsewhere; the exclude file we
  // want is always the main repository's.
  const gitDirectory = path.join(projectPath, '.git');
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
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // Retire the old blanket exclusion so shared project settings reach Git and Studio.
    const current = previous
      .split('\n')
      .filter((line) => line.trim() !== '.stacki/')
      .join('\n');
    const missing = EXCLUDE_LINES.filter(
      (entry) => !current.split('\n').some((line) => line.trim() === entry),
    );
    if (missing.length === 0 && current === previous) {
      return true;
    }
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    const next =
      missing.length === 0
        ? current
        : current + sep + '# Stacki local files (generated).\n' + missing.join('\n') + '\n';
    fs.writeFileSync(file, next);
    return true;
  } catch {
    return false;
  }
}
