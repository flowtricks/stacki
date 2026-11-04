// Editing a node's properties: its comment, classes, asset props, renames,
// kind and tag, text, branches and content (App.tsx).

import type { ClassOutcome } from '../../features/style/model/host';
import { useCallback, useRef } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import { findWithParent, noteValue } from '../../editor/treeSelection';
import { assert } from '../../../shared/core/assert';
import { ASTRO_ASSETS, ASTRO_ASSETS_MODULE } from '../../features/palette/astroAssets';
import { getElementSchema, GLOBAL_ATTRS } from '../../editor/elementSchemas';
import {
  attributeRenameGesture,
  frontmatterGesture,
  inlineStyleGesture,
  insertGesture,
  loopRenameGesture,
  nodeGesture,
  propsGesture,
  removalGesture,
  sequence,
  withChildren,
} from '../../editor/editGestures';
import { readFrontmatter } from '../../../shared/page/frontmatterSource';
import { hasClass, withClass } from '../../editor/classAttr';
import { withAttributes } from '../../editor/attributesBinding';
import { previewAddedClass, previewClassProps } from '../../editor/previewClassPatch';
import { cleanError } from '../../lib/cleanError';
import type { AssetReference, PickedAsset } from '../../ui/AssetField';
import type { InlineNode } from '../../features/props/RichContent';
import type { Rename } from '../../features/props/propNodeEditors';
import type { PropValues } from '../../features/props/propRules';
import { findEditorNodeById as findNodeById } from '../../editor/pageState';
import { type EditorModel, type EditorNode } from '../../editor/pageView';
import { findImportPath } from '../../ipc/appBridge';
import { newId, inlineWithIds, type BranchNode, tagChangeGesture, restatedText, statedText, frontmatterOf } from '../model/nodeFactory';
import { withPrunedImports, chooseImportPath } from '../model/pageGestures';
import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import { useHistory } from './appNodeEdits';
import { useNodeEdits } from './appShortcuts';

// The note above a node.
export function useComment(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Write (or clear) that comment. Empty text removes the node entirely, so
  // clearing the field doesn't leave `<!---->` behind.
  const setComment = useCallback(
    (nodeId: string, text: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const found = findWithParent(state.model.nodes, nodeId);
      if (!found) {
        return;
      }
      const previous = found.index > 0 ? found.siblings[found.index - 1] : undefined;
      const existing = previous && previous.kind === 'comment' ? previous : undefined;
      const body = String(text ?? '').trim();
      if (!body) {
        if (existing) {
          // Step 6, remove: clearing the field takes the note out.
          commitEdit(removalGesture([existing.id], { urgency: false }));
        }
        return;
      }
      // The parser keeps the raw text between the delimiters, so it is padded
      // to serialize as `<!-- text -->` the way a hand-written one reads — and
      // a note written as a divider keeps its rule, to the same width, so a
      // column of them stays lined up.
      const value = noteValue(existing?.value, body);
      assert(value !== undefined, 'A nonempty comment produces a serialized value');
      if (!existing) {
        // Step 6, insert: a new note, right above its node.
        const note: EditorNode = { id: newId(), kind: 'comment', value };
        const place = { parentId: found.parent?.id ?? undefined, index: found.index };
        commitEdit(insertGesture(state.model, note, place, { urgency: false }));
        return;
      }
      // Step 9, rewording: the note restated, its new words placed on its bytes.
      const note = findNodeById(state.model.nodes, existing.id);
      if (note?.kind !== 'comment') {
        return;
      }
      const options = { coalesceKey: `comment:${nodeId}`, urgency: false };
      commitEdit(nodeGesture(note.id, { ...note, value }, options));
    },
    [commitEdit, pageStateRef],
  );
  return { setComment };
}

