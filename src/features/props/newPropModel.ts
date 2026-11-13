// What the binding picker offers in a component: which of the component's
// props fit the field it was opened on, what a new prop for that field is
// called and what it can be, and the name it starts with. Pure, so the rules
// are pinned by tests without a renderer.
//
// Fit follows what a value renders as. A text field (content, a class, an
// attribute value) shows words, and a number prints as words too, so both a
// text prop and a number prop fit it; a number field cannot show words, so a
// text prop does not fit there. A switch fits only an either/or, and an
// attributes prop (Astro's rest props) only an element's attribute list.
// A prop whose type Stacki cannot read is offered everywhere but an attribute
// list: hiding a prop that would have worked is worse than offering one that
// might not.
//
// An image field (an <img> or <video> src, an asset prop) takes an Image prop:
// one typed ImageMetadata fits only there, never a text field, and one typed
// as a URL string fits both, since a URL is words too. A list (a loop's
// source) takes a List prop: a prop whose type says it is a list of items.
// The picker's tree says a prop is a list from its declared shape; it cannot
// say a prop is an image, so the host names those (NewPropHost.imageProps).

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ReactNode } from 'react';
import type { Result } from '../../../shared/core/result';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { memberTypes, type NewPropKind, type PropDeclaration } from '../../editor/propDeclaration';
import { readPropsDestructure } from '../../editor/loopProps';
import { isMediaName } from '../../editor/fieldNames';
import { isImageType } from '../../editor/imagePropDefault';
import type { ItemFieldDeclaration } from '../../editor/itemFields';

/** The kind of field a picker was opened on. */
export type FieldFit = 'content' | 'text' | 'number' | 'boolean' | 'attributes' | 'image' | 'list';

/** How an image prop is typed: an imported file's ImageMetadata, or a URL string. */
export type ImagePropKind = 'asset' | 'url';

/** The component a picker binds in, and how to give it a new prop. Absent on a page. */
export interface NewPropHost {
  /** The component's file name, heading its props in the Connect list. */
  readonly componentName: string;
  /** The props the component already declares, by name. */
  readonly propKeys: readonly string[];
  /** The rest binding, when the component already passes its other attributes on. */
  readonly restLocal: string | undefined;
  /** Declares the prop and holds it for the field's binding, so both are one undo step; answers the path to bind. */
  readonly create: (declaration: PropDeclaration) => Result<string, string>;
  /** The component's image props, by the name the markup reads them by, and how each is typed. */
  readonly imageProps?: ReadonlyMap<string, ImagePropKind> | undefined;
  /** The project, for the Image form's asset picker. */
  readonly projectPath?: string | undefined;
  /** The component's folder in the project (`src/components`), which an imported image's path is relative to. */
  readonly fileDirectory?: string | undefined;
  /** How a picker opens an existing prop's settings. Absent, its rows offer none. */
  readonly propSettings?: PropSettingsOffer | undefined;
}

/**
 * Editing an existing prop from a picker row. The form is drawn by the host
 * rather than named here: it is the Properties panel's, and the props feature
 * may not import that one (eslint.config.mjs featureEdges). Only the app sees both.
 */
export interface PropSettingsOffer {
  /** The prop a row reads, by the row's path, or undefined for anything else. */
  readonly keyOf: (path: string) => string | undefined;
  /** The settings form for prop `key`, which calls `onClose` when it is done. */
  readonly render: (key: string, onClose: () => void) => ReactNode;
}

/** What a field's picker offers a new prop from: its kind, its label and its current literal value. */
export interface NewPropSeed {
  readonly fit: FieldFit;
  readonly label: string;
  readonly value: string;
  /** The tag of the element, for an attributes prop's typing. */
  readonly tag?: string | undefined;
  /**
   * What an image field takes from an imported image: its URL (`image.src`,
   * for an <img> or a prop typed string) or the ImageMetadata itself (for
   * astro:assets <Image>). The same rule as assetReferenceFor in elementState.ts.
   */
  readonly reference?: 'url' | 'module' | undefined;
  /** The fields a list field's items have, which a new List prop for it starts with. */
  readonly itemFields?: readonly ItemFieldDeclaration[] | undefined;
}

