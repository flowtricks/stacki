// The Settings panel's structural writes in Studio, as Desktop makes them: each
// builds the gesture Desktop's app builds (src/app/state/appPropertyEdits.ts,
// appPageOps.ts) from the same shared rules (src/app/model/pageModelGestures.ts,
// textPieces.ts, newPropGesture.ts), and writes it through Desktop's request
// drafting and planner (source/gestureWrite.ts). Each takes the page's text and
// gives back its new text, or throws with the reason the change cannot be made.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { LIMITS } from '../../../vendor/stacki/shared/core/limits';
import type { Attr } from '../../../vendor/stacki/shared/page/pageNode';
import { checkLoopHead, planVariableRename, type VariableRename } from '../../../vendor/stacki/shared/engine/variableRename';
import { loopRenameGesture, nodeGesture, unwrapGesture, variableRenameGesture } from '../../../vendor/stacki/src/editor/editGestures';
import { withAttributes } from '../../../vendor/stacki/src/editor/attributesBinding';
import { findEditorNodeById } from '../../../vendor/stacki/src/editor/pageState';
import type { EditorModel, EditorNode } from '../../../vendor/stacki/src/editor/pageView';
import { readPropsDestructure } from '../../../vendor/stacki/src/editor/loopProps';
import { readRestBinding, type PropDeclaration } from '../../../vendor/stacki/src/editor/propDeclaration';
import { ASTRO_ASSETS } from '../../../vendor/stacki/src/features/palette/astroAssets';
import type { NewPropHost } from '../../../vendor/stacki/src/features/props/newPropModel';
import type { Rename, TagOption } from '../../../vendor/stacki/src/features/props/propNodeEditors';
import type { TextPiece } from '../../../vendor/stacki/src/features/props/textConnect';
import {
  droppedForComponent,
  droppedForElement,
  layoutWrapperGesture,
  restatedText,
  tagChangeGesture,
  tagOptionsOf,
  toggledElseBranch,
  withComponentImport,
  withImportsGesture,
  withPrunedImports,
  type ImportPaths,
} from '../../../vendor/stacki/src/app/model/pageModelGestures';
import { textPiecesGesture } from '../../../vendor/stacki/src/app/model/textPieces';
import { newPropGesture } from '../../../vendor/stacki/src/app/model/newPropGesture';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { relativeImport } from '../source/imports';
import { pageOrigin, writeGesture } from '../source/gestureWrite';
import type { Component, Project } from '../project/projectClient';

/** Every gesture here is one undo step that saves at once, as Desktop's are. */
const NOW = { coalesceKey: undefined, urgency: true } as const;

/** A new node's id, in the grammar Desktop's gestures make (nodeFactory.ts, newId). */
const newId = (): string => `g${crypto.randomUUID().replace(/-/g, '')}`;

/** Whether a component is a layout: the scan marks those in the project's layout folders, by default src/layouts. */
export function isLayoutComponent(component: Pick<Component, 'isLayout'>): boolean {
  return component.isLayout === true;
}

/** What the Tag field offers on this page: tags, the project's components and layouts, Astro's own, and the page's imports. */
export function tagOptions(project: Pick<Project, 'components'>, source: string): readonly TagOption[] {
  const components = project.components.map((component) => ({ name: component.name, isLayout: isLayoutComponent(component) }));
  return tagOptionsOf(components, modelOf(source).imports);
}

/** What the layout picker offers: the project's layouts, by name. */
export function layoutOptions(project: Pick<Project, 'components'>): readonly TagOption[] {
  return project.components.filter((component) => isLayoutComponent(component)).map((component) => ({ name: component.name, kind: 'layout' }));
}

/** Node `id` renamed to `tag`: an element by its tag, an instance by a component
 * the page imports, the project has, or Astro provides. Undefined when nothing
 * provides that component, so the field puts the old name back, as Desktop's does. */
export function changedTag(source: string, file: string, id: string, tag: string, project: Pick<Project, 'components'>): string | undefined {
  const model = modelOf(source);
  const node = nodeOf(model, id);
  const name = tag.trim();
  if (/^[A-Z][\w$]*$/.test(name)) {
    if (node.name === name) {
      return source;
    }
    const already = model.imports.some((entry) => entry.name === name);
    const component = project.components.find((candidate) => candidate.name === name);
    const asset = ASTRO_ASSETS.some((entry) => entry.name === name);
    if (!already && component === undefined && !asset) {
      return undefined; // Nothing provides it.
    }
    const paths = component !== undefined && !already ? importPaths(file, component) : undefined;
    const change = { kind: 'component' as const, name, asset, dropped: droppedForComponent(node) };
    return writeGesture(
      source,
      tagChangeGesture(model, node, change, (page) => withComponentImport(page, name, { paths, asset })),
    );
  }
  const element = name.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(element)) {
    return undefined;
  }
  if (node.name === element) {
    return source;
  }
  const change = { kind: 'element' as const, name: element, asset: false, dropped: droppedForElement(node, element) };
  return writeGesture(source, tagChangeGesture(model, node, change, withPrunedImports));
}