// Classes and props.
export function useClassEdits(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;
  const addClassToNode = useAddClassToNode(coreState, lifecycle, history);

  // Step 6, attribute: set or remove one prop, as an edit request when it has
  // an intent form (editGestures.ts), else as a whole-model save.
  const setProp = useCallback(
    (nodeId: string, propName: string, value: Attr | undefined, immediate = false, previewPath?: string) => {
      const coalesceKey = `prop:${nodeId}:${propName}`;
      const options = { coalesceKey, urgency: immediate };
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      const previous = propName === 'style' ? node?.props?.['style'] : undefined;
      if (previous?.type === 'string' && value?.type === 'string') {
        // Step 6, inline CSS: one declaration changed is one declaration edited.
        const styles = { before: previous.value, after: value.value };
        commitEdit(inlineStyleGesture(nodeId, styles, options));
        return;
      }
      if (commitEdit(propsGesture(nodeId, { [propName]: value }, options))) {
        previewClassProps(previewPath, node, { [propName]: value });
      }
    },
    [commitEdit, pageStateRef],
  );

  // Several props in one edit, so picking an image and getting its width and
  // height back is a single undo rather than three.
  const setProps = useCallback(
    (nodeId: string, patch: PropValues, immediate = true, previewPath?: string) => {
      const coalesceKey = `props:${nodeId}:${Object.keys(patch).join(',')}`;
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (commitEdit(propsGesture(nodeId, patch, { coalesceKey, urgency: immediate }))) {
        previewClassProps(previewPath, node, patch);
      }
    },
    [commitEdit, pageStateRef],
  );
  // An element's whole attribute list, in order: connecting it to an
  // attributes prop puts the defaults before the spread and its own after,
  // which a patch (new names last) cannot say. One node rewrite, one undo.
  const replaceProps = useCallback(
    (nodeId: string, props: Readonly<Record<string, Attr>>) => {
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (node === undefined) {
        return;
      }
      assert(node.id === nodeId, 'replaceProps: the node found is the one named');
      const next = withAttributes(node, props);
      commitEdit(nodeGesture(nodeId, next, { coalesceKey: undefined, urgency: true }));
    },
    [commitEdit, pageStateRef],
  );
  return { addClassToNode, setProp, setProps, replaceProps };
}

function useAddClassToNode(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { flushSave, showToast } = lifecycle;
  const { commitEdit } = history;
  // Typing a bare class in the style panel's selector box puts it on the
  // element too — a rule for a class the element doesn't carry would never
  // apply. Where it goes depends on how the element's classes are written: a
  // plain `class`, a `class:list`, or a template literal (see classAttr.ts).
  // Other expressions stay intact while class:list adds the new class.
  // Resolves with the page edit's outcome, once it reached disk or was
  // refused: the style panel writes the class's rule only after it applied
  // (step 6, plan §3.3 — outcome-gated, never a fabricated atomicity).
  return useCallback(
    async (nodeId: string, className: string, previewPath?: string): Promise<ClassOutcome> => {
      const clean = String(className || '').trim();
      const state = pageStateRef.current.pageState;
      if (!nodeId || !clean || !state?.editable) {
        return { tag: 'refused', message: 'no element is selected' };
      }
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) {
        return { tag: 'refused', message: 'the element is gone' };
      }
      if (hasClass(node.props, clean)) {
        return { tag: 'applied' };
      }
      const edit = withClass(node.props, clean);
      if (!edit) {
        const message = `Stacki couldn’t add the class “${clean}”. Check the class name and retry.`;
        showToast(message, 'error');
        return { tag: 'refused', message };
      }
      // Step 6, attribute: the class attribute, as its own edit request.
      const patch = { [edit.key]: edit.value, ...(edit.remove ? { class: undefined } : {}) };
      const gesture = propsGesture(nodeId, patch, { coalesceKey: undefined, urgency: true });
      // Migrating class to class:list must be one node rewrite, so a failed
      // second attribute write cannot leave duplicate class attributes.
      const request = edit.remove ? () => undefined : gesture.request;
      if (!commitEdit({ ...gesture, request })) {
        return { tag: 'refused', message: 'the edit could not be queued' };
      }
      previewAddedClass(previewPath, clean);
      try {
        await flushSave();
        return { tag: 'applied' };
      } catch (error: unknown) {
        return { tag: 'refused', message: cleanError(error) };
      }
    },
    [commitEdit, flushSave, showToast, pageStateRef],
  );
}

