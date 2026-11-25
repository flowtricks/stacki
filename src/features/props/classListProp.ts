// "New Class list property": a component prop for the classes an instance
// passes (`<Card class="featured">`), and the element rewritten to add them to
// its own. The prop is declared as Lumos and Astro's own examples declare it,
// `class?: string` read as `class: className` (`class` is a reserved word, so
// a destructure binds it by an alias), and the element's classes move into
// `class:list` with the prop last, so the instance's classes come after the
// element's:
//
//   <div class="card hero">        → <div class:list={["card", "hero", className]}>
//   <div class={tone}>             → <div class:list={[tone, className]}>
//   <div class:list={["card", x]}> → <div class:list={["card", x, className]}>
//
// `class:list` flattens arrays and objects and drops falsy values, so a value
// wrapped in an array gives the same classes it gave alone. Every other
// attribute keeps its place and its bytes; `class:list` takes the place of
// `class`.
//
// Some shapes cannot be rewritten without guessing what the page means, and
// those are refused with the reason, never rewritten: a component tag (it may
// read `class` its own way), a spread other than the component's own rest
// props (it may pass a `class` of its own, which would then meet a
// `class:list`), a component that already declares `class`, and a value that
// does not read as one expression. The component's own rest props are safe:
// declaring `class` takes it out of them.
//
// Pure, so every shape is pinned by tests without a renderer.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { err, ok, type Result } from '../../../shared/core/result';
import type { Attr } from '../../../shared/page/pageNode';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';
import type { NewPropHost, NewPropSeed } from './newPropModel';

/** The attribute a class list prop rewrites, and the prop it declares. */
export const CLASS_ATTRIBUTE = 'class';
export const CLASS_LIST_ATTRIBUTE = 'class:list';
/** The name the markup reads the prop by, as Lumos components read it. */
export const CLASS_LIST_LOCAL = 'className';

/** Why an element's classes cannot take a class list prop. */
export type ClassListRefusal = 'component' | 'spread' | 'taken' | 'shape';

/** The message each refusal is said with. */
export const CLASS_LIST_REFUSAL_KEYS: Readonly<Record<ClassListRefusal, MessageKey>> = {
  component: 'props.classListProp.refusal.component',
  spread: 'props.classListProp.refusal.spread',
  taken: 'props.classListProp.refusal.taken',
  shape: 'props.classListProp.refusal.shape',
};

/** The element a class list prop is made for, as far as the rewrite reads it. */
export interface ClassListElement {
  readonly kind: string;
  readonly name: string;
  readonly props?: Readonly<Record<string, Attr | undefined>> | undefined;
}

/**
 * The picker's "New Class list property" row: whether it can be made here
 * (`refusal` says why not), and what to do with the prop once it is declared.
 */
export interface ClassListOffer {
  readonly refusal: ClassListRefusal | undefined;
  /** Rewrites the element to read the prop `local`, as the edit the declaration is held for. */
  readonly onCreated: (local: string) => void;
}

/** What the form for a class list prop starts from: named `class`, with no default. */
export const CLASS_LIST_SEED: NewPropSeed = { fit: 'classList', label: CLASS_ATTRIBUTE, value: '' };

const HTML_TAG = /^[a-z][a-z0-9-]*$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ts = parser.configure({ dialect: 'ts' });

/** The name a class list prop's markup reads it by: `className` for `class`, the prop itself for any other name. */
export function classListLocal(seed: Pick<NewPropSeed, 'fit'>, key: string): string | undefined {
  if (seed.fit !== 'classList') {
    return undefined;
  }
  return key === CLASS_ATTRIBUTE ? CLASS_LIST_LOCAL : undefined;
}

/** Why `element` cannot take a class list prop in this component, or undefined when it can. */
export function classListRefusal(element: ClassListElement, host: Pick<NewPropHost, 'propKeys' | 'restLocal'>): ClassListRefusal | undefined {
  if (element.kind !== 'element') {
    return 'component';
  }
  if (!HTML_TAG.test(element.name)) {
    return 'component';
  }
  if (host.propKeys.includes(CLASS_ATTRIBUTE)) {
    return 'taken';
  }
  const rewritten = withClassListProp(element.props ?? {}, CLASS_LIST_LOCAL, host.restLocal);
  return rewritten.ok ? undefined : rewritten.error;
}

