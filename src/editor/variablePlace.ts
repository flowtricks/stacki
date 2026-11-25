// Which files' variables the Variables panel lists and the style pickers offer,
// given where the user is. A stylesheet's variables reach every page, so they are
// always there. A `<style>` block's reach only the page or component that holds
// it (and, through inheritance, what that file wraps), so a list of every block
// in the project names variables that do nothing where the user is working.
//
// The panel and the pickers answer different questions. The panel is a
// directory of what belongs to the place the user is in: global files, and the
// open file's own blocks. A picker offers what can apply to the selected element,
// which includes a wrapping component's variables reached by inheritance; the
// canvas answers that per element (useDefinedVariables in features/style/VariablePicker.tsx), so
// the picker only drops what can never reach this canvas: another page's blocks.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

/** Where the user is. Paths are project-relative and POSIX (`src/pages/index.astro`). */
export interface VariablePlace {
  /** The page or component open on the canvas. */
  readonly openFile: string | undefined;
  /** While a component is open, the page the canvas shows it on. */
  readonly contextPage: string | undefined;
}

/**
 * Who a file's variables reach, read from where it lives, which is how Astro and
 * the project scan both tell them apart. A layout wraps the pages that use it, so
 * its blocks reach those pages whole and count with the stylesheets.
 */
export type VariableFileReach = 'global' | 'page' | 'component';

export function variableFileReach(rel: string): VariableFileReach {
  assert(rel.length > 0, 'variableFileReach: a file has a path');
  assert(rel.length <= LIMITS.ipcFieldCharsMax, 'variableFileReach: the path is within the field limit');
  if (!/\.astro$/i.test(rel)) {
    return 'global';
  }
  if (rel.startsWith('src/layouts/')) {
    return 'global';
  }
  if (rel.startsWith('src/pages/')) {
    return 'page';
  }
  return 'component';
}

/** The panel lists a page's or a component's variables only while that file is open. */
export function variableFileListed(rel: string, place: VariablePlace): boolean {
  const reach = variableFileReach(rel);
  switch (reach) {
    case 'global':
      return true;
    case 'page':
    case 'component':
      return rel === place.openFile;
    default: {
      const exhaustive: never = reach;
      return exhaustive;
    }
  }
}

/**
 * The pickers never offer another page's variables. A component's stay, for the
 * canvas to narrow to the ones that reach the selected element.
 */
export function variableFileOffered(rel: string, place: VariablePlace): boolean {
  const reach = variableFileReach(rel);
  switch (reach) {
    case 'global':
    case 'component':
      return true;
    case 'page':
      if (rel === place.openFile) {
        return true;
      }
      return rel === place.contextPage;
    default: {
      const exhaustive: never = reach;
      return exhaustive;
    }
  }
}

/**
 * A path as the variable reader names files: relative to the project, with
 * forward slashes. Desktop holds absolute paths; Studio's are relative already.
 */
export function projectRelative(projectPath: string | undefined, file: string | undefined): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  assert(file.length <= LIMITS.ipcFieldCharsMax, 'projectRelative: the path is within the field limit');
  const posix = file.replace(/\\/g, '/');
  if (projectPath === undefined) {
    return posix;
  }
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root.length > 0) {
    if (posix.startsWith(`${root}/`)) {
      return posix.slice(root.length + 1);
    }
  }
  return posix;
}