// Writing an asset pick into a prop.
export function useAssetProp(coreState: ReturnType<typeof useCoreState>, classEdits: ReturnType<typeof useClassEdits>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef, projectRef } = coreState;
  const { setProp } = classEdits;
  const { commitEdit } = history;

  // Writes an asset pick into a prop. The root decides the form:
  //
  //   public/  served as-is → a URL string, src="/hero.png"
  //   src/     built and optimised → an ESM import, src={hero}
  //
  // The src/ form is the one Astro wants for <Image>: it carries the file's
  // real dimensions, so nothing has to be typed in and MissingImageDimension
  // can't happen. A plain <img>, or a component prop typed as a string, gets
  // `hero.src` instead: it needs the URL out of the imported object, not the
  // object (assetReferenceFor in elementState.ts decides).
  const setAssetProp = useCallback(
    async (nodeId: string, propName: string, picked: PickedAsset & { readonly abs?: string }, reference: AssetReference) => {
      const { pageState: state, currentPage: page } = pageStateRef.current;
      if (!state?.editable || !page?.path || !picked?.rel) {
        return;
      }
      const withoutRoot = picked.rel.split('/').slice(1).join('/');
      if (picked.root !== 'src') {
        setProp(nodeId, propName, { type: 'string', value: '/' + withoutRoot }, true);
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      const abs = picked.abs || `${projectPath}/${picked.rel}`;
      const paths = await findImportPath(projectPath, page.path, abs);
      const latest = pageStateRef.current.pageState;
      if (!latest?.editable) {
        return;
      }
      const model = latest.model;
      const node = findNodeById(model.nodes, nodeId);
      if (!node) {
        return;
      }
      const spec = chooseImportPath(model, paths);
      // Reuse the binding if this file is already imported — importing the
      // same asset twice under two names is just noise.
      let local = (model.imports || []).find((i) => !i.named && i.path === spec)?.name;
      const added = local === undefined;
      if (!local) {
        const base =
          withoutRoot
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? 'asset';
        let candidate = base.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1') || 'asset';
        const taken = new Set((model.imports || []).map((i) => i.name));
        // Ends within taken.size + 1 passes: each tries a name not yet tried.
        let suffix = 2;
        while (taken.has(candidate)) {
          candidate = `${base}${suffix++}`;
        }
        local = candidate;
      }
      const binding = local;
      // Step 6, prop and frontmatter: the prop as a request, then the import
      // it needs and the one a replaced image leaves behind — one undo step.
      const value = { type: 'expr' as const, value: reference === 'url' ? `${binding}.src` : binding };
      const options = { coalesceKey: undefined, urgency: true };
      const prop = propsGesture(nodeId, { [propName]: value }, options);
      const imported = (current: EditorModel): EditorModel => {
        const entry = { name: binding, path: spec, quote: "'" };
        const imports = added ? [...current.imports, entry] : current.imports;
        // Picking a second image over a first leaves the first one's import
        // behind with nothing pointing at it.
        return withPrunedImports({ ...current, imports });
      };
      const afterProp = prop.apply(model);
      const changed = frontmatterOf(imported(afterProp)) !== frontmatterOf(afterProp);
      commitEdit(changed ? sequence(prop, frontmatterGesture(afterProp, options, imported)) : prop);
    },
    [commitEdit, setProp, pageStateRef, projectRef],
  );
  return { setAssetProp };
}