/**
 * The class list row for `element` in a component, or undefined where there
 * is no component to give a prop to or no way to write the element whole.
 * Once the prop is declared, the element is written as withClassListProp
 * gives it, by `replace`: that is the edit the declaration is held for, so
 * the two are one undo step.
 */
export function classListOfferOf(
  element: ClassListElement,
  host: Pick<NewPropHost, 'propKeys' | 'restLocal'> | undefined,
  replace: ((props: Readonly<Record<string, Attr>>) => void) | undefined,
): ClassListOffer | undefined {
  if (host === undefined || replace === undefined) {
    return undefined;
  }
  const refusal = classListRefusal(element, host);
  const onCreated = (local: string): void => {
    assert(refusal === undefined, 'classListOfferOf: a refused row makes no prop');
    const rewritten = withClassListProp(element.props ?? {}, local, host.restLocal);
    // The row is drawn disabled for every shape the rewrite refuses, and a local is an identifier.
    assert(rewritten.ok, 'classListOfferOf: a prop is made only for an element the rewrite takes');
    replace(rewritten.value);
  };
  return { refusal, onCreated };
}

/**
 * The element's attributes, in order, with its classes moved into
 * `class:list` and `local` added last: in place of `class`, or appended to
 * the `class:list` it already has (a `class` beside it then stays as it was,
 * since Astro gives both). Only spreads of `restLocal` are allowed.
 */
export function withClassListProp(
  props: Readonly<Record<string, Attr | undefined>>,
  local: string,
  restLocal: string | undefined,
): Result<Readonly<Record<string, Attr>>, ClassListRefusal> {
  assert(IDENTIFIER.test(local), 'withClassListProp: the prop is read by an identifier');
  const entries = Object.entries(props);
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'withClassListProp: attribute limit exceeded');
  for (const [, value] of entries) {
    if (value?.type === 'spread' && value.value !== restLocal) {
      return err('spread');
    }
  }
  const list = props[CLASS_LIST_ATTRIBUTE];
  const target = list === undefined ? CLASS_ATTRIBUTE : CLASS_LIST_ATTRIBUTE;
  const value = list === undefined ? classListOfClass(props[CLASS_ATTRIBUTE], local) : classListAppended(list, local);
  if (value === undefined) {
    return err('shape');
  }
  const out: Record<string, Attr> = {};
  let placed = false;
  for (const [name, attribute] of entries) {
    if (attribute === undefined) {
      continue;
    }
    if (name === target) {
      define(out, CLASS_LIST_ATTRIBUTE, value);
      placed = true;
    } else {
      define(out, name, attribute);
    }
  }
  if (!placed) {
    define(out, CLASS_LIST_ATTRIBUTE, value);
  }
  assert(out[CLASS_LIST_ATTRIBUTE]?.type === 'expr', 'withClassListProp: the element has a class list');
  assert(list !== undefined || !Object.hasOwn(out, CLASS_ATTRIBUTE), 'withClassListProp: a class moved into the list is gone');
  return ok(out);
}

/**
 * The `class:list` with `path` added last, for a value picked from the data
 * list: `["card"]` → `["card", path]`. Undefined when the list does not read
 * as one expression.
 */
export function classListAppended(list: Attr, path: string): Attr | undefined {
  assert(path.trim() !== '', 'classListAppended: something is added');
  switch (list.type) {
    case 'expr':
      return expressionAppended(list.value, path);
    case 'string':
      return classListOfClass(list, path);
    case 'bare':
      return { type: 'expr', value: `[${path}]` };
    case 'spread':
      return undefined;
    default: {
      const exhaustive: never = list;
      return exhaustive;
    }
  }
}

