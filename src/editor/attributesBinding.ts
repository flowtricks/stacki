// An element's attributes connected to a component's attributes prop, which
// is Astro's rest props spread onto it:
//
//   <p data-testing="1" {...rest} data-text="">
//
// Astro gives a rest binding no default, so the prop's defaults are the
// attributes written before the spread: an instance passing the same name
// overrides them. The attributes after the spread are the element's own and
// override what an instance passes, as they did before the element was
// connected. That order is the whole model, so it is read and written here and
// nowhere else: the defaults are edited from the prop's settings, the
// element's own attributes from its attribute list. Props are an ordered
// record (pageNode.ts keys a spread by its source, `...rest`), so order is
// kept by building a new record rather than patching one.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Attr } from '../../shared/page/pageNode';
import type { AttributeDefault } from './propDeclaration';
import type { EditorNode } from './pageView';

// Read with absent values allowed, as the props panel holds them; written without.
type Props = Readonly<Record<string, Attr | undefined>>;
type WrittenProps = Readonly<Record<string, Attr>>;

/** An element's attributes split around a rest spread. */
export interface AttributesBinding {
  /** The attributes before the spread, which the prop's defaults are. */
  readonly defaults: readonly AttributeDefault[];
  /** The names of the attributes after the spread: the element's own. */
  readonly own: readonly string[];
}

// Attributes that are never a default even when written first: the class and
// style fields own them, and a directive is not an attribute an instance passes.
const NOT_DEFAULTS = /^(class|style|class:list|slot)$|^(set|is|client|server|transition|define):/;

/** The key a spread of `local` has in an element's props. */
export function spreadKey(local: string): string {
  assert(/^[A-Za-z_$][\w$]*$/.test(local), 'spreadKey: a rest binding is an identifier');
  return `...${local}`;
}

/** How an element's attributes sit around a spread of `local`, or undefined when it has none. */
export function readAttributesBinding(props: Props | undefined, local: string): AttributesBinding | undefined {
  const entries = present(props);
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'readAttributesBinding: attribute limit exceeded');
  const at = entries.findIndex(([name]) => name === spreadKey(local));
  if (at < 0) {
    return undefined;
  }
  const defaults: AttributeDefault[] = [];
  for (const [name, value] of entries.slice(0, at)) {
    if (!NOT_DEFAULTS.test(name) && (value.type === 'string' || value.type === 'bare')) {
      defaults.push({ name, value: value.type === 'string' ? value.value : '' });
    }
  }
  const own = entries.slice(at + 1).map(([name]) => name);
  assert(defaults.length + own.length < entries.length, 'readAttributesBinding: the spread is neither a default nor its own');
  return { defaults, own };
}

/**
 * The element's props connected to `local`: `defaults`, the spread, then every
 * attribute it already had (its own, still overriding). A default named like
 * one of its own attributes is dropped: the own one would always win.
 */
export function boundAttributes(props: Props | undefined, local: string, defaults: readonly AttributeDefault[]): WrittenProps {
  const key = spreadKey(local);
  const before = readAttributesBinding(props, local);
  // Connecting again (to change the defaults) keeps the element's own attributes and replaces the defaults.
  const kept = present(props).filter(([name]) => name !== key && (before === undefined || before.own.includes(name) || !isDefault(before, name)));
  const ownNames = new Set(kept.map(([name]) => name));
  const out: Record<string, Attr> = {};
  for (const entry of defaults) {
    if (!ownNames.has(entry.name)) {
      define(out, entry.name, entry.value === '' ? { type: 'bare' } : { type: 'string', value: entry.value });
    }
  }
  define(out, key, { type: 'spread', value: local });
  for (const [name, value] of kept) {
    define(out, name, value);
  }
  assert(Object.keys(out).length <= LIMITS.attrsPerNodeMax, 'boundAttributes: attribute limit exceeded');
  assert(readAttributesBinding(out, local) !== undefined, 'boundAttributes: the spread reads back');
  return out;
}

/** The element's props with the spread of `local` and the defaults before it taken out. */
export function unboundAttributes(props: Props | undefined, local: string): WrittenProps {
  const binding = readAttributesBinding(props, local);
  const out: Record<string, Attr> = {};
  for (const [name, value] of present(props)) {
    if (binding === undefined) {
      define(out, name, value);
      continue;
    }
    if (name !== spreadKey(local) && !isDefault(binding, name)) {
      define(out, name, value);
    }
  }
  assert(readAttributesBinding(out, local) === undefined, 'unboundAttributes: the spread is gone');
  assert(binding === undefined || binding.own.every((name) => Object.hasOwn(out, name)), 'unboundAttributes: the element keeps its own attributes');
  return out;
}

// The attributes that have a value, in order.
function present(props: Props | undefined): readonly (readonly [string, Attr])[] {
  const out: (readonly [string, Attr])[] = [];
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value !== undefined) {
      out.push([name, value]);
    }
  }
  return out;
}

function isDefault(binding: AttributesBinding, name: string): boolean {
  return binding.defaults.some((entry) => entry.name === name);
}

// `__proto__` is an ordinary attribute name; assigning it would hit the setter.
function define(target: Record<string, Attr>, name: string, value: Attr): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The node with its attributes replaced, in the order given: the source spans
 * describe the attributes as they were, so they go, and the attribute order is
 * the new one (pageEdits.ts writes a node from its props and that order, as
 * loopRebind.ts does for its rewrites).
 */
export function withAttributes(node: EditorNode, props: WrittenProps): EditorNode {
  const { attrSpans: staleSpans, ...rest } = node;
  void staleSpans;
  const order = Object.keys(props);
  assert(order.length <= LIMITS.attrsPerNodeMax, 'withAttributes: attribute limit exceeded');
  const out: EditorNode = { ...rest, props, attrOrder: order };
  assert(out.attrSpans === undefined, 'withAttributes: stale spans are gone');
  return out;
}