// Renaming an attribute.
export function useRenameProp(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Renames an attribute in place, preserving its value and position (step 9:
  // a rename-attribute request, the name's bytes alone).
  const renameProp = useCallback(
    (nodeId: string, oldName: string, newName: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const names = { from: oldName, to: newName };
      const gesture = attributeRenameGesture(state.model, nodeId, names);
      if (gesture) {
        commitEdit(gesture);
      }
    },
    [commitEdit, pageStateRef],
  );
  return { renameProp };
}

// Turning a tag into a component.
export function useNodeKind(coreState: ReturnType<typeof useCoreState>, nodeEdits: ReturnType<typeof useNodeEdits>, history: ReturnType<typeof useHistory>) {
  const { insertables, pageStateRef } = coreState;
  const { resolveImportPath } = nodeEdits;
  const { commitEdit } = history;

  // Switches a plain element's tag. Attributes that belonged to the old
  // tag's built-in schema but aren't valid for the new one are dropped
  // (loading="eager" on img → div); global, data-* and aria-* attributes
  // and anything custom stay.
  // Renaming a node's tag can change what kind of node it is. Astro decides
  // that by case: `<div>` is an element, `<AstroLogo>` is a component — and a
  // component is only real if something in the frontmatter provides it, so a
  // capitalised name is only accepted when it names a project component or an
  // existing import. Typing `div` over a component turns it back.
  const changeNodeKind = useCallback(
    async (nodeId: string, newTag: string) => {
      const name = String(newTag || '').trim();
      if (!/^[A-Z][\w$]*$/.test(name)) {
        return false;
      }
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return false;
      }
      const already = (state.model.imports || []).some((i) => i.name === name);
      const comp = insertables.find((component) => component.name === name);
      const asset = ASTRO_ASSETS.some((entry) => entry.name === name);
      if (!already && !comp && !asset) {
        return false;
      } // nothing provides it
      const paths = comp && !already ? await resolveImportPath(comp.path) : undefined;
      const current = pageStateRef.current.pageState;
      const model = current?.editable ? current.model : undefined;
      const node = model ? findNodeById(model.nodes, nodeId) : undefined;
      if (!model || !node) {
        return false;
      }
      if (node.name === name) {
        return true;
      }
      // Attributes that belonged to the old element's tag mean nothing to a
      // component; class, data- and aria- carry over the way they do for a
      // tag change.
      const oldNames = node.kind === 'element' ? new Set(getElementSchema(node.name).map((field) => field.name)) : undefined;
      const dropped = Object.keys(node.props || {}).filter((attr) => oldNames?.has(attr) && !GLOBAL_ATTRS.has(attr) && !/^(data-|aria-)/.test(attr));
      const imported = (pageModel: EditorModel): EditorModel => {
        if (pageModel.imports.some((i) => i.name === name)) {
          return withPrunedImports(pageModel);
        }
        const entry = paths
          ? { name, path: chooseImportPath(pageModel, paths), quote: "'" }
          : asset
            ? { name, imported: name, path: ASTRO_ASSETS_MODULE, quote: "'", named: true }
            : undefined;
        return withPrunedImports(entry ? { ...pageModel, imports: [...pageModel.imports, entry] } : pageModel);
      };
      const change = { kind: 'component' as const, name, asset, dropped };
      commitEdit(tagChangeGesture(model, node, change, imported));
      return true;
    },
    [insertables, commitEdit, resolveImportPath, pageStateRef],
  );
  return { changeNodeKind };
}

// Changing an element’s tag.
export function useElementTag(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  const changeElementTag = useCallback(
    (nodeId: string, newTag: string) => {
      const tag = String(newTag || '')
        .trim()
        .toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
        return;
      }
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const node = model ? findNodeById(model.nodes, nodeId) : undefined;
      if (!model || !node || node.name === tag) {
        return;
      }
      // A component becoming a plain tag keeps only what a tag understands:
      // its props were the component's API, and they'd be junk attributes on
      // a <div>.
      const wasComponent = node.kind !== 'element';
      const oldNames = wasComponent ? new Set(Object.keys(node.props || {})) : new Set(getElementSchema(node.name).map((field) => field.name));
      const newNames = new Set(getElementSchema(tag).map((field) => field.name));
      const dropped = Object.keys(node.props || {}).filter(
        (attr) => oldNames.has(attr) && !newNames.has(attr) && !GLOBAL_ATTRS.has(attr) && !/^(data-|aria-)/.test(attr),
      );
      const change = { kind: 'element' as const, name: tag, asset: false, dropped };
      commitEdit(tagChangeGesture(model, node, change, withPrunedImports));
    },
    [commitEdit, pageStateRef],
  );
  return { changeElementTag };
}