/** A row of the picker's data tree, as far as fitting reads it. */
export interface FitNode {
  readonly kind: string;
  readonly section?: string | undefined;
  readonly children?: readonly FitNode[] | undefined;
}

/** The kinds a new prop for each field can be, the first the one offered first. */
export const FIT_KINDS: Readonly<Record<FieldFit, readonly NewPropKind[]>> = {
  content: ['string'],
  text: ['string', 'option'],
  number: ['number'],
  boolean: ['boolean'],
  attributes: ['attributes'],
  image: ['image'],
  list: ['list'],
};

/** What each kind is called in the menu and the form (`New Text property`): the message key of its name. */
export const KIND_TITLE_KEYS: Readonly<Record<NewPropKind, MessageKey>> = {
  string: 'props.newProp.kind.string',
  number: 'props.newProp.kind.number',
  boolean: 'props.newProp.kind.boolean',
  option: 'props.newProp.kind.option',
  attributes: 'props.newProp.kind.attributes',
  list: 'props.newProp.kind.list',
  image: 'props.newProp.kind.image',
};

/** The word in a field's `New … property` row. */
export function newPropTitle(fit: FieldFit, translate: Translator = ENGLISH_TRANSLATE): string {
  switch (fit) {
    case 'content':
      return translate('props.newProp.title.content');
    case 'text':
      return translate('props.newProp.title.text');
    case 'number':
      return translate('props.newProp.title.number');
    case 'boolean':
      return translate('props.newProp.title.boolean');
    case 'attributes':
      return translate('props.newProp.title.attributes');
    case 'image':
      return translate('props.newProp.title.image');
    case 'list':
      return translate('props.newProp.title.list');
    default: {
      const exhaustive: never = fit;
      return exhaustive;
    }
  }
}

/** The tree kind an image prop is listed as: `image` for ImageMetadata, `image url` for a URL string. */
export const IMAGE_NODE_KINDS: Readonly<Record<ImagePropKind, string>> = { asset: 'image', url: 'image url' };

// What a data-tree kind is, as fitting reads it. The kinds come from two
// places: a schema type (`string`, `enum`, `number`) and a sampled value
// (`text`, `number`, `list`).
type PropShape = 'words' | 'number' | 'switch' | 'attributes' | 'image' | 'imageUrl' | 'list' | 'structure' | 'unknown';

function shapeOf(kind: string): PropShape {
  switch (kind) {
    case 'string':
    case 'text':
    case 'enum':
    case 'date':
      return 'words';
    case 'number':
      return 'number';
    case 'boolean':
      return 'switch';
    case 'rest props':
      return 'attributes';
    case 'image':
      return 'image';
    case 'image url':
      return 'imageUrl';
    case 'list':
      return 'list';
    case 'object':
    case 'code':
    case 'slot':
    case 'style':
    case 'attrs':
      return 'structure';
    default:
      return 'unknown';
  }
}

/** Whether a prop of data-tree kind `kind` can be bound to a field of `fit`. */
export function propFits(kind: string, fit: FieldFit): boolean {
  const shape = shapeOf(kind);
  switch (fit) {
    case 'content':
    case 'text':
      return shape === 'words' || shape === 'number' || shape === 'imageUrl' || shape === 'unknown';
    case 'number':
      return shape === 'number' || shape === 'unknown';
    case 'boolean':
      return shape === 'switch' || shape === 'unknown';
    case 'attributes':
      return shape === 'attributes';
    case 'image':
      return shape === 'image' || shape === 'imageUrl' || shape === 'unknown';
    case 'list':
      return shape === 'list' || shape === 'unknown';
    default: {
      const exhaustive: never = fit;
      return exhaustive;
    }
  }
}