/** The page wrapped in layout `name`, its wrapper renamed to it, or, for no name, unwrapped. */
export function changedLayout(source: string, file: string, name: string, project: Pick<Project, 'components'>): string {
  if (/\.mdx?$/i.test(file)) {
    throw new Error('A Markdown page names its layout in its frontmatter. Change it in Code.');
  }
  const model = modelOf(source);
  const wrapper = findEditorNodeById(model.nodes, 'layout');
  if (name === '') {
    return wrapper === undefined ? source : writeGesture(source, withImportsGesture(model, unwrapGesture('layout'), withPrunedImports));
  }
  const layout = project.components.find((component) => component.name === name && isLayoutComponent(component));
  if (layout === undefined) {
    throw new Error(`There is no layout named ${name}.`);
  }
  const gesture = layoutWrapperGesture(model, wrapper, { name, paths: importPaths(file, layout) });
  return gesture === undefined ? source : writeGesture(source, gesture);
}

/** An element's whole attribute list, in order (connecting it to an attributes prop). */
export function replacedProps(source: string, id: string, props: Readonly<Record<string, Attr>>): string {
  assert(Object.keys(props).length <= LIMITS.attrsPerNodeMax, 'An attribute list stays inside the per-node bound');
  const node = nodeOf(modelOf(source), id);
  return writeGesture(source, nodeGesture(id, withAttributes(node, props), NOW));
}

/** A condition given an else branch, or its else branch taken away (its markup kept). */
export function toggledElse(source: string, id: string, want: boolean): string {
  const node = nodeOf(modelOf(source), id);
  if (node.kind !== 'cond') {
    throw new Error('Selection changed. Select the condition again.');
  }
  const next = toggledElseBranch(node, want ? 'else' : 'no-else', newId);
  return next === undefined ? source : writeGesture(source, nodeGesture(id, next, NOW));
}

/** A text connected to data, or back to words (TextConnectField.tsx). */
export function textPieces(source: string, id: string, pieces: readonly TextPiece[]): string {
  const gesture = textPiecesGesture(modelOf(source), id, pieces);
  if (gesture === undefined) {
    throw new Error('Selection changed. Select the text again.');
  }
  return writeGesture(source, gesture);
}

/** A frontmatter variable renamed across the page, or why it cannot be. */
export function renamedVariable(source: string, rename: VariableRename): Result<string, string> {
  const origin = pageOrigin(source);
  const plan = planVariableRename(origin, rename);
  if (!plan.ok) {
    return err(plan.message);
  }
  return ok(writeGesture(source, variableRenameGesture(origin, rename, plan.hunks)));
}

/** A loop's head as the Code row commits it: checked first, since it compiles into
 * the page; a rename of a frontmatter variable goes across the page; the loop's own
 * renames follow into its children (Desktop's setLoopHead). */
export function committedLoopHead(source: string, id: string, value: string, renames: readonly Rename[]): Result<string, string> {
  const origin = pageOrigin(source);
  const node = findEditorNodeById(origin.model.nodes, id);
  if (node?.kind !== 'map') {
    return err('That loop is no longer on the page.');
  }
  const checked = checkLoopHead(origin, { id, before: node.head, after: value });
  if (checked.kind === 'problem') {
    return err(checked.message);
  }
  if (checked.kind === 'rename') {
    return renamedVariable(source, checked.rename);
  }
  const pairs = renames.flatMap((rename) => (rename.from && rename.to && rename.from !== rename.to ? [{ from: rename.from, to: rename.to }] : []));
  const renaming = pairs.length > 0 ? loopRenameGesture(origin.model, id, { head: value, renames: pairs }, NOW) : undefined;
  if (renaming !== undefined) {
    return ok(writeGesture(source, renaming));
  }
  if (value === node.head) {
    return ok(source);
  }
  const next = restatedText(node, value, renames);
  assert(next !== undefined, 'A loop restates its head');
  return ok(writeGesture(source, nodeGesture(id, next, NOW)));
}

/** The binding picker's component host, on a component's own file: its props, its
 * rest binding, and how a new prop is declared — written to the page at once, where
 * Desktop holds it for the binding that follows (one undo step there, two here). */
export function newPropHost(file: string, source: string, declared: readonly string[], write: (next: string) => void): NewPropHost | undefined {
  if (!/\.astro$/.test(file) || /^src\/pages\//.test(file)) {
    return undefined; // On a page there is no prop to make.
  }
  const model = modelOf(source);
  const frontmatter = model.extraFrontmatter;
  return {
    componentName: file.split('/').pop() ?? file,
    // The destructure's entries and the props the scan read from the component's own declaration.
    propKeys: [...new Set([...(readPropsDestructure(frontmatter)?.entries ?? []).map((entry) => entry.key), ...declared])],
    restLocal: readRestBinding(frontmatter)?.local,
    create: (declaration: PropDeclaration) => {
      const made = newPropGesture(model, declaration);
      if (!made.ok) {
        return made;
      }
      write(writeGesture(source, made.value.gesture));
      return ok(made.value.local);
    },
  };
}

function importPaths(file: string, component: Pick<Component, 'file' | 'importPath'>): ImportPaths {
  if (component.importPath !== undefined && component.importPath !== '') {
    return { relative: component.importPath, srcRelative: undefined }; // A package's component: its package path.
  }
  return { relative: relativeImport(file, component.file), srcRelative: component.file.startsWith('src/') ? component.file.slice(4) : undefined };
}

function modelOf(source: string): EditorModel {
  return pageOrigin(source).model;
}

function nodeOf(model: EditorModel, id: string): EditorNode {
  const node = findEditorNodeById(model.nodes, id);
  if (node === undefined) {
    throw new Error('Selection changed. Select the element again.');
  }
  return node;
}