// A node’s text, and the frontmatter.
export function useNodeText(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit, scheduleSave } = history;

  // `renames` (loop editor only) carries the variable names this edit is
  // changing, so references below the node follow along. A rename touches
  // many nodes at once, so it saves immediately and gets its own history
  // entry instead of coalescing with the keystrokes around it.
  // `immediate` skips the typing coalesce for an edit that arrives already committed
  // (the style panel writing a <style> block): waiting 300 ms there just delays the
  // canvas, since the next keystroke it was batching with never comes.
  const setNodeText = useCallback(
    (nodeId: string, value: string, renames: readonly Rename[] | undefined = undefined, immediate: boolean | 'live' = false) => {
      const renaming = (renames || []).some((rename) => rename.from && rename.to && rename.from !== rename.to);
      const state = pageStateRef.current.pageState;
      if (renaming && state?.editable) {
        // Step 6, loop rename (multi-span): the parameters and every reference
        // below, as rename-binding requests, when the head changed nothing else.
        const pairs = (renames || []).flatMap((rename) => (rename.from && rename.to ? [{ from: rename.from, to: rename.to }] : []));
        const change = { head: value, renames: pairs };
        const gesture = loopRenameGesture(state.model, nodeId, change, { urgency: true });
        if (gesture) {
          commitEdit(gesture);
          return;
        }
      }
      // Step 9: everything else the field says is the node restated.
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (node !== undefined && !renaming && statedText(node) === value) {
        // Already what the node holds: the style panel committing the CSS its
        // live writes already put there, or a field left as it was. A request
        // that changes nothing is refused by the planner, and its notice would
        // report a failure after a success. A commit still saves at once.
        if (immediate === true) {
          scheduleSave(true);
        }
        return;
      }
      const next = node ? restatedText(node, value, renames) : undefined;
      if (!next) {
        return;
      }
      const coalesceKey = renaming ? undefined : `text:${nodeId}`;
      commitEdit(nodeGesture(nodeId, next, { coalesceKey, urgency: renaming || immediate }));
    },
    [commitEdit, pageStateRef, scheduleSave],
  );

  // The code editor and file writer share the same frontmatter model, so
  // editing code preserves named imports, interleaved statements and spacing.
  // Step 6, frontmatter: the block the code describes, as a request whose
  // slot is only what differs.
  const setFrontmatter = useCallback(
    (code: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      // Object.assign, as the legacy setFrontmatter did: the block's fields replace the model's.
      const written = (model: EditorModel): EditorModel => Object.assign({}, model, readFrontmatter(code));
      const options = { coalesceKey: 'frontmatter', urgency: false };
      commitEdit(frontmatterGesture(state.model, options, written));
    },
    [commitEdit, pageStateRef],
  );
  return { setFrontmatter, setNodeText };
}

