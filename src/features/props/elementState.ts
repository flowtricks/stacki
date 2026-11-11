// An element's settings as the panel holds them: its fields laid out by
// schema, its assets, its rules, which group is open and focused, its settings
// and the dimensions action (PropsPanel.tsx).

import type { Attr, ValueNode } from '../../../shared/page/pageNode';
import type { FieldDefinition, PropValues } from './propRules';
import type { SetProp } from './propAttributes';
import type { FieldPickerAt } from './propBindings';
import type { RichInsertAPI } from './RichContent';
import type { AssetDimensions } from '../../ui/AssetThumb';
import type { AltPick, AssetReference, PickedAsset } from '../../ui/AssetField';
import { createPropRules } from './propRules';
import { visibleAttributeNames } from '../../../shared/core/internalAttributes';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import React, { useEffect, useRef, useState } from 'react';
import { VOID_TAGS } from '../../editor/elementSchemas';
import { isInlineOnly } from './RichContent';
import { type ElementPropsPanelProps } from './propsPanelTypes';
import { sourceKind, useSourceDimensions } from './SourcePanels';
import { useLayoutMetadata } from './useLayoutMetadata';
import { useLayoutText } from './useLayoutText';

// Whether the Settings group is open: open by default, remembered across selections,
// projects and restarts. It is a per-viewer convenience, so it lives in localStorage,
// and storage that is denied or holds anything else falls back to open.
const SETTINGS_GROUP_OPEN_KEY = 'stacki.props.settingsOpen';
export let settingsGroupOpen = readSettingsGroupOpen();

