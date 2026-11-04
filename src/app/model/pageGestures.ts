// Gestures that rewrite a page around a node: pruning unused imports and
// choosing an import path, a layout's fields, a schema, the class field,
// extracting a component, and what a paste brings in (App.tsx).

import type { ImportDecl, PageModel, PageNode } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { findWithParent } from '../../editor/treeSelection';
import { ASTRO_ASSETS_MODULE, PLACEHOLDER_PROPS } from '../../features/palette/astroAssets';
import { getElementSchema, VOID_TAGS } from '../../editor/elementSchemas';
import { isInlineOnly } from '../../features/props/RichContent';
import { type EditGesture } from '../../editor/pageEdits';
import { type InsertPlace, frontmatterGesture, insertGesture, removalGesture, sequence } from '../../editor/editGestures';
import type { NodeId } from '../../../shared/core/brand';
import { nodeAtPath } from '../../editor/editorTree';
import { namesUsedIn, neededFrontmatter, withStatements } from '../../editor/frontmatterMove';
import type { FieldDefinition } from '../../features/props/propRules';
import type { AstroAsset } from '../../features/palette/astroAssets';
import type { InsertItem } from '../../features/palette/InsertSearch';
import { type HistoryEntry, type NodeClipboard } from '../appTypes';
import { findEditorNodeById as findNodeById, findEditorParentList as findParentList, type OpenFile } from '../../editor/pageState';
import { type EditorModel, type EditorNode } from '../../editor/pageView';
import { findImportPath, rebaseProjectImport, type ImportPaths } from '../../ipc/appBridge';
import { newId, defaultText, collectUsedNames, codeText, voided, frontmatterOf } from './nodeFactory';
import { STYLE_GLOBAL_ATTRIBUTE } from './styleBlockScope';

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

// Whether the props panel would offer this node a Content field — the rich
// inline editor over its words. The same test PropsPanel makes: children that
// are all text and simple inline tags, or an element still empty and able to
// hold text. Kept in step with it by hand; the two disagreeing would mean a
// double-click that focuses a field which isn't there.
export function holdsInlineText(node: PageNode | undefined): boolean {
  if (!node || node.kind !== 'element') {
    return false;
  }
  if (VOID_TAGS.has(String(node.name).toLowerCase())) {
    return false;
  }
  const kids = node.children;
  return isInlineOnly(kids) || !Array.isArray(kids) || kids.length === 0;
}

// Pass over the steps with nothing of their own to undo (folded into a
// newer step's write, dropped before they were sent): bounded by the history.
export const effective = (list: HistoryEntry[]): HistoryEntry | undefined => {
  let entry = list.pop();
  while (entry?.kind === 'edits' && voided(entry.record.outcome)) {
    entry = list.pop();
  }
  return entry;
};

// The welcome screen's thumbnails are taken in the main process now, from
// the project's home page rendered in a window of its own (see
// electron/project/thumbs.ts). Photographing this window was what put the editor's
// own panels — and whatever page and scroll position the user left — into
// the picture that is supposed to show the site.

// The comment sitting directly above a node. The navigator folds it into
// that node's row rather than giving it one of its own, and the props panel
// edits it there — so a section's label and its note stay together.
export const commentAbove = (model: EditorModel | undefined, nodeId: string | undefined): EditorNode | undefined => {
  if (!model || !nodeId) {
    return undefined;
  }
  const found = findParentList(model, nodeId);
  if (!found || found.index === 0) {
    return undefined;
  }
  const previous = found.list[found.index - 1];
  return previous && previous.kind === 'comment' ? previous : undefined;
};

// Set/replace/remove the `layout:` key in a markdown page's YAML
// frontmatter, leaving every other key and its formatting alone. The
// frontmatter text stays the single source of truth — editing it by hand in
// the frontmatter editor and picking a layout here write to the same place.
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

// A component whose Props extends HTMLAttributes<"tag"> also accepts that
// element's built-in attributes — merge them in after its own props.
export const schemaFor = (entry: ScanComponent | AstroAsset | undefined): readonly FieldDefinition[] => {
  if (!entry) {
    return [];
  }
  const own = entry.schema || [];
  const ownNames = new Set(own.map((field) => field.name));
  const extendsTag = 'extendsTag' in entry ? entry.extendsTag : undefined;
  const inherited = extendsTag ? getElementSchema(extendsTag).filter((field) => !ownNames.has(field.name)) : [];
  // A component that spreads `...rest` passes class straight through to
  // whatever it renders, so styling one is a normal thing to want — give it
  // the same class field an element has rather than making the user add it
  // by hand in Attributes.
  const passesClass = entry.hasRest && !own.some((field) => /^class(Name|es)?$/i.test(field.name)) && !inherited.some((field) => field.name === 'class');
  return [...own, ...(passesClass ? [{ name: 'class', type: 'string', optional: true }] : []), ...inherited];
};