// A `class` value as the start of a class list: its words, quoted, or its
// expression as the list's first entry.
function classListOfClass(value: Attr | undefined, local: string): Attr | undefined {
  if (value === undefined || value.type === 'bare') {
    return { type: 'expr', value: `[${local}]` };
  }
  switch (value.type) {
    case 'string': {
      const words = value.value.split(/\s+/).filter((word) => word !== '');
      return { type: 'expr', value: `[${[...words.map((word) => JSON.stringify(word)), local].join(', ')}]` };
    }
    case 'expr': {
      const entry = singleExpression(value.value);
      return entry === undefined ? undefined : { type: 'expr', value: `[${entry}, ${local}]` };
    }
    case 'spread':
      return undefined;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

// An array literal with `local` after its last entry, its layout kept: one
// line stays one line, and one entry per line gets a line of its own at the
// last entry's indent. Any other expression becomes the list's first entry.
function expressionAppended(code: string, local: string): Attr | undefined {
  const array = arrayLiteral(code);
  if (array === undefined) {
    const entry = singleExpression(code);
    return entry === undefined ? undefined : { type: 'expr', value: `[${entry}, ${local}]` };
  }
  const last = array.lastEntryEnd;
  if (last === undefined) {
    const out = `${code.slice(0, array.open + 1)}${local}${code.slice(array.close)}`;
    return { type: 'expr', value: out };
  }
  const lineStart = code.lastIndexOf('\n', last - 1) + 1;
  const indent = /^[ \t]*/.exec(code.slice(lineStart))?.[0] ?? '';
  const multiline = code.slice(array.open, array.close).includes('\n');
  const separator = multiline ? `,\n${indent}` : ', ';
  const out = `${code.slice(0, last)}${separator}${local}${code.slice(last)}`;
  assert(out.length > code.length, 'expressionAppended: the prop is added');
  return { type: 'expr', value: out };
}

interface ArrayLiteral {
  readonly open: number;
  readonly close: number;
  /** Where the last entry ends, or undefined for an empty array. */
  readonly lastEntryEnd: number | undefined;
}

const PUNCTUATION = new Set(['[', ']', ',', 'LineComment', 'BlockComment']);

// `code` as an array literal and nothing else, by its offsets in `code`.
function arrayLiteral(code: string): ArrayLiteral | undefined {
  const expression = parsedExpression(code);
  if (expression === undefined || expression.node.name !== 'ArrayExpression') {
    return undefined;
  }
  const { node, offset } = expression;
  if (node.from - offset !== leadingSpace(code) || node.to - offset !== code.trimEnd().length) {
    return undefined;
  }
  let lastEntryEnd: number | undefined;
  let child = node.firstChild ?? undefined;
  for (let count = 0; child !== undefined; count++) {
    assert(count <= LIMITS.attrCharsMax, 'arrayLiteral: an array has fewer entries than characters');
    if (!PUNCTUATION.has(child.name)) {
      lastEntryEnd = child.to - offset;
    }
    child = child.nextSibling ?? undefined;
  }
  const out = { open: node.from - offset, close: node.to - offset - 1, lastEntryEnd };
  assert(code.charAt(out.open) === '[', 'arrayLiteral: the array opens with a bracket');
  assert(code.charAt(out.close) === ']', 'arrayLiteral: the array closes with a bracket');
  return out;
}

// `code` trimmed, when it reads as one expression (not a sequence `a, b`, which an array would split in two).
function singleExpression(code: string): string | undefined {
  const expression = parsedExpression(code);
  if (expression === undefined || expression.node.name === 'SequenceExpression') {
    return undefined;
  }
  return code.trim();
}

// The one expression `code` is, parsed in parentheses so an object literal reads as one.
function parsedExpression(code: string): { readonly node: SyntaxNode; readonly offset: number } | undefined {
  if (code.trim() === '' || code.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const source = `(${code});`;
  const tree = ts.parse(source);
  let broken = false;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError) {
        broken = true;
      }
      return !broken;
    },
  });
  const statement = tree.topNode.firstChild ?? undefined;
  if (broken || statement === undefined || statement.name !== 'ExpressionStatement' || statement.nextSibling !== null) {
    return undefined;
  }
  const parenthesized = statement.firstChild ?? undefined;
  if (parenthesized === undefined || parenthesized.name !== 'ParenthesizedExpression' || parenthesized.to !== source.length - 1) {
    return undefined;
  }
  const inner = parenthesized.firstChild?.nextSibling ?? undefined;
  if (inner === undefined || inner.nextSibling?.name !== ')') {
    return undefined;
  }
  return { node: inner, offset: 1 };
}

function leadingSpace(code: string): number {
  return code.length - code.trimStart().length;
}

// `__proto__` is an ordinary attribute name; assigning it would hit the setter.
function define(target: Record<string, Attr>, name: string, value: Attr): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}