function readSettingsGroupOpen(): boolean {
  try {
    return localStorage.getItem(SETTINGS_GROUP_OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function storeSettingsGroupOpen(state: { readonly open: boolean }): void {
  try {
    localStorage.setItem(SETTINGS_GROUP_OPEN_KEY, state.open ? 'open' : 'closed');
  } catch {
    // Losing an optional preference must not interrupt editing.
  }
}

// Element hooks have a stable lifetime across ordinary selections. Other node
// kinds mount their own editors, so selecting text cannot change this hook order.
export function useElementProps(props: ElementPropsPanelProps) {
  const schema = props.schema ?? [];
  const layouts = props.layouts ?? [];
  assert(schema.length <= LIMITS.propSchemaFieldsMax, 'PropsPanel: schema limit exceeded');
  assert(Object.keys(props.node.props ?? {}).length <= LIMITS.attrsPerNodeMax, 'PropsPanel: attribute limit exceeded');
  assert(layouts.length <= LIMITS.scanEntriesMax, 'PropsPanel: layout limit exceeded');
  const layout = elementFieldLayout(props);
  const assets = useElementAssets(props);
  const rules = elementRules(props);
  const focus = useElementFocus(props);
  const settings = elementSettings(props, layout, rules.appliesNow);
  const dimensions = elementDimensionAction(props);
  const layoutMetadata = useLayoutMetadata(props);
  const layoutText = useLayoutText(props);
  const assetContext = {
    projectPath: props.projectPath,
    filePath: props.filePath,
    nodeName: props.node.name,
    layoutImage: layoutMetadata?.image,
    layoutType: layoutMetadata?.type,
    layoutText,
    onPickDimensions: dimensions.onPickDimensions,
    srcDims: assets.sourceDimensions,
    onSrcDimensions: assets.setSourceDimensions,
    siblingProps: props.node.props,
    srcKind: assets.sourceKind,
    nodeId: props.node.id,
    onPickWithAlt: altPickWriter(props, schema),
    onPickAsset: props.onSetAssetProp
      ? (name: string, picked: PickedAsset) => props.onSetAssetProp?.(props.node.id, name, picked, assetReferenceFor(props.node.kind, schema, name))
      : undefined,
  };
  return {
    ...props,
    schema,
    layouts,
    ...layout,
    ...assets,
    ...rules,
    ...focus,
    ...settings,
    ...dimensions,
    assetContext,
  };
}
export type ElementState = ReturnType<typeof useElementProps>;

// A plain <img> needs the URL out of an imported asset, and so does a
// component prop declared as a string: handed the ImageMetadata object, its
// <img src> renders "[object Object]" and the image never loads. Any other
// component prop may want the object itself, as astro:assets <Image> does.
export function assetReferenceFor(kind: ElementPropsPanelProps['node']['kind'], schema: readonly FieldDefinition[], name: string): AssetReference {
  if (kind === 'element') {
    return 'url';
  }
  const field = schema.find((candidate) => candidate.name === name);
  if (field === undefined) {
    return 'module';
  }
  return field.type === 'string' ? 'url' : 'module';
}

export function elementFieldLayout(props: ElementPropsPanelProps) {
  const { node, schema = [], slotOptions, takesSlotText, allowAttrs } = props;
  assert((node.children?.length ?? 0) <= LIMITS.treeNodesMax, 'PropsPanel: child limit exceeded');
  const schemaNames = new Set(schema.map((entry) => entry.name));
  // Fragment is Astro's transparent markup wrapper, not a user component with
  // a closed prop schema. Directives such as `set:html` are its attributes.
  const allowsFreeformAttrs = allowAttrs || node.name === 'Fragment';

  // The slot field renders in one stable spot whether or not the attribute
  // is currently set — hover-previewing a value must not remount the field
  // (that would close the dropdown mid-hover).
  const showSlotField = Array.isArray(slotOptions) && slotOptions.some((slot) => slot !== 'default') && !schemaNames.has('slot');
  // Stacki's own attributes (an app's durable `data-stacki-key`) stay in the
  // props but are never a field or an attribute row (internalAttributes.ts).
  let extraProps = visibleAttributeNames(Object.keys(node.props || {})).filter((key) => !schemaNames.has(key) && !(showSlotField && key === 'slot'));
  // With a free-form Attributes section, unknown attrs live there instead of
  // as individual fields — except class and style, which keep dedicated ones.
  let attrNames: string[] = [];
  if (allowsFreeformAttrs) {
    attrNames = extraProps.filter((key) => key !== 'class' && key !== 'style' && key !== 'slot');
    // `slot` is sorted last so a hand-written one lands where the picker's
    // does — directly above the comment — instead of in among the props.
    extraProps = extraProps.filter((key) => key === 'class' || key === 'slot').sort((left, right) => (left === 'slot' ? 1 : right === 'slot' ? -1 : 0));
  }

  // Content field: shown when the children are inline-only (text plus simple
  // tags like <strong>/<em>), edited with the rich inline editor. An element
  // that's still empty — a just-inserted <h1> or <p> — has no inline children
  // to detect, so offer the editor there too; otherwise there'd be no way to
  // type its first words. Void tags can't hold content at all.
  // A component with a default <slot/> holds content exactly the way an
  // element does. Without this an empty one — everything the insert palette
  // adds, since a fresh instance is self-closing — has no Content field, and
  // so no way to be given its first words.
  const isEmpty = node.children === undefined || node.children.length === 0;
  const canHoldText = (node.kind === 'element' && !VOID_TAGS.has(String(node.name).toLowerCase())) || !!takesSlotText;
  const showContentField = isInlineOnly(node.children) || (isEmpty && canHoldText);
  // HTML lets a node hold text *and* elements — `<div>Intro<Button/></div>` is
  // ordinary markup — but the rich editor above only covers all-inline
  // children. Rather than leave the text unreachable from the node that owns
  // it, mixed children get a plain field over the loose text alone; the
  // element children it sits among are left exactly where they are.
  const looseText = !isEmpty && (node.children || []).find((child): child is ValueNode => child.kind === 'text');
  const showLooseTextField = !showContentField && canHoldText && !isEmpty;
  // <slot> does take children, but they're the fallback Astro renders only
  // when the caller passes nothing — labelling it "Content" reads as if it
  // were what shows on the page.
  const isSlot = node.kind === 'element' && node.name === 'slot';

  // Where a prop's {expression} can be pointing, and how to write that source
  // back — lets an expression field edit the declaration behind it.

  return {
    allowAttrs: allowsFreeformAttrs,
    showSlotField,
    extraProps,
    attrNames,
    showContentField,
    showLooseTextField,
    looseText,
    isSlot,
  };
}

export function useElementAssets(props: ElementPropsPanelProps) {
  const { node, projectPath, filePath, dataContext } = props;
  // Astro's <Image> (and any component that forwards to it) rejects a public/
  // path with no width and height — "MissingImageDimension" takes the page
  // down. The picker already knows the size it just showed, so an image pick
  // fills those in when the component has them. One edit, one undo.
  // The size of the image currently in `src`. width/height fall back to it
  // when unset, so it is what those fields should show as their placeholder.
  const [sourceDimensions, setSourceDimensions] = useState<AssetDimensions | undefined>(undefined);
  useEffect(() => setSourceDimensions(undefined), [node?.id]);

  // …and read them from the file as well. The card above reports what its
  // thumbnail decoded, which only happens if a thumbnail rendered — so a
  // source the picker couldn't preview (or a field the eye never reached)
  // left width/height claiming the size was "inferred". Astro infers nothing
  // for a local asset: it reads the real size out of the file, and so do we.
  const source = node.props?.['src'];
  const kind = sourceKind(source, dataContext.imports);
  useSourceDimensions({
    source,
    projectPath,
    filePath,
    imports: dataContext.imports,
    setSourceDimensions,
  });

  return { sourceDimensions, setSourceDimensions, sourceKind: kind };
}

export function elementRules(props: ElementPropsPanelProps) {
  const { node, schema = [], onSetProp, onSetProps, stashRef } = props;
  // Changing the discriminant changes which props exist. The ones that no
  // longer apply are removed, not just hidden — leaving them in the markup
  // means the file carries props the component will ignore, and they would
  // reappear the moment the discriminant went back. Same edit, so it is one
  // undo, and the value is recoverable that way.
  // Values a discriminant switch took away, per node, kept only while the
  // panel is up: flicking variant → full-width → constrained should hand
  // `sizes` back, but reopening the project shouldn't resurrect it.
  const { appliesNow, branchDefault, narrowOptions, cascade } = createPropRules(schema, node.props || {});
  const setPropCascading: SetProp = (fieldName, value, immediate) => {
    const held = stashRef.current.get(node.id);
    if (!held) {
      assert(stashRef.current.size < LIMITS.treeNodesMax, 'PropsPanel: stash node limit exceeded');
    }
    const { patch, stash } = cascade({ fieldName, value, stash: held || {} });
    stashRef.current.set(node.id, stash);
    if (Object.keys(patch).length === 1 || !onSetProps) {
      onSetProp(fieldName, value, immediate);
      return;
    }
    onSetProps(node.id, patch);
  };
  return { appliesNow, branchDefault, narrowOptions, setPropCascading };
}
export function useElementFocus(props: ElementPropsPanelProps) {
  const { focusClass, focusContent } = props;
  // The data picker over the Content field, and the way into the editor's
  // caret once something is chosen.
  const [contentPicker, setContentPicker] = useState<FieldPickerAt | undefined>(undefined);
  // A ref prop: RichContent fills it with its caret API while it is mounted.
  const contentInsertRef = useRef<RichInsertAPI | undefined>(undefined);

  // Settings survives ordinary selections through hook state and special-node
  // selections through this module's value, because those unmount the element panel.
  const [settingsOpen, setSettingsOpenState] = useState(settingsGroupOpen);
  const setSettingsOpen = (next: React.SetStateAction<boolean>) => {
    settingsGroupOpen = typeof next === 'function' ? next(settingsGroupOpen) : next;
    storeSettingsGroupOpen({ open: settingsGroupOpen });
    setSettingsOpenState(settingsGroupOpen);
  };

  // ⌘Enter, forwarded from App as a counter: open Settings and put the caret
  // in the class field. Two steps, because the field doesn't exist to focus
  // until the render that opens the group has happened.
  const [wantClassFocus, setWantClassFocus] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusClass) {
      return;
    }
    setSettingsOpen(true);
    setWantClassFocus(true);
  }, [focusClass]);
  useEffect(() => {
    if (!wantClassFocus || !settingsOpen) {
      return;
    }
    setWantClassFocus(false);
    const input = rootRef.current?.querySelector<HTMLElement>('.class-input-field');
    if (!input) {
      return;
    }
    input.focus();
    input.closest('.props-field')?.scrollIntoView({ block: 'nearest' });
  }, [wantClassFocus, settingsOpen]);

  // Double-clicking text on the canvas, forwarded the same way: caret in the
  // Content field, at the end of what's already written. No group to open
  // first — Content sits at the top of the panel — but still an effect, so
  // the field belongs to the node that was double-clicked and not the one
  // that was selected a render ago.
  useEffect(() => {
    if (!focusContent) {
      return;
    }
    const field = rootRef.current?.querySelector<HTMLElement>('.rich-content');
    if (!field) {
      return;
    }
    field.focus();
    // Land after the last character rather than at the top: the gesture means
    // "let me write here", and a caret parked before the first word makes
    // typing insert in front of the sentence.
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    field.closest('.props-field')?.scrollIntoView({ block: 'nearest' });
  }, [focusContent]);

  return {
    contentPicker,
    setContentPicker,
    contentInsertRef,
    settingsOpen,
    setSettingsOpen,
    rootRef,
  };
}