// Every element takes a class, and it's the field people reach for most —
// but it lives in the global attributes, not in any tag's own schema, so it
// only appeared once something had already set one. Given first place, right
// under the tag, on anything that renders an element.
export const withClassField = (fields: readonly FieldDefinition[]): readonly FieldDefinition[] =>
  fields.some((field) => field.name === 'class') ? fields : [{ name: 'class', type: 'string', optional: true }, ...fields];

// A marker path may arrive namespaced (src/…/Card.astro|0.1). The index trail
// after the pipe is what addresses a node in the open file's tree.
export const trailOf = (path: string): number[] => (path.split('|').pop() ?? '').split('.').map(Number);

// The stack entry for a component opened from `host` (an instance in the file on screen).
export function componentEntry(
  stack: readonly OpenFile[],
  nodes: readonly EditorNode[],
  component: { readonly name: string; readonly path: string },
  host: { readonly path: string | undefined; readonly occurrence: number },
): OpenFile {
  // The canvas keeps showing the page, so remember which instance was
  // opened — that region stays lit while the rest dims. Drilling deeper
  // keeps the outermost instance as the focus: a nested component's
  // internals aren't addressable in the page's own markers.
  //
  // Which copy of it, too: a component rendered inside a loop is on the
  // page once per item, and opening one card means that card. Without the
  // occurrence every instance stayed lit, and editing one looked like
  // editing all of them.
  //
  // A layout is the exception: it wraps <html>, so the instance IS the
  // page and there is nothing around it to dim. Its path still names the
  // focus — clicks route by it, and one in the page's own content still
  // means "I'm done in here" — but the lit region would be the page's slot
  // content, which is the one part of the canvas the layout does NOT own.
  // Dimming the header, the sidebar and the footer while lighting the page
  // body said the opposite of what opening a layout does.
  const top = stack[stack.length - 1];
  const hostPath = host.path;
  const hostNode = hostPath ? nodeAtPath(nodes, (String(hostPath).split('|').at(-1) ?? '').split('.').map(Number)) : undefined;
  const focusPath = top?.focusPath ?? hostPath ?? undefined;
  const nested = top?.focusPath !== undefined;
  const focusOcc = nested ? (top.focusOcc ?? 0) : host.occurrence;
  const focusWhole = nested ? !!top.focusWhole : hostNode?.id === 'layout';
  return {
    kind: 'component',
    name: component.name,
    path: component.path,
    focusPath,
    focusOcc,
    focusWhole,
    hostKey: hostPath ?? undefined,
  };
}

// The markup a new component took, replaced in the page by an instance of it: the
// instance goes in before the markup, the markup comes out, and the import follows —
// one undo step, the markup's bytes moved to the new file rather than reprinted.
export function extractionGesture(
  shown: EditorModel,
  nodeId: string,
  extracted: {
    readonly id: NodeId;
    readonly name: string;
    readonly props: readonly string[];
    readonly place: InsertPlace;
    readonly paths: ImportPaths;
  },
): EditGesture {
  const { id, name, props, place, paths } = extracted;
  // The instance passes each value straight back in under its own name.
  // That's what reconnects it: `title` meant the page's title where this
  // markup used to sit, and it still does, one level out.
  const instance: EditorNode = {
    id,
    kind: 'component',
    name,
    props: Object.fromEntries(props.map((prop) => [prop, { type: 'expr', value: prop }])),
    children: undefined,
  };
  const urgent = { coalesceKey: undefined, urgency: true };
  const replaced = sequence(insertGesture(shown, instance, place, urgent), removalGesture([nodeId], urgent));
  const after = replaced.apply(shown);
  const imports = (pageModel: EditorModel): EditorModel =>
    pageModel.imports.some((i) => i.name === name)
      ? pageModel
      : {
          ...pageModel,
          imports: [...pageModel.imports, { name, path: chooseImportPath(pageModel, paths), quote: "'" }],
        };
  return frontmatterOf(imports(after)) === frontmatterOf(after) ? replaced : sequence(replaced, frontmatterGesture(after, urgent, imports));
}

