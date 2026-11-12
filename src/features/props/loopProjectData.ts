// The "Project data" group of the loop's Source menu: the lists the project
// keeps outside the page, in the modules and data files under src/ (the
// arrays exported from `src/consts.ts`, a JSON file's data). They are the CMS
// panel's own reads (projectDataSources.ts), never a second scan: the tree the
// binding picker is built from already holds them, those the file does not
// import yet as roots that carry the import a pick writes, and those it does
// import as the frontmatter's roots. This module gathers both halves into one
// group, so a loop that reads an imported list shows it checked in the group
// it was picked from.
//
// Pure: no file is read here, and nothing runs. A list the CMS could only
// carry as code (`[...a, ...b]`) is listed disabled, since it is a list but
// its items are known to the code alone; any other computed value is left out,
// because nothing says it is a list.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { TreeNode } from '../../editor/dataSample';
import { listsOnly } from '../../editor/dataSuggest';
import { ITEM_FIELD, isFieldPath, type LoopFieldKind } from '../../editor/loopQuery';
import type { PickerNode } from './DataPicker';
import { dataFileOfSection, PROJECT_DATA_SECTION } from './dataPickerModel';

/** What a computed list's row says in the value column. */
export const COMPUTED_LIST_NOTE = 'Set in code';

// A row opens to the fields of its first item; a record with more keys than this is not a row's worth.
const PROJECT_FIELDS_MAX = 64;

/** A field of a list's items as the filter and sort menus offer it. */
export interface ProjectListField {
  readonly path: string;
  readonly kind: LoopFieldKind;
}

/**
 * The project's data lists among the tree's roots, as the group's rows. `modules`
 * maps the names the file imports from a project data file to that file (the
 * not-yet-imported roots name theirs in their section). Rows are ordered by file;
 * each says which file it is from when more than one file is listed, since two
 * modules may export the same name.
 */
export function projectDataRows(tree: readonly TreeNode[], modules: Readonly<Record<string, string>>): readonly PickerNode[] {
  assert(tree.length <= LIMITS.treeNodesMax, 'projectDataRows: the tree is bounded');
  const found: { readonly file: string; readonly row: PickerNode }[] = [];
  for (const root of tree) {
    const file = fileOf(root, modules);
    const row = file === undefined ? undefined : rowOf(root);
    if (file !== undefined && row !== undefined) {
      found.push({ file, row });
    }
  }
  // Stable: a file's exports keep the order the file declares them in.
  const ordered = found
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => (left.file === right.file ? left.index - right.index : left.file < right.file ? -1 : 1));
  const several = new Set(ordered.map((entry) => entry.file)).size > 1;
  const rows = ordered.map((entry) => ({ ...entry.row, section: PROJECT_DATA_SECTION, ...(several ? { detail: entry.file } : {}) }));
  assert(rows.length <= tree.length, 'projectDataRows: a row is a root');
  return rows;
}

/** The names the group takes from the tree, so the page's own lists do not list them twice. */
export function projectDataNames(tree: readonly TreeNode[], modules: Readonly<Record<string, string>>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const root of tree) {
    // Every root of a data file, a list or not: a number or a computed value of the
    // module is not the page's own list either.
    if (fileOf(root, modules) !== undefined) {
      names.add(root.path);
    }
  }
  return names;
}

/**
 * The fields the first item of the list at root `name` has, read from the tree
 * (the project's list is sampled there), or undefined when the tree does not
 * hold that list's items. Items that are words or numbers are one field, the item itself.
 */
export function treeListFields(tree: readonly TreeNode[] | undefined, name: string): readonly ProjectListField[] | undefined {
  const root = tree?.find((node) => node.path === name);
  const first = root?.children?.[0];
  if (first === undefined) {
    return undefined;
  }
  if (first.children === undefined) {
    const kind = fieldKindOf(first.kind);
    return kind === 'other' ? [] : [{ path: ITEM_FIELD, kind }];
  }
  const fields: ProjectListField[] = [];
  for (const child of first.children.slice(0, PROJECT_FIELDS_MAX)) {
    if (isFieldPath(child.key) && !child.key.includes('.') && child.key !== ITEM_FIELD) {
      fields.push({ path: child.key, kind: fieldKindOf(child.kind) });
    }
  }
  assert(fields.length <= PROJECT_FIELDS_MAX, 'treeListFields: the fields are bounded');
  return fields;
}

// The data file a root comes from, when it comes from one: a root that carries an import is the
// file's (named in its section); an imported name is the file `modules` says.
function fileOf(root: TreeNode, modules: Readonly<Record<string, string>>): string | undefined {
  if (root.importNeed !== undefined) {
    return dataFileOfSection(root.section);
  }
  return Object.prototype.hasOwnProperty.call(modules, root.path) ? modules[root.path] : undefined;
}

function rowOf(root: TreeNode): PickerNode | undefined {
  if (root.kind === 'list' || root.kind === 'imported') {
    // No pager: the row opens to the first item's fields, as a collection's does.
    return { ...withoutPager(root), children: itemFields(root), pickable: true };
  }
  if (root.kind === 'value' && root.computedList === true) {
    return {
      path: root.path,
      key: root.key,
      kind: 'list',
      preview: '',
      note: COMPUTED_LIST_NOTE,
      unbindable: 'A list computed in code: write it in the loop’s Code field',
      children: undefined,
      pickable: false,
    };
  }
  if (root.kind === 'object') {
    // An object is not a list, but lists inside it are (`SITE.links`): kept to reach them.
    const inside = listsOnly(root.children).filter((node) => node.children !== undefined || node.pickable);
    return inside.length === 0 ? undefined : { ...root, children: inside.map((node) => asPicker(node, 1)), pickable: false };
  }
  return undefined;
}

// The picker pages a list of records one entry at a time; this row shows the fields directly.
function withoutPager(root: TreeNode): TreeNode {
  const copy = { ...root };
  delete copy.entryCount;
  return copy;
}

// A list of records opens to the fields of its first item, as a collection does; they are shown, never chosen.
function itemFields(root: TreeNode): readonly PickerNode[] | undefined {
  const first = root.children?.[0];
  if (first?.children === undefined) {
    return undefined;
  }
  return first.children.slice(0, PROJECT_FIELDS_MAX).map((child) => asReadOnly(child, 1));
}

function asReadOnly(node: TreeNode, depth: number): PickerNode {
  assert(depth <= LIMITS.treeDepthMax, 'asReadOnly: depth limit exceeded');
  const { children, ...rest } = node;
  return { ...rest, children: children?.slice(0, PROJECT_FIELDS_MAX).map((child) => asReadOnly(child, depth + 1)), pickable: false };
}

function asPicker(node: TreeNode & { readonly pickable?: boolean }, depth: number): PickerNode {
  assert(depth <= LIMITS.treeDepthMax, 'asPicker: depth limit exceeded');
  const { children, ...rest } = node;
  return { ...rest, children: children?.map((child) => asPicker(child, depth + 1)), pickable: node.pickable === true };
}

function fieldKindOf(kind: string): LoopFieldKind {
  switch (kind) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'list':
      return 'list';
    default:
      return 'other';
  }
}
