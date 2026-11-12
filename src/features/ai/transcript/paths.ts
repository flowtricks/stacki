// How the transcript names a file: relative to the project when it is inside it, so a row says
// `src/pages/index.astro` and not the whole path of the person's computer.

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
