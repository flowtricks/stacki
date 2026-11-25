// Edits of the page model that the Settings panel makes, as pure functions: the
// imports a tag needs and the ones it leaves unused, a tag or kind change, a
// text field's restatement, a layout wrapper, a condition's else branch, and
// what the Tag field offers. The app's hooks call these (src/app/state), and
// Studio vendors this module so its Settings panel builds the same gestures
// from the same rules rather than a copy of them.
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ImportDecl, PageModel, PageNode } from '../../../shared/page/pageNode';
import { ASTRO_ASSETS, ASTRO_ASSETS_MODULE } from '../../features/palette/astroAssets';
import type { Rename, TagOption } from '../../features/props/propNodeEditors';
import { frontmatterGesture, propsGesture, sequence, tagRenameGesture, wrapGesture } from '../../editor/editGestures';
import { getElementSchema, GLOBAL_ATTRS, HTML_TAGS, VOID_TAGS } from '../../editor/elementSchemas';
import { disconnectedLoops, parseLoopHead, renamedLoopVar } from '../../editor/loopBindings';
import type { EditGesture } from '../../editor/pageEdits';
import { findEditorNodeById as findNodeById } from '../../editor/pageState';
import { nodeId, type EditorModel, type EditorNode } from '../../editor/pageView';

/** A component file's import path, relative to the page and (when under src) to src. */
export interface ImportPaths {
  readonly relative: string;
  readonly srcRelative: string | undefined;
}

/** A node of a condition: its then or else branch. */
type BranchNode = Extract<EditorNode, { readonly kind: 'branch' }>;

/** What the Tag field offers: every HTML tag, the project's components and
 * layouts, Astro's own, and whatever the page already imports — which is how
 * `<AstroLogo />` from an imported .svg becomes reachable. Each carries what it
 * is, so the list wears the insert palette's icons. */
export function tagOptionsOf(
  components: readonly { readonly name: string; readonly isLayout?: boolean | undefined }[],
  imports: readonly Pick<ImportDecl, 'name'>[],
): readonly TagOption[] {
  assert(components.length <= LIMITS.scanEntriesMax, 'tagOptionsOf: components stay inside the scan bound');
  const out: TagOption[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string): void => {
    if (name === '' || seen.has(name)) {
      return;
    }
    seen.add(name);
    out.push({ name, kind });
  };
  for (const tag of HTML_TAGS) {
    add(tag, 'element');
  }
  for (const component of components) {
    add(component.name, component.isLayout === true ? 'layout' : 'component');
  }
  for (const asset of ASTRO_ASSETS) {
    add(asset.name, 'astroAsset');
  }
  for (const entry of imports) {
    add(entry.name, 'component');
  }
  assert(out.length === seen.size, 'tagOptionsOf: each name is offered once');
  return out;
}

/** Whether an attribute survives any tag change: a global one, data-* and aria-*. */
function keptByAnyTag(attr: string): boolean {
  return GLOBAL_ATTRS.has(attr) || /^(data-|aria-)/.test(attr);
}

/** The attributes an element or instance gives up when it becomes `<tag>`: a
 * component's props were its API, and an element's own tag attributes the new
 * tag does not take mean nothing there (loading="eager" on img → div). */
/** Whether a `<style>` or `<script>` node already holds exactly `contents`. */
export function rawContentsMatch(node: EditorNode, contents: string): boolean {
  return node.kind === 'raw' && node.inner === contents;
}

export function droppedForElement(node: Pick<EditorNode, 'kind' | 'name' | 'props'>, tag: string): readonly string[] {
  assert(/^[a-z][a-z0-9-]*$/.test(tag), 'droppedForElement: an element tag is lowercase');
  const wasComponent = node.kind !== 'element';
  const oldNames = wasComponent ? new Set(Object.keys(node.props || {})) : new Set(getElementSchema(node.name ?? '').map((field) => field.name));
  const newNames = new Set(getElementSchema(tag).map((field) => field.name));
  return Object.keys(node.props || {}).filter((attr) => oldNames.has(attr) && !newNames.has(attr) && !keptByAnyTag(attr));
}

/** The attributes an element gives up when it becomes a component: its tag's
 * own attributes; class, data- and aria- carry over. An instance keeps all. */
export function droppedForComponent(node: Pick<EditorNode, 'kind' | 'name' | 'props'>): readonly string[] {
  const oldNames = node.kind === 'element' ? new Set(getElementSchema(node.name ?? '').map((field) => field.name)) : undefined;
  return Object.keys(node.props || {}).filter((attr) => oldNames?.has(attr) === true && !keptByAnyTag(attr));
}