// A condition’s else branch, and the frontmatter’s declarations.
export function useBranchEdits(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Adds or removes a condition's else branch. Removing keeps the markup that
  // was in it — it moves to the then branch rather than being deleted — so the
  // button can't quietly throw work away.
  // Step 9: the condition restated with its branches.
  const toggleElseBranch = useCallback(
    (nodeId: string, want: boolean) => {
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (!node || node.kind !== 'cond') {
        return;
      }
      const kids = node.children;
      const thenBranch: BranchNode = kids[0] ?? {
        id: newId(),
        kind: 'branch',
        name: 'then',
        children: [],
      };
      let next: EditorNode | undefined;
      if (want && kids.length < 2) {
        const elseBranch: BranchNode = { id: newId(), kind: 'branch', name: 'else', children: [] };
        next = { ...node, op: '?', children: [thenBranch, elseBranch] };
      } else if (!want && kids.length > 1) {
        const elseBranch = kids[1];
        assert(elseBranch !== undefined, 'Else branch exists before removal');
        const rescued = elseBranch.children || [];
        const merged = { ...thenBranch, children: [...(thenBranch.children || []), ...rescued] };
        next = { ...node, op: '&&', children: [merged] };
      }
      if (!next) {
        return;
      }
      commitEdit(nodeGesture(nodeId, next, { coalesceKey: undefined, urgency: true }));
    },
    [commitEdit, pageStateRef],
  );

  // Replaces the frontmatter's non-import code (its declarations), leaving the
  // import list alone. What the props panel edits when you open the source
  // behind a `{data}` prop — the imports aren't in play there, so they don't
  // need re-extracting.
  const setExtraFrontmatter = useCallback(
    (code: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const written = (model: EditorModel): EditorModel => ({ ...model, extraFrontmatter: code });
      const options = { coalesceKey: 'frontmatter', urgency: false };
      commitEdit(frontmatterGesture(state.model, options, written));
    },
    [commitEdit, pageStateRef],
  );

  return { setExtraFrontmatter, toggleElseBranch };
}

// A node’s text content and inline children.
export function useContentEdits(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Sets the text content of a component (single text child convenience).
  // Where each node's loose text last sat, so emptying the Content field and
  // typing again restores its place rather than appending.
  const textSlotRef = useRef<Record<string, number>>({});

  // Step 9: the text child restated, removed, or inserted where it last sat —
  // or, for a tag with no children yet (`<Card />`), the tag restated with it.
  const setNodeContent = useCallback(
    (nodeId: string, value: string) => {
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const node = model ? findNodeById(model.nodes, nodeId) : undefined;
      if (!model || !node || node.kind === 'text') {
        return;
      }
      const options = { coalesceKey: `content:${nodeId}`, urgency: false };
      const children = node.children ?? undefined;
      const at = children ? children.findIndex((child) => child.kind === 'text') : -1;
      const textNode = children?.[at];
      // Emptying the field takes the text node out rather than leaving an
      // empty one behind — but where it sat is remembered, so clearing the
      // field and typing again puts the words back among the children
      // instead of after all of them.
      if (textNode) {
        if (value) {
          commitEdit(nodeGesture(textNode.id, { ...textNode, value }, options));
        } else {
          textSlotRef.current[nodeId] = at;
          commitEdit(removalGesture([textNode.id], { urgency: false }));
        }
        return;
      }
      if (!value) {
        return;
      }
      const text: EditorNode = { id: newId(), kind: 'text', value };
      if (!children) {
        commitEdit(nodeGesture(nodeId, withChildren(node, [text]), options));
        return;
      }
      const back = textSlotRef.current[nodeId];
      const index = back !== undefined && Number.isInteger(back) && back <= children.length ? back : children.length;
      commitEdit(insertGesture(model, text, { parentId: nodeId, index }, { urgency: false }));
    },
    [commitEdit, pageStateRef],
  );

  // Replaces a node's inline children wholesale (rich Content field edits).
  // Nodes arrive from the editor without ids — assign fresh ones.
  const setNodeInline = useCallback(
    (nodeId: string, kids: readonly InlineNode[]) => {
      // Step 9: the node restated with its new inline children.
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (!node || node.kind === 'text') {
        return;
      }
      const next = withChildren(node, inlineWithIds(kids, 0));
      // Content was explicitly edited. The printer's layout-preservation comparison
      // ignores whitespace, so keeping the old inner source could restore a deleted
      // space on save and send a different value back to the focused field.
      Reflect.deleteProperty(next, 'source');
      commitEdit(nodeGesture(nodeId, next, { coalesceKey: `content:${nodeId}`, urgency: false }));
    },
    [commitEdit, pageStateRef],
  );
  return { setNodeContent, setNodeInline };
}
