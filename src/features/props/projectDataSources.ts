// The project's data files as the binding picker lists them below what is in
// scope: every export the CMS panel knows (cms:list), grouped by file, with
// its values, and with the import a pick writes before it binds. An export the
// file already imports is in scope and listed there instead; one the project
// left out of the picker (Settings → Folders, `cms.pickerExcluded`) is not
// listed at all.
//
// Pure: the hosts read the CMS catalog, the folder settings and whether the
// project's `@/` alias reaches src/ (useProjectSources.ts), and hand them in.
//
// The import is written as the project writes imports. A module the file
// already imports from is imported from again by the same specifier, so the
// export joins that `import { … }`. Otherwise `@/consts` when the alias was
// found to reach the file, else a path relative to the file. Script modules
// are named without their extension, as TypeScript resolves them; JSON keeps it.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { toRecord } from '../../../shared/core/record';
import { isPickerShown, type ProjectFolders } from '../../../shared/properties/projectFolders';
import { namesInScope } from '../../editor/dataScope';
import { sampleNode, type TreeNode } from '../../editor/dataSample';
import type { ImportLike } from '../../editor/dataSource';
import { freeName } from '../../editor/frontmatterAdditions';
import { dataFileSection } from './dataPickerModel';

/** One entry of the CMS catalog (cms:list), as this reads it: `consts.ts#*general`, `consts.ts#NAV`, `data/team.json`. */
export interface CatalogFile {
  readonly rel: string;
  readonly data?: unknown;
  readonly error?: string;
}

/** One export of a project data file, with the value the CMS read for it. `default` is a JSON file's data. */
export interface DataFileExport {
  readonly file: string;
  readonly exported: string;
  readonly value: unknown;
}

/** How the project writes an import of a file under src/: through its `@/` alias, or relative to the importer. */
export type ImportStyle = { readonly kind: 'alias' } | { readonly kind: 'relative' };

export interface ProjectSourceInput {
  readonly exports: readonly DataFileExport[];
  readonly config: ProjectFolders | undefined;
  readonly style: ImportStyle;
  /** The file being bound, project-relative (`src/pages/index.astro`); undefined lists nothing. */
  readonly file: string | undefined;
  readonly frontmatter: string;
  readonly imports: readonly ImportLike[];
}

// The CMS catalog's address of a file's single values (jsCollections.ts GENERAL).
const GENERAL = '*general';
// The marker the CMS puts on a value it could not read as data: `{ __expr: "…code…" }` (jsCollections.ts EXPR).
const EXPRESSION = '__expr';
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const DATA_EXTENSIONS = ['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts', '.tsx', '.jsx', '.json'] as const;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Exports listed for the whole project: far more than a site keeps its settings in.
export const PROJECT_EXPORTS_MAX = 256;
// Items of one list read into the picker. A constants file can hold thousands of
// rows; the picker shows the shape of the first few, and the list says how many there are.
// Why 50: the entry pager and the field rows read only the first items, and the tree is
// rebuilt on every keystroke of the search, so its size is the cost of each one.
export const PROJECT_LIST_ITEMS_MAX = 50;

/**
 * Every export the CMS catalog read from a data module or JSON file under
 * src/: a module's single values one by one, its lists of records, and a JSON
 * file's data as its default export. Pages (`.astro`) are not modules a file
 * can import data from, and a file the CMS could not read lists nothing.
 */
export function dataFileExports(files: readonly CatalogFile[]): readonly DataFileExport[] {
  const out: DataFileExport[] = [];
  for (const entry of files) {
    if (out.length >= PROJECT_EXPORTS_MAX) {
      break;
    }
    const hash = entry.rel.indexOf('#');
    const file = 'src/' + (hash === -1 ? entry.rel : entry.rel.slice(0, hash));
    if (/\.astro$/i.test(file) || entry.data === undefined || entry.error !== undefined) {
      continue;
    }
    const address = hash === -1 ? undefined : entry.rel.slice(hash + 1);
    if (address === undefined) {
      if (/\.json$/i.test(file)) {
        out.push({ file, exported: 'default', value: entry.data });
      }
    } else if (address === GENERAL) {
      for (const [exported, value] of Object.entries(toRecord(entry.data) ?? {})) {
        out.push({ file, exported, value });
      }
    } else {
      out.push({ file, exported: address, value: entry.data });
    }
  }
  const listed = out.slice(0, PROJECT_EXPORTS_MAX).filter((item) => item.exported === 'default' || IDENTIFIER.test(item.exported));
  assert(
    listed.every((item) => item.file.startsWith('src/')),
    'dataFileExports: every data file is under src/',
  );
  return listed;
}