/** The import a component name needs, when the page does not import it yet:
 * a project component by its file (`paths`), or one of Astro's assets by name. */
export function withComponentImport(
  model: EditorModel,
  name: string,
  source: { readonly paths: ImportPaths | undefined; readonly asset: boolean },
): EditorModel {
  if (model.imports.some((entry) => entry.name === name)) {
    return withPrunedImports(model);
  }
  const entry = source.paths
    ? { name, path: chooseImportPath(model, source.paths), quote: "'" }
    : source.asset
      ? { name, imported: name, path: ASTRO_ASSETS_MODULE, quote: "'", named: true }
      : undefined;
  return withPrunedImports(entry ? { ...model, imports: [...model.imports, entry] } : model);
}

/** A condition with an else branch added (an empty one) or taken away. Taking
 * it away keeps its markup — it moves into the then branch rather than being
 * deleted — so the button cannot quietly throw work away. Undefined when the
 * condition already is as asked. */
export function toggledElseBranch(node: EditorNode, want: 'else' | 'no-else', newId: () => string): EditorNode | undefined {
  assert(node.kind === 'cond', 'toggledElseBranch: a condition has the branches');
  const kids = node.children;
  assert(kids.length <= 2, 'toggledElseBranch: a condition has a then and at most an else');
  const thenBranch: BranchNode = kids[0] ?? { id: nodeId(newId()), kind: 'branch', name: 'then', children: [] };
  if (want === 'else') {
    if (kids.length < 2) {
      const elseBranch: BranchNode = { id: nodeId(newId()), kind: 'branch', name: 'else', children: [] };
      return { ...node, op: '?', children: [thenBranch, elseBranch] };
    }
    return undefined;
  }
  if (kids.length > 1) {
    const elseBranch = kids[1];
    assert(elseBranch !== undefined, 'Else branch exists before removal');
    const rescued = elseBranch.children || [];
    const merged = { ...thenBranch, children: [...(thenBranch.children || []), ...rescued] };
    return { ...node, op: '&&', children: [merged] };
  }
  return undefined;
}

// --- Moved from nodeFactory.ts, pageGestures.ts and appKeys.ts, which re-export them ---