export function elementSettings(
  props: ElementPropsPanelProps,
  layout: ReturnType<typeof elementFieldLayout>,
  appliesNow: ReturnType<typeof createPropRules>['appliesNow'],
) {
  const { node, isLayout, layouts = [], onChangeLayout, schema = [], allowAttrs, comment, onSetComment, onChangeTag } = props;
  const { isSlot, showSlotField, attrNames } = layout;
  const classField: FieldDefinition | undefined =
    schema.find((field) => field.name === 'class' && appliesNow(field)) ||
    (node.props?.['class'] !== undefined ? { name: 'class', type: 'string' } : undefined);
  // Inline styles, directly under the class field. Anything that renders a
  // real element has one, whatever it declares; a component only when it
  // takes the attribute (…rest) or already carries it, so the panel never
  // offers a prop the component would ignore. Always the CSS editor, even
  // when a component types it `style?: string`.
  const styleField: FieldDefinition | undefined =
    allowAttrs || node.props?.['style'] !== undefined ? { ...(schema.find((field) => field.name === 'style') || {}), name: 'style', type: 'style' } : undefined;
  // The page's wrapper switches through the same Tag field as everything else
  // — it just answers with a layout rather than a tag, so its list is the
  // project's layouts and the change goes through the import rewrite.
  const layoutTag = isLayout && !!onChangeLayout && layouts.length > 0;
  const changeToLayout = (name: string) => {
    // The wrapper is an import, not markup: a name no layout file provides
    // can't be written, so the field puts the old one back.
    if (!layouts.some((layout) => layout.name === name)) {
      return false;
    }
    onChangeLayout?.(name);
    return true;
  };
  // Anything with a real tag or component name — not a loop, a condition, a
  // comment or a slot (switching a slot away would be a one-way door).
  const showTagField = !isSlot && (layoutTag || (!!onChangeTag && !isLayout && (node.kind === 'element' || node.kind === 'component')));
  const hasSettings =
    showTagField || !!classField || !!styleField || allowAttrs || showSlotField || !!(onSetComment && (node.kind === 'element' || node.kind === 'component'));
  // How many of them actually carry something, shown on the closed header.
  const settingsCount =
    (node.props?.['class'] !== undefined ? 1 : 0) +
    (node.props?.['style'] !== undefined ? 1 : 0) +
    attrNames.length +
    (comment ? 1 : 0) +
    (node.props?.['slot'] !== undefined ? 1 : 0);
  return {
    classField,
    styleField,
    layoutTag,
    changeToLayout,
    showTagField,
    hasSettings,
    settingsCount,
  };
}
// An app's image pick may carry alt text: written to an <img>, or a component that declares `alt`.
// An app's pick with alt text: the field and the alt in one write, so one undo step. A
// value goes in as both props at once; a project file goes through the asset write, which
// adds the alt to the same edit as the prop and its import.
export function altPickWriter(
  props: ElementPropsPanelProps,
  schema: readonly FieldDefinition[],
): ((name: string, pick: AltPick, alt: string) => void) | undefined {
  const { node, onSetProps, onSetAssetProp } = props;
  if (onSetProps === undefined) {
    return undefined;
  }
  if (node.name !== 'img') {
    if (!schema.some((field) => field.name === 'alt')) {
      return undefined;
    }
  }
  return (name, pick, alt) => {
    assert(name !== 'alt', 'The alt is written beside the picked field, not as it');
    const altProps: PropValues = { alt: { type: 'string', value: alt } };
    switch (pick.kind) {
      case 'value':
        onSetProps(node.id, { [name]: { type: 'string', value: pick.value }, ...altProps });
        return;
      case 'entry':
        // A field offers a project file to its host only through onPickAsset, which this writes.
        assert(onSetAssetProp !== undefined, 'A picked project file has an asset write');
        onSetAssetProp(node.id, name, pick.entry, assetReferenceFor(node.kind, schema, name), altProps);
        return;
      default: {
        const exhaustive: never = pick;
        return exhaustive;
      }
    }
  };
}

export function elementDimensionAction(props: ElementPropsPanelProps) {
  const { node, schema = [], onSetProps } = props;
  const onPickDimensions = (fieldName: string, dims: AssetDimensions) => {
    if (!onSetProps || !node || !dims?.w || !dims?.h) {
      return;
    }
    if (!/^(src|poster)$/i.test(fieldName)) {
      return;
    }
    const takes = (propName: string) => (schema || []).some((field) => field.name === propName);
    const patch: Record<string, Attr> = {};
    if (takes('width')) {
      patch['width'] = { type: 'expr', value: String(dims.w) };
    }
    if (takes('height')) {
      patch['height'] = { type: 'expr', value: String(dims.h) };
    }
    if (Object.keys(patch).length) {
      onSetProps(node.id, patch);
    }
  };

  return { onPickDimensions };
}
