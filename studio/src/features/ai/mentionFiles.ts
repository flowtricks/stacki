// The files an `@` mention can name in Studio, and the pure helpers around the composer's chips. Desktop asks its main
// process to search the project; Studio already holds the project's page, component and asset lists, so the picker
// searches those, and the server's model reads the named file itself (the chip is sent as the text `@path`).
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { AI_LIMITS } from '../../../vendor/stacki/shared/properties/ai/aiLimits';
import { isProjectRelativePath, plainTextOf, type ComposerSegments, type MentionChip } from '../../../vendor/stacki/shared/properties/ai/mentions';
import type { Project } from '../project/projectClient';

/** The most project files the picker will search; a larger project is searched in its first files only. */
export const MENTION_FILES_MAX = 5000;

/** Project files, relative to the project root, without repeats. The open file leads so it is the first thing offered. */
export function mentionFiles(project: Pick<Project, 'pages' | 'components' | 'assets'>, openFile: string): readonly string[] {
  const all = [openFile, ...project.pages, ...project.components.map((component) => component.file), ...project.assets];
  const unique = [...new Set(all)].filter(isProjectRelativePath);
  assert(unique.length <= all.length, 'mentionFiles: removing repeats cannot add files');
  return unique.slice(0, MENTION_FILES_MAX);
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export function fileChip(path: string): MentionChip {
  assert(isProjectRelativePath(path), 'fileChip: a chip names a project-relative path');
  return { kind: 'file', path, name: baseName(path) };
}

/** The files that match what was typed after `@`: names that start with it first, then names and paths that contain it. */
export function matchFiles(files: readonly string[], query: string, rowsMax: number): readonly string[] {
  assert(rowsMax > 0, 'matchFiles: the picker shows at least one row');
  const needle = query.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const file of files) {
    const name = baseName(file).toLowerCase();
    if (needle === '' || name.startsWith(needle)) {
      starts.push(file);
    } else if (file.toLowerCase().includes(needle)) {
      contains.push(file);
    }
  }
  const rows = [...starts, ...contains].slice(0, rowsMax);
  assert(rows.length <= rowsMax, 'matchFiles: the picker shows a bounded list');
  return rows;
}

export function chipCountOf(segments: ComposerSegments): number {
  return segments.filter((segment) => segment.kind === 'chip').length;
}

/** Whether the editor's draft already is `segments`; the editor's own edits must not be written back into it. */
export function sameDraft(left: ComposerSegments, right: ComposerSegments): boolean {
  return plainTextOf(left) === plainTextOf(right) && chipCountOf(left) === chipCountOf(right);
}

export function textSegments(text: string): ComposerSegments {
  return text === '' ? [] : [{ kind: 'text', text }];
}

export const MENTION_LIMIT_TEXT = `Up to ${AI_LIMITS.mentionsMax} mentions per message.`;