/**
 * The picker's tree for a field in a component: the component's own props
 * narrowed to those that fit (a prop with fields beneath it stays, so a field
 * of it can be reached), every other source as it was. An attributes list
 * binds to the component's rest props and nothing else. The image props the
 * host names are listed as images first (IMAGE_NODE_KINDS), so they fit, and
 * show, as one.
 */
export function fittingTree<Node extends FitNode & { readonly path: string }>(
  tree: readonly Node[],
  fit: FieldFit,
  imageProps: ReadonlyMap<string, ImagePropKind> = new Map(),
): readonly Node[] {
  assert(tree.length <= LIMITS.treeNodesMax, 'fittingTree: node limit exceeded');
  const kinded = tree.map((node) => {
    const image = node.section === 'props' ? imageProps.get(node.path) : undefined;
    return image === undefined ? node : { ...node, kind: IMAGE_NODE_KINDS[image] };
  });
  const out = kinded.filter((node) => {
    if (node.section !== 'props') {
      return fit !== 'attributes';
    }
    if (propFits(node.kind, fit)) {
      return true;
    }
    return fit !== 'attributes' && (node.children?.length ?? 0) > 0;
  });
  assert(out.length <= tree.length, 'fittingTree: fitting only removes rows');
  return out;
}

/**
 * The component's props by the name its code reads each by, which is what a
 * picker row's path says: `const { features: items } = Astro.props` lists
 * `items`, and that row's prop is `features`. A prop declared but never
 * destructured reads by its own name. The rest binding is not a prop with
 * settings of its own: it holds the attributes the others leave.
 */
export function propKeysByLocal(
  entries: readonly { readonly key: string; readonly local: string }[],
  declared: readonly string[],
  restLocal: string | undefined,
): ReadonlyMap<string, string> {
  assert(entries.length + declared.length <= LIMITS.treeNodesMax, 'propKeysByLocal: the props are bounded');
  const out = new Map(entries.map((entry) => [entry.local, entry.key]));
  const aliased = new Set(entries.map((entry) => entry.key));
  for (const key of declared) {
    if (!aliased.has(key)) {
      out.set(key, key);
    }
  }
  if (restLocal !== undefined) {
    out.delete(restLocal);
  }
  assert(out.size <= entries.length + declared.length, 'propKeysByLocal: only known props are listed');
  return out;
}

/** Why `key` cannot name a new prop of this component, or undefined when it can. */
export function propNameProblem(key: string, host: Pick<NewPropHost, 'propKeys' | 'restLocal'>, translate: Translator = ENGLISH_TRANSLATE): string | undefined {
  if (key === '') {
    return translate('props.newProp.name.empty');
  }
  if (key.length > PROPERTY_LIMITS.nameCharsMax) {
    return translate('props.newProp.name.tooLong');
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
    return translate('props.newProp.name.invalid');
  }
  if (host.propKeys.includes(key) || host.restLocal === key) {
    return translate('props.newProp.name.taken', { name: key });
  }
  return undefined;
}

const NAME_SUFFIX_MAX = 100;

/**
 * The name a new prop starts with: the field's label in camelCase
 * (`Custom attributes` is `customAttributes`, `data-id` is `dataId`), with a
 * number after it when the component has that name already (`text2`).
 */
export function suggestedPropName(label: string, host: Pick<NewPropHost, 'propKeys' | 'restLocal'>): string {
  assert(label.length <= LIMITS.attrCharsMax, 'suggestedPropName: label is bounded');
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '');
  const joined = words.map((word, index) => (index === 0 ? word.toLowerCase() : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)).join('');
  const base = (joined === '' ? 'property' : /^\d/.test(joined) ? `prop${joined}` : joined).slice(0, PROPERTY_LIMITS.nameCharsMax - 4);
  for (let suffix = 1; suffix <= NAME_SUFFIX_MAX; suffix++) {
    const key = suffix === 1 ? base : `${base}${suffix}`;
    if (propNameProblem(key, host) === undefined) {
      return key;
    }
  }
  assert(false, 'suggestedPropName: a free name is found within the suffix bound');
  return base;
}

