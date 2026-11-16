// Duplicating and deleting components and the folders that hold them: the pure rules, shared by
// Desktop's main process (the file work, electron/documents/componentOps.ts) and the Components
// panel (which disables a row it already knows will be refused). Nothing here touches the disk.
//
// Why the rules live apart from the file work: the panel and main must agree on what "unused" and a
// "non-colliding name" mean, and a copy of either rule in each process would drift.
//
// The metadata a component leaves behind is cleaned here too, as pure functions over the parsed
// files: `.stacki/components.json` keeps one recipe per component file, and recipes nest other
// components by file (AGENTS.md "Project editor metadata"), so deleting a component removes its key
// and every nested `component` reference to it together; `.stacki/roles.json` keeps per-role rules
// naming component files and folders, and a rule for a path that is gone is dropped.
import { assert } from '../core/assert';
import { record } from '../core/boundary';
import { parseComponentPath, type ComponentRule } from './componentAccess';
import { DEFAULT_LIMITS, type ComponentDefaults, type ComponentRecipe, type RecipeChild } from './componentDefaults';

export const COMPONENT_OP_LIMITS = {
  /** Names tried for a copy (`FooCopy`, `FooCopy2`, ...) before the operation gives up. */
  copyNameAttemptsMax: 1000,
  /** Files in a folder that can be copied or deleted in one operation. */
  folderFilesMax: 256,
  /** Folders deep a copied or deleted folder may nest. */
  folderDepthMax: 8,
  /** Text bytes in a folder that can be copied or deleted in one operation. */
  folderBytesMax: 4_194_304,
  /** A folder of at least this many files is confirmed before it is copied ("more than 5"). */
  folderConfirmFilesMin: 6,
  /** Deletions whose undo main keeps at once; the oldest is forgotten past this. */
  undoEntriesMax: 16,
} as const satisfies Record<string, number>;

/** What an operation acts on: a component file, or a folder of them. Paths are project-relative with `/`. */
export interface ComponentOpTarget {
  readonly kind: 'component' | 'folder';
  readonly path: string;
}

/** A target read at the boundary: a kind, and a project-relative path with no climbing segments. */
export function parseComponentOpTarget(input: unknown): ComponentOpTarget {
  const value = record(input);
  const kind = value['kind'];
  const path = parseComponentPath(value['path']);
  if (kind === 'component' || kind === 'folder') {
    return { kind, path };
  }
  throw new Error('A component target is a "component" or a "folder"');
}

/** The reply of a refused operation, read back from the wire: a known code and a sentence. */
export function parseComponentOpError(input: unknown): ComponentOpError {
  const value = record(input);
  const code = value['code'];
  const message = value['message'];
  if (typeof message !== 'string' || typeof code !== 'string' || !COMPONENT_OP_ERROR_CODES.some((known) => known === code)) {
    throw new Error('Unknown component operation error');
  }
  return { code: code as ComponentOpErrorCode, message };
}

export const COMPONENT_OP_ERROR_CODES = [
  'not-a-component',
  'outside-components',
  'missing',
  'in-use',
  'too-large',
  'foreign-files',
  'name-unavailable',
  'write-failed',
  'unknown-undo',
  // Renaming and moving (componentRename.ts) refuses with these as well.
  'invalid',
  'exists',
  'unsafe-file',
  'defaults-taken',
  'filesystem',
  'conflict',
  'rollback',
] as const;

export type ComponentOpErrorCode = (typeof COMPONENT_OP_ERROR_CODES)[number];

/** A refusal the person can act on: expected, so a value, never a throw (AGENTS.md section 3). */
export interface ComponentOpError {
  readonly code: ComponentOpErrorCode;
  readonly message: string;
}

/**
 * The first free name for a copy of `stem`: `FooCopy`, `FooCopy2`, `FooCopy3`, ... A stem written with dashes or
 * underscores keeps its style (`foo-bar-copy`, `foo-bar-copy-2`), so a copy still matches the project's convention.
 * `isTaken` is asked case-insensitively by the caller, because a Mac treats `Card` and `card` as one file.
 * Undefined when every attempt is taken, which the caller reports as `name-unavailable`.
 */
export function copyName(stem: string, isTaken: (candidate: string) => boolean): string | undefined {
  assert(stem.length > 0, 'A copy starts from a name');
  assert(!stem.includes('/'), 'A copy name is one path segment');
  const separated = /[-_]/.test(stem);
  const separator = stem.includes('-') ? '-' : '_';
  const base = separated ? `${stem}${separator}copy` : `${stem}Copy`;
  for (let attempt = 1; attempt <= COMPONENT_OP_LIMITS.copyNameAttemptsMax; attempt += 1) {
    const candidate = attempt === 1 ? base : separated ? `${base}${separator}${attempt}` : `${base}${attempt}`;
    if (!isTaken(candidate)) {
      assert(candidate.startsWith(stem), 'A copy name starts with the original');
      return candidate;
    }
  }
  return undefined;
}

/** What deleting `file` removes from component defaults: its recipe, and every nested reference to it. */
export function dropDefaultsFor(config: ComponentDefaults, owns: (file: string) => boolean): ComponentDefaults {
  assert(config.version === 1, 'Cleanup reads the current recipe format');
  assert(Object.keys(config.components).length <= DEFAULT_LIMITS.componentsMax, 'Cleanup starts from bounded parsed configuration');
  const kept = Object.entries(config.components).filter(([file]) => !owns(file));
  const cleaned = kept.map(([file, recipe]) => [file, withoutChildren(recipe, 0, owns)] as const);
  assert(cleaned.length <= Object.keys(config.components).length, 'Cleanup never adds a recipe');
  return { version: 1, components: Object.fromEntries(cleaned) };
}

function withoutChildren(recipe: ComponentRecipe, depth: number, owns: (file: string) => boolean): ComponentRecipe {
  assert(depth <= DEFAULT_LIMITS.depthMax, 'Recipe nesting is bounded by the recipe parser');
  if (recipe.children === undefined) {
    return recipe;
  }
  const children: RecipeChild[] = [];
  for (const child of recipe.children) {
    if ('literal' in child) {
      children.push(child);
    } else if ('component' in child) {
      if (!owns(child.component)) {
        children.push({ ...child, ...withoutChildren(child, depth + 1, owns) });
      }
    } else {
      children.push({ ...child, ...withoutChildren(child, depth + 1, owns) });
    }
  }
  return { ...recipe, children };
}

/** Whether `file` is the target itself (a component) or sits anywhere under it (a folder). */
export function targetOwns(target: ComponentOpTarget, file: string): boolean {
  assert(target.path.length > 0, 'A target names a path');
  return target.kind === 'component' ? file === target.path : file.startsWith(`${target.path}/`);
}

/** The role rules left after `target` is deleted: any rule naming the component, the folder, or anything under it goes. */
export function dropRulesFor(rules: readonly ComponentRule[], target: ComponentOpTarget): readonly ComponentRule[] {
  assert(target.path.length > 0, 'A target names a path');
  const kept = rules.filter((rule) => !(rule.path === target.path || (target.kind === 'folder' && rule.path.startsWith(`${target.path}/`))));
  assert(kept.length <= rules.length, 'Cleanup never adds a rule');
  return kept;
}

/** The reason a delete is refused for a component still on pages, for the disabled row's tip; undefined when it may go. */
export function usedPlaces(instances: number | undefined): number | undefined {
  return instances !== undefined && instances > 0 ? instances : undefined;
}
