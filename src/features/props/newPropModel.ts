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

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Result } from '../../../shared/core/result';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import type { NewPropKind, PropDeclaration } from '../../editor/propDeclaration';

/** The kind of field a picker was opened on. */
export type FieldFit = 'content' | 'text' | 'number' | 'boolean' | 'attributes';

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
}

/** What a field's picker offers a new prop from: its kind, its label and its current literal value. */
export interface NewPropSeed {
  readonly fit: FieldFit;
  readonly label: string;
  readonly value: string;
  /** The tag of the element, for an attributes prop's typing. */
  readonly tag?: string | undefined;
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
};

/** What each kind is called in the menu and the form: `New Text property`. */
export const KIND_TITLES: Readonly<Record<NewPropKind, string>> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Switch',
  option: 'Option',
  attributes: 'Attributes',
};

/** The word in a field's `New … property` row. */
export function newPropTitle(fit: FieldFit): string {
  switch (fit) {
    case 'content':
      return 'Text';
    case 'text':
      return 'Plain Text';
    case 'number':
      return 'Number';
    case 'boolean':
      return 'Switch';
    case 'attributes':
      return 'Attributes';
    default: {
      const exhaustive: never = fit;
      return exhaustive;
    }
  }
}

// What a data-tree kind is, as fitting reads it. The kinds come from two
// places: a schema type (`string`, `enum`, `number`) and a sampled value
// (`text`, `number`, `list`).
type PropShape = 'words' | 'number' | 'switch' | 'attributes' | 'structure' | 'unknown';

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
    case 'list':
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
      return shape === 'words' || shape === 'number' || shape === 'unknown';
    case 'number':
      return shape === 'number' || shape === 'unknown';
    case 'boolean':
      return shape === 'switch' || shape === 'unknown';
    case 'attributes':
      return shape === 'attributes';
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
 * binds to the component's rest props and nothing else.
 */
export function fittingTree<Node extends FitNode>(tree: readonly Node[], fit: FieldFit): readonly Node[] {
  assert(tree.length <= LIMITS.treeNodesMax, 'fittingTree: node limit exceeded');
  const out = tree.filter((node) => {
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

/** Why `key` cannot name a new prop of this component, or undefined when it can. */
export function propNameProblem(key: string, host: Pick<NewPropHost, 'propKeys' | 'restLocal'>): string | undefined {
  if (key === '') {
    return 'Give the property a name.';
  }
  if (key.length > PROPERTY_LIMITS.nameCharsMax) {
    return 'That name is too long.';
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
    return 'Use letters and numbers, starting with a letter.';
  }
  if (host.propKeys.includes(key) || host.restLocal === key) {
    return `This component already has a ${key} property.`;
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
 * new prop is not offered for (code, style, slot, an object).
 */
export function fitOfFieldType(type: string, options: { readonly numeric?: boolean | undefined } = {}): FieldFit | undefined {
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