/** The name an attributes prop starts with: `rest`, as Astro's own examples call it. */
export function suggestedRestName(host: Pick<NewPropHost, 'propKeys' | 'restLocal'>): string {
  return suggestedPropName('rest', host);
}

/**
 * The fit of a settings field by its schema type, or undefined for a field a
 * new prop is not offered for (code, style, slot, an object). A field whose
 * name says it holds media (`src`, `poster`, `heroImage`) is an image field,
 * whether typed as a string (<img src>) or not at all (astro:assets <Image src>).
 */
export function fitOfFieldType(
  type: string,
  options: { readonly numeric?: boolean | undefined; readonly media?: boolean | undefined; readonly list?: boolean | undefined } = {},
): FieldFit | undefined {
  if (options.media === true && ['string', 'other', 'url', 'image', 'media'].includes(type)) {
    return 'image';
  }
  // A child component's list prop (`items={…}`): a List prop of the same items passes it on.
  if (options.list === true && type === 'code') {
    return 'list';
  }
  switch (type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return options.numeric === true ? 'number' : 'text';
    case 'string':
    case 'text':
    case 'link':
    case 'url':
    case 'image':
    case 'media':
      return 'text';
    default:
      return undefined;
  }
}

/** A field's value as the literal a new prop's default starts from: words, a number or a switch; '' for an expression. */
export function literalOf(value: { readonly type: string; readonly value?: string } | undefined): string {
  if (value === undefined || value.type === 'bare') {
    return '';
  }
  if (value.type === 'string') {
    return value.value ?? '';
  }
  const code = (value.value ?? '').trim();
  return /^(true|false|-?\d+(\.\d+)?)$/.test(code) ? code : '';
}

/**
 * The expression a field binds to a new prop: the prop itself, or its URL
 * (`image.src`) when the prop is an imported image and the field takes a URL
 * (an <img>'s src renders an ImageMetadata object as "[object Object]").
 */
export function boundPath(local: string, image: ImagePropKind | undefined, reference: NewPropSeed['reference']): string {
  assert(/^[A-Za-z_$][\w$]*$/.test(local), 'boundPath: a prop is read by an identifier');
  const out = image === 'asset' && reference === 'url' ? `${local}.src` : local;
  assert(out.startsWith(local), 'boundPath: the binding reads the prop');
  return out;
}

/** The name a new prop for a field starts from: an image field's `src` makes an `image` prop. */
export function seedName(seed: Pick<NewPropSeed, 'fit' | 'label'>): string {
  return seed.fit === 'image' && /^(src|data-src)$/i.test(seed.label) ? 'image' : seed.label;
}

const IMAGE_FILE = /\.(png|jpe?g|webp|avif|gif|svg)(\?.*)?$/i;

/**
 * The component's image props, by the name the markup reads each by: one
 * typed ImageMetadata is an imported image (`asset`); one typed `string` is a
 * URL image (`url`) when its name says media (`heroImage`) or its default is
 * an image file's address, as the Image form writes one.
 */
export function imagePropsOf(frontmatter: string): ReadonlyMap<string, ImagePropKind> {
  const types = memberTypes(frontmatter);
  const out = new Map<string, ImagePropKind>();
  for (const entry of readPropsDestructure(frontmatter)?.entries ?? []) {
    const type = types.get(entry.key);
    if (type === undefined) {
      continue;
    }
    if (isImageType(type)) {
      out.set(entry.local, 'asset');
      continue;
    }
    const fallback = entry.defaultValue === undefined ? '' : frontmatter.slice(entry.defaultValue.from, entry.defaultValue.to);
    if (type === 'string' && (isMediaName(entry.key) || IMAGE_FILE.test(fallback.replace(/^["'`]|["'`]$/g, '')))) {
      out.set(entry.local, 'url');
    }
  }
  assert(out.size <= types.size, 'imagePropsOf: only declared props are images');
  return out;
}