/**
 * The picker's roots for the project's data files: one per export the file
 * does not import yet and the project shows in the picker, each in its file's
 * section and carrying the import a pick writes. Names the file already uses
 * are not taken: such an export is read under an alias (`SITE2`).
 */
export function projectSourceNodes(input: ProjectSourceInput): TreeNode[] {
  const from = input.file;
  if (from === undefined || from === '') {
    return [];
  }
  assert(input.exports.length <= PROJECT_EXPORTS_MAX, 'projectSourceNodes: the export list is bounded');
  const files = new Set(input.exports.map((item) => item.file));
  const imported = input.imports.map((imp) => ({ imp, file: moduleFileOf(imp.path ?? '', from, files) }));
  const taken = new Set(namesInScope(input.frontmatter, input.imports));
  const nodes: TreeNode[] = [];
  for (const item of input.exports) {
    if (!isPickerShown(input.config, { kind: 'export', file: item.file, exported: item.exported })) {
      continue;
    }
    // In scope already: the frontmatter section lists it under the file's own name for it.
    if (imported.some(({ imp, file }) => file === item.file && readsExport(imp, item.exported))) {
      continue;
    }
    const sibling = imported.find(({ imp, file }) => file === item.file && imp.named === true && imp.typeOnly !== true);
    const spec = sibling?.imp.path ?? importSpecFor(item.file, from, input.style);
    const name = freeName(item.exported === 'default' ? defaultName(item.file) : item.exported, taken);
    taken.add(name);
    nodes.push({
      ...valueNode(name, item.value),
      section: dataFileSection(item.file),
      importNeed: { spec, exported: item.exported, name },
    });
  }
  assert(nodes.length <= input.exports.length, 'projectSourceNodes: one root per export at most');
  return nodes;
}

/**
 * The data files a file already imports from, by the local name of each export it
 * reads (`NAV` -> `src/consts.ts`): the in-scope half of the project's data, which
 * projectSourceNodes leaves out because the frontmatter section lists it. The Source
 * menu groups both halves together, so it needs to know which names are the project's.
 */
export function importedProjectData(input: Pick<ProjectSourceInput, 'exports' | 'file' | 'imports'>): Readonly<Record<string, string>> {
  const from = input.file;
  if (from === undefined || from === '') {
    return {};
  }
  assert(input.exports.length <= PROJECT_EXPORTS_MAX, 'importedProjectData: the export list is bounded');
  const files = new Set(input.exports.map((item) => item.file));
  const out: Record<string, string> = {};
  for (const imp of input.imports) {
    const file = moduleFileOf(imp.path ?? '', from, files);
    const local = imp.name ?? '';
    if (file === undefined || local === '' || imp.typeOnly === true) {
      continue;
    }
    // Only an export the CMS read: a function or a type the module also exports is not data.
    const exported = imp.named === true ? (imp.imported ?? local) : 'default';
    if (input.exports.some((item) => item.file === file && item.exported === exported)) {
      out[local] = file;
    }
  }
  assert(Object.keys(out).length <= input.imports.length, 'importedProjectData: one name per import at most');
  return out;
}

/**
 * The specifier `target` is imported by from `from`: `@/consts` through the
 * alias, else `../consts` relative to the importer. Both project-relative.
 */
export function importSpecFor(target: string, from: string, style: ImportStyle): string {
  assert(target.startsWith('src/'), 'importSpecFor: the target is under src/');
  const module = target.replace(SCRIPT_EXTENSION, '');
  switch (style.kind) {
    case 'alias':
      return '@/' + module.slice('src/'.length);
    case 'relative': {
      const relative = relativePath(directoryOf(from), module);
      return relative.startsWith('.') ? relative : './' + relative;
    }
    default: {
      const exhaustive: never = style;
      return exhaustive;
    }
  }
}

/**
 * The data file in `files` an import specifier names from `from`, or
 * undefined for a package, an unknown alias or a file not in the list.
 * Relative paths and `@/` (the alias Stacki writes) are followed, with the
 * extension and `/index` guessing a bundler does.
 */
export function moduleFileOf(spec: string, from: string, files: ReadonlySet<string>): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = joinPath(directoryOf(from), spec);
  } else if (spec.startsWith('@/')) {
    base = 'src/' + spec.slice('@/'.length);
  }
  if (base === undefined) {
    return undefined;
  }
  const candidates = [base, ...DATA_EXTENSIONS.map((extension) => base + extension), ...DATA_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
  return candidates.find((candidate) => files.has(candidate));
}