// What creating a component says it did.
export function createdComponentMessage(rel: string, propCount: number, { stranded }: { readonly stranded: boolean }): string {
  if (stranded) {
    return `Created ${rel} — it reads page data, so it will need props.`;
  }
  if (propCount > 0) {
    return `Created ${rel} with ${propCount} prop${propCount === 1 ? '' : 's'}.`;
  }
  return `Created ${rel}`;
}

// What a pasted subtree needs from its new page: project components to import from
// where they live, and the imports and declarations it read on the page it came from.
export async function pasteNeeds(
  clip: NodeClipboard,
  model: EditorModel,
  context: {
    readonly insertables: readonly ScanComponent[];
    readonly resolveImportPath: (targetPath: string) => Promise<ImportPaths>;
    readonly currentPath: () => string | undefined;
  },
): Promise<PasteNeeds> {
  // Everything the subtree reads: the components it renders and every name in
  // the code hanging off it — `options={jobs}`, a loop's `posts.map`, a
  // condition's test.
  const names = namesUsedIn([clip.node]);
  const knows = (nm: string): boolean =>
    model.imports.some((i) => i.name === nm) || new RegExp(`\\b${nm.replace(/\$/g, '\\$')}\\b`).test(model.extraFrontmatter || '');
  const missing = [...names].filter((nm) => !knows(nm));
  // A component this project has is imported from where it actually lives,
  // whatever the page it was copied from called it.
  const resolved: {
    readonly name: string;
    readonly paths: Awaited<ReturnType<typeof findImportPath>>;
  }[] = [];
  const byScan = new Set<string>();
  for (const nm of missing) {
    const target = context.insertables.find((component) => component.name === nm);
    if (target) {
      byScan.add(nm);
      resolved.push({
        name: nm,
        paths: await context.resolveImportPath(target.path),
      });
    }
  }

  // And what is left is the page's own code: an import of something that is
  // not a component (an image, `getCollection`), or a `const` it declared.
  // Both come across, and a declaration brings whatever it reads in turn.
  const carried = neededFrontmatter({
    names: missing.filter((nm) => !byScan.has(nm)),
    frontmatter: clip.frontmatter || '',
    imports: clip.imports || [],
    has: knows,
  });
  const carriedImports: ImportDecl[] = [];
  for (const imp of carried.imports) {
    // A relative path means something different from another page's folder.
    const rebased =
      clip.pagePath && String(imp.path || '').startsWith('.') ? await rebaseProjectImport(clip.pagePath, context.currentPath(), imp.path) : { path: imp.path };
    carriedImports.push({
      name: imp.name,
      path: rebased.path || imp.path,
      quote: "'",
    });
  }

  return { resolved, carried, carriedImports };
}

export interface PasteNeeds {
  readonly resolved: readonly { readonly name: string; readonly paths: ImportPaths }[];
  readonly carried: ReturnType<typeof neededFrontmatter>;
  readonly carriedImports: readonly ImportDecl[];
}

// The page's imports and frontmatter with what a paste needs added.
export function pastedImports(needs: PasteNeeds): (model: EditorModel) => EditorModel {
  const { resolved, carried, carriedImports } = needs;
  return (model) => {
    let imports = model.imports;
    for (const entry of resolved) {
      if (!imports.some((i) => i.name === entry.name)) {
        const spec = chooseImportPath(model, entry.paths);
        imports = [...imports, { name: entry.name, path: spec, quote: "'" }];
      }
    }
    for (const imp of carriedImports) {
      if (!imports.some((i) => i.name === imp.name)) {
        imports = [...imports, imp];
      }
    }
    const extraFrontmatter = carried.statements.length ? withStatements(model.extraFrontmatter, carried.statements) : model.extraFrontmatter;
    return { ...model, imports, extraFrontmatter };
  };
}

