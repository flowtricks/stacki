// How the transcript names a file: relative to the project when it is inside it, so a row says
// `src/pages/index.astro` and not the whole path of the person's computer.
import { assert } from '../../../../shared/core/assert';

/** `file` without the project's root in front of it; a path outside the project is returned as it is. */
export function relativePath(file: string, projectPath: string): string {
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

/** A title (a command or a message the agent wrote) with the project's root taken out wherever it appears. */
export function relativeTitle(title: string, projectPath: string): string {
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return title.split(root).join('');
}

/**
 * A long path with its middle taken out: its start and its file name, with an ellipsis between
 * (`src/components/…/Button.astro`), at most `max` characters. A path that fits is returned as it is.
 */
export function middleEllipsis(text: string, max: number): string {
  assert(max >= 8, 'middleEllipsis: room for a start, an ellipsis and an end');
  if (text.length <= max) {
    return text;
  }
  const name = text.length - text.lastIndexOf('/') - 1;
  const tail = Math.min(name, Math.floor((max * 2) / 3));
  const head = max - tail - 1;
  const shown = `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
  assert(shown.length === max, 'middleEllipsis: exactly the room given');
  return shown;
}