/** The alias probe a host asks its resolver: `@/consts` for `src/consts.ts`, or undefined for a file outside src/. */
export function aliasProbeFor(target: string): string | undefined {
  return target.startsWith('src/') ? importSpecFor(target, target, { kind: 'alias' }) : undefined;
}

// Whether `imp` reads `exported` of its module.
function readsExport(imp: ImportLike, exported: string): boolean {
  if (imp.typeOnly === true) {
    return false;
  }
  if (exported === 'default') {
    return imp.named !== true;
  }
  return imp.named === true && (imp.imported ?? imp.name) === exported;
}

// A JSON file's data, named after the file: `site-settings.json` is `siteSettings`.
function defaultName(file: string): string {
  const base = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const words = base.split(/[^A-Za-z0-9_$]+/).filter((word) => word !== '');
  const name = words.map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join('');
  return IDENTIFIER.test(name) ? name : 'data';
}

// One export as rows: its value as the CMS read it. A value the CMS could only
// carry as code (`{ __expr }`) is bindable by its name but shows no value:
// putting code in the value column is what the picker exists to avoid.
function valueNode(name: string, value: unknown): TreeNode {
  const bounded = boundedLists(value, 0);
  const marked = markExpressions(sampleNode(name, name, withoutExpressions(bounded, 0), 0), bounded, 0);
  // A whole export written as a list but computed: a list, known only to its code.
  return isComputedList(value) ? { ...marked, computedList: true } : marked;
}

/** Whether an export's value is the CMS's marker for code that starts as a list: `[...a, ...b]`. */
export function isComputedList(value: unknown): boolean {
  const record = toRecord(value);
  const code = record?.[EXPRESSION];
  return isExpression(value) && typeof code === 'string' && code.trimStart().startsWith('[');
}

// Lists cut to PROJECT_LIST_ITEMS_MAX items, with the rest counted by the marker the
// sampler leaves for it (dataSample.ts `marker`), so "400 items" still says 400.
function boundedLists(value: unknown, depth: number): unknown {
  assert(depth <= LIMITS.treeDepthMax, 'boundedLists: depth limit exceeded');
  if (Array.isArray(value)) {
    const kept = value.slice(0, PROJECT_LIST_ITEMS_MAX).map((item: unknown) => boundedLists(item, depth + 1));
    const rest = value.length - kept.length;
    const out = rest > 0 ? [...kept, { __stacki: 'more', count: rest }] : kept;
    assert(out.length <= PROJECT_LIST_ITEMS_MAX + 1, 'boundedLists: the cut list is bounded');
    return out;
  }
  const record = toRecord(value);
  if (record === undefined || isExpression(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, boundedLists(item, depth + 1)]));
}

function withoutExpressions(value: unknown, depth: number): unknown {
  assert(depth <= LIMITS.treeDepthMax, 'withoutExpressions: depth limit exceeded');
  if (isExpression(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withoutExpressions(item, depth + 1));
  }
  const record = toRecord(value);
  if (record === undefined) {
    return value;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withoutExpressions(item, depth + 1)]));
}

function markExpressions(node: TreeNode, value: unknown, depth: number): TreeNode {
  assert(depth <= LIMITS.treeDepthMax, 'markExpressions: depth limit exceeded');
  if (isExpression(value)) {
    return { ...node, kind: 'value', preview: '' };
  }
  const children = node.children;
  if (children === undefined) {
    return node;
  }
  const list = Array.isArray(value) ? value : undefined;
  const record = toRecord(value);
  const marked = children.map((child) => markExpressions(child, list !== undefined ? list[Number(child.key)] : record?.[child.key], depth + 1));
  return { ...node, children: marked };
}

function isExpression(value: unknown): boolean {
  const record = toRecord(value);
  return record !== undefined && typeof record[EXPRESSION] === 'string' && Object.keys(record).length === 1;
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

// `directory` joined with a relative `spec`, `.` and `..` resolved; never above the project.
function joinPath(directory: string, spec: string): string | undefined {
  const parts = directory === '' ? [] : directory.split('/');
  for (const part of spec.split('/')) {
    if (part === '..') {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

// The path from `directory` to `target`, both project-relative, with `/`.
function relativePath(directory: string, target: string): string {
  const from = directory === '' ? [] : directory.split('/');
  const to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
    shared++;
  }
  const up = from.slice(shared).map(() => '..');
  return [...up, ...to.slice(shared)].join('/');
}