// Pastes into the selection when it can host children (a non-void element, or a
// component with a default slot), otherwise after it, or at the end of the page.
export function pastePlace(model: EditorModel, selectionId: string | undefined, insertables: readonly ScanComponent[]): InsertPlace {
  const acceptsChildren = (node: EditorNode): boolean => {
    if (node.id === 'layout') {
      return true;
    }
    if (node.kind === 'element') {
      return !VOID_TAGS.has(String(node.name).toLowerCase());
    }
    if (node.kind === 'component') {
      return (insertables.find((component) => component.name === node.name)?.slots || []).includes('default');
    }
    return false;
  };
  const selection = selectionId ? findNodeById(model.nodes, selectionId) : undefined;
  const found = selectionId ? findWithParent(model.nodes, selectionId) : undefined;
  if (selection && acceptsChildren(selection)) {
    const index = Array.isArray(selection.children) ? selection.children.length : 0;
    return { parentId: selection.id, index };
  }
  if (found) {
    return { parentId: found.parent?.id ?? undefined, index: found.index + 1 };
  }
  return { parentId: undefined, index: model.nodes.length };
}

// An Astro asset component, placed with the named import it needs when the page lacks it.
export function astroAssetGesture(
  model: EditorModel,
  asset: { readonly id: NodeId; readonly name: string },
  target: Parameters<typeof insertGesture>[2],
): EditGesture {
  // Self-closing, and already valid: Astro throws on an <Image> with no
  // src, so a bare one would swap the canvas for a stack trace the
  // moment it landed. See PLACEHOLDER_PROPS.
  const node: EditorNode = {
    id: asset.id,
    kind: 'component',
    name: asset.name,
    props: { ...PLACEHOLDER_PROPS },
    children: undefined,
  };
  // Step 6, insert and frontmatter: the import when the page lacks it,
  // then the node.
  const insert = insertGesture(model, node, target, { urgency: true });
  if (model.imports.some((i) => i.name === asset.name && !i.typeOnly)) {
    return insert;
  } else {
    const named = {
      name: asset.name,
      imported: asset.name,
      path: ASTRO_ASSETS_MODULE,
      named: true,
      quote: "'",
    };
    const imported = (pageModel: EditorModel): EditorModel => ({
      ...pageModel,
      imports: [...pageModel.imports, named],
    });
    const options = { coalesceKey: undefined, urgency: true };
    return sequence(frontmatterGesture(model, options, imported), insert);
  }
}

// A new node for an insert-palette item that needs no import, or undefined for one
// that is not inserted as a node here. A style block is always global
// (styleBlockScope.ts).
export function insertedNode(item: InsertItem, id: NodeId): EditorNode | undefined {
  let node: EditorNode | undefined = undefined;
  if (item.type === 'element') {
    const placeholder = defaultText(item.tag);
    node = {
      id,
      kind: 'element',
      name: item.tag,
      props: {},
      children: VOID_TAGS.has(item.tag) ? undefined : placeholder ? [{ id: newId(), kind: 'text', value: placeholder }] : [],
    };
  } else if (item.type === 'map') {
    // No source until one is picked in the props panel. An empty literal
    // renders nothing; a placeholder name would throw "x is not defined"
    // and take the preview down the moment the loop lands on the page.
    node = { id, kind: 'map', head: '[].map((item) => (', children: [] };
  } else if (item.type === 'cond') {
    // `true` until a real test is typed: the then branch renders, so the
    // condition is visible on the canvas the moment it lands.
    //
    // Just the then. Most conditions never want an else, and one that does
    // is a switch away in the props panel — where turning it back off
    // brings the markup home rather than dropping it. Until then there is
    // nothing to choose between, so the tree shows what is inside the
    // condition directly (see branches.js) instead of a row saying "then".
    node = {
      id,
      kind: 'cond',
      op: '&&',
      test: 'true',
      children: [{ id: newId(), kind: 'branch', name: 'then', children: [] }],
    };
  } else if (item.type === 'comment') {
    node = { id, kind: 'comment', value: ' Comment ' };
  } else if (item.type === 'text') {
    node = { id, kind: 'text', value: 'Text' };
  } else if (item.type === 'expr') {
    node = { id, kind: 'expr', value: '{/* code */}' };
  } else if (item.type === 'doctype') {
    node = { id, kind: 'raw-line', value: '<!doctype html>' };
  } else if (item.type === 'style') {
    node = { id, kind: 'raw', name: 'style', props: { [STYLE_GLOBAL_ATTRIBUTE]: { type: 'bare' } }, inner: '' };
  } else if (item.type === 'script') {
    node = { id, kind: 'raw', name: 'script', props: {}, inner: '' };
  }
  return node;
}