export function collectUsedNames(model: PageModel): Set<string> {
  const used = new Set<string>();
  const walk = (list: readonly PageNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'collectUsedNames: depth exceeds the tree cap');
    for (const node of list) {
      if ('name' in node && node.name) {
        used.add(node.name);
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  return used;
}

// Comments in the frontmatter are prose about the page, and prose names the
// things the page is built from — `// Hero copy` is talk about <Hero>, not a
// use of it. Only whole-line `//` comments go: a trailing one can't be told
// from the `//` inside a URL without really parsing, and cutting a string in
// half there would hide a reference that is real.
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Everything in the file that is code rather than markup: the frontmatter, a
// loop's head, a condition's test, an expression node, and any prop whose
// value is an expression. An imported name can be used in any of them without
// ever appearing as a tag.
//
// <style> and <script> bodies are pointedly not code for this purpose. Both
// are their own scope in Astro — CSS never sees a frontmatter binding, and a
// <script> is a separate module — so a name inside one is a coincidence, not
// a use. Reading them meant a `.Hero` class or a `/* Hero */` note pinned
// <Hero>'s import in place for good. What those blocks genuinely share comes
// in through `define:vars`, which is a prop expression and is still read.
export function codeText(model: PageModel): string {
  const parts = [stripComments(model.extraFrontmatter || '')];
  const walk = (list: readonly PageNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'codeText: depth exceeds the tree cap');
    for (const node of list) {
      if (node.kind === 'expr' || node.kind === 'raw-line') {
        parts.push(node.value || '');
      }
      if (node.kind === 'map') {
        parts.push(node.head || '');
      }
      if (node.kind === 'cond') {
        parts.push(node.test || '');
      }
      const props = 'props' in node ? node.props : undefined;
      for (const value of Object.values(props || {})) {
        if (value && (value.type === 'expr' || value.type === 'spread')) {
          parts.push(String(value.value ?? ''));
        }
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  return parts.join('\n');
}

/** A tag's new name and kind, and the attributes the new name does not keep. */
export interface TagChange {
  readonly kind: 'element' | 'component';
  readonly name: string;
  readonly asset: boolean;
  readonly dropped: readonly string[];
}

// A tag renamed (step 9): the attributes the new name does not keep removed
// first — removals anchor on the node as authored, and a rename may change
// its kind, which the next request's anchor would no longer match — then the
// name, then the imports the new name needs and the old one leaves unused, all
// one undo step. Void tags keep no children: `<img>` holds none.
export function tagChangeGesture(model: EditorModel, node: EditorNode, change: TagChange, imports: (model: EditorModel) => EditorModel): EditGesture {
  const options = { coalesceKey: undefined, urgency: true };
  const patch = Object.fromEntries(change.dropped.map((attr) => [attr, undefined]));
  const removal = propsGesture(node.id, patch, options);
  const kept = change.dropped.length > 0 ? removal.apply(model) : model;
  const before = findNodeById(kept.nodes, node.id);
  assert(before !== undefined, 'The renamed node survives its attribute removals');
  const children = VOID_TAGS.has(change.name) ? undefined : before.children;
  // A fresh copy, so taking the old tag's flags off it edits nothing shown.
  const next: EditorNode = Object.assign({}, before, {
    kind: change.kind,
    name: change.name,
    children,
  });
  Reflect.deleteProperty(next, 'dynamicTag');
  Reflect.deleteProperty(next, 'astroAsset');
  if (change.asset) {
    Object.assign(next, { astroAsset: true });
  }
  const rename = tagRenameGesture(node, next, options);
  const renamed = rename.apply(kept);
  const named = change.dropped.length > 0 ? sequence(removal, rename) : rename;
  if (frontmatterOf(imports(renamed)) === frontmatterOf(renamed)) {
    return named;
  }
  return sequence(named, frontmatterGesture(renamed, options, imports));
}

// The node as a text field states it (step 9): a loop's head — the renames
// followed below it, and loops reading an item whose data changed disconnected
// — a condition's test, a style or script body, or the value of a text, an
// expression or a note. A new node; the shown one is left as it was, and the
// loop helpers edit a private copy of the loop only.
export function restatedText(node: EditorNode, value: string, renames: readonly Rename[] | undefined): EditorNode | undefined {
  switch (node.kind) {
    case 'map': {
      const renamed = (renames || []).reduce(
        (children, { from, to }) => (from && to && from !== to ? renamedLoopVar(children, from, to) : children),
        node.children,
      );
      // Renames above already re-pointed the children, so compare the data
      // sources and orphan-proof what reads from this item.
      const before = parseLoopHead(node.head);
      const after = parseLoopHead(value);
      const vars = after ? [after.item, after.index].filter(Boolean) : [];
      const moved = before && after && before.data !== after.data && vars.length > 0;
      const children = moved ? disconnectedLoops(renamed, vars) : renamed;
      return { ...node, head: value, children };
    }
    case 'cond':
      return { ...node, test: value };
    case 'raw':
      return { ...node, inner: value };
    case 'text':
    case 'expr':
    case 'comment':
      return { ...node, value };
    case 'element':
    case 'component':
    case 'branch':
    case 'raw-line':
    case 'chunk-group':
      return undefined; // No text field states these.
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// The text a node's field states, as restatedText writes it back: undefined
// for a node no text field states.
export function statedText(node: EditorNode): string | undefined {
  switch (node.kind) {
    case 'map':
      return node.head;
    case 'cond':
      return node.test;
    case 'raw':
      return node.inner;
    case 'text':
    case 'expr':
    case 'comment':
      return node.value;
    case 'element':
    case 'component':
    case 'branch':
    case 'raw-line':
    case 'chunk-group':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// The frontmatter a model describes, compared as data.
export function frontmatterOf(model: PageModel): string {
  return JSON.stringify([model.imports, model.extraFrontmatter]);
}

// Imports the app is willing to remove once nothing refers to them: a
// component file of any flavour Astro renders, an image, and Astro's own
// <Image>/<Picture>. All three are reachable only as a tag or from an
// expression, both of which the check below reads in full. A stylesheet, a
// data module or a utility is left alone — those get imported for effects
// this file can't see, and dropping one that is still doing its job breaks
// the page.
export const COMPONENT_IMPORT_RE = /\.(astro|jsx|tsx|vue|svelte)$/i;
export const ASSET_IMPORT_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

export function prunableImport(i: ImportDecl): boolean {
  return COMPONENT_IMPORT_RE.test(i.path) || ASSET_IMPORT_RE.test(i.path) || i.path === ASTRO_ASSETS_MODULE;
}

export function withPrunedImports(model: EditorModel): EditorModel {
  const used = collectUsedNames(model);
  // A name can be referenced as code rather than as a tag — inside a
  // `<Fragment set:html>` chunk, a frontmatter const, a prop expression. The
  // test is deliberately loose (a bare word anywhere in the code counts),
  // because the cost of a false positive is a stray import and the cost of a
  // false negative is deleting something the page still needs.
  const code = codeText(model);
  const mentioned = (name: string): boolean => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
  const imports = model.imports.filter((i) => !prunableImport(i) || used.has(i.name) || mentioned(i.name));
  return imports.length === model.imports.length ? model : { ...model, imports };
}

// Chooses an import path matching the page's existing style: if it already
// imports via a src alias (e.g. "@/components/X.astro"), reuse that alias
// root for the new import; otherwise fall back to a relative path.
export function chooseImportPath(model: Pick<PageModel, 'imports'>, paths: { readonly relative: string; readonly srcRelative: string | undefined }): string {
  const { relative, srcRelative: sourceRelative } = paths;
  if (sourceRelative) {
    for (const imp of model.imports) {
      if (imp.path.startsWith('.')) {
        continue;
      }
      for (const marker of ['/components/', '/layouts/']) {
        const index = imp.path.indexOf(marker);
        if (index > 0) {
          return imp.path.slice(0, index + 1) + sourceRelative;
        }
      }
    }
  }
  return relative;
}

export const withLayoutField = (frontmatter: string, layoutPath: string | undefined): string => {
  const fm = frontmatter ?? '';
  if (/^[ \t]*layout[ \t]*:/m.test(fm)) {
    return layoutPath ? fm.replace(/^[ \t]*layout[ \t]*:.*$/m, `layout: ${layoutPath}`) : fm.replace(/^[ \t]*layout[ \t]*:.*(\n|$)/m, '');
  }
  if (!layoutPath) {
    return fm;
  }
  // First, so it reads as the page's frame rather than one field among many.
  return fm ? `layout: ${layoutPath}\n${fm}` : `layout: ${layoutPath}`;
};

// A markdown page's layout, written into its `layout:` frontmatter key.
export function markdownLayoutGesture(model: EditorModel, rel: string | undefined): EditGesture {
  const framed = (pageModel: EditorModel): EditorModel => ({
    ...pageModel,
    extraFrontmatter: withLayoutField(pageModel.extraFrontmatter, rel),
    layoutPath: rel,
  });
  return frontmatterGesture(model, { coalesceKey: undefined, urgency: true }, framed);
}

// The imports a wrapper change needs, and those it leaves unused, as the same
// undo step (step 9: a frontmatter slot).
export function withImportsGesture(model: EditorModel, gesture: EditGesture, imports: (pageModel: EditorModel) => EditorModel): EditGesture {
  const after = gesture.apply(model);
  const options = { coalesceKey: undefined, urgency: true };
  return frontmatterOf(imports(after)) === frontmatterOf(after) ? gesture : sequence(gesture, frontmatterGesture(after, options, imports));
}

// The page's layout wrapper renamed to `layout`, or the page wrapped in it when it has
// none; undefined when the wrapper already is that layout or is not a tag.
export function layoutWrapperGesture(
  model: EditorModel,
  wrapper: EditorNode | undefined,
  layout: { readonly name: string; readonly paths: ImportPaths },
): EditGesture | undefined {
  const { name, paths } = layout;
  const imports = (pageModel: EditorModel): EditorModel =>
    withPrunedImports(
      pageModel.imports.some((i) => i.name === name)
        ? pageModel
        : {
            ...pageModel,
            imports: [...pageModel.imports, { name, path: chooseImportPath(pageModel, paths), quote: "'" }],
          },
    );
  if (wrapper) {
    if (wrapper.kind !== 'component' && wrapper.kind !== 'element') {
      return undefined;
    }
    if (wrapper.name === name) {
      return undefined;
    }
    const renamed: EditorNode = { ...wrapper, name };
    const options = { coalesceKey: undefined, urgency: true };
    return withImportsGesture(model, tagRenameGesture(wrapper, renamed, options), imports);
  }
  // No wrapper yet — wrap the whole page in the new layout.
  const created: EditorNode = {
    id: nodeId('layout'),
    kind: 'component',
    name,
    props: {},
    children: [],
  };
  return withImportsGesture(model, wrapGesture(model, created), imports);
}
