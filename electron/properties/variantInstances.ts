// The instances of a component that pass a given prop, with what each passes
// for its other props: an option as written (`variant="play"`, `{"play"}`,
// `pressed` alone, `{true}`), or code the writer does not judge. The variant
// rule plan (variantRulePlan.ts) refuses an edit that would make one of them a
// type error, naming its file.
import { parse } from '@astrojs/compiler/sync';
import type { AttributeNode, Node } from '@astrojs/compiler/types';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';

/** What an instance passes for one prop: an option it names, or code. */
export type PassedValue = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'code' };

export interface PassingInstance {
  readonly attributes: ReadonlyMap<string, PassedValue>;
}

/** Every instance in `source` of a component named one of `names` that passes `prop`; one with a spread passes it only if it says so. */
export function instancesPassing(source: string, names: ReadonlySet<string>, prop: string): Result<readonly PassingInstance[]> {
  let root: Node;
  try {
    const result = parse(source, { position: true });
    const diagnostic = result.diagnostics.find((entry) => entry.severity === 1);
    if (diagnostic !== undefined) {
      return err({ code: 'syntax', message: diagnostic.text });
    }
    root = result.ast;
  } catch (caught: unknown) {
    return err({ code: 'syntax', message: String(caught) });
  }
  const found: PassingInstance[] = [];
  const pending: Node[] = [root];
  for (let index = 0; index < pending.length; index += 1) {
    assert(pending.length <= PROPERTY_LIMITS.nodesMax, 'instancesPassing: the node walk is bounded');
    const node = pending[index];
    assert(node !== undefined, 'instancesPassing: a queued node exists');
    if (node.type === 'component' && names.has(node.name)) {
      const attributes = new Map(node.attributes.flatMap((attribute) => passedOf(attribute)));
      if (attributes.has(prop)) {
        found.push({ attributes });
      }
    }
    if ('children' in node && !(node.type === 'element' && ['script', 'style'].includes(node.name))) {
      pending.push(...node.children);
    }
  }
  return ok(found);
}

function passedOf(attribute: AttributeNode): readonly (readonly [string, PassedValue])[] {
  switch (attribute.kind) {
    case 'quoted':
      return [[attribute.name, { kind: 'literal', value: attribute.value }]];
    case 'empty':
      return [[attribute.name, { kind: 'literal', value: 'true' }]];
    case 'expression': {
      const literal = /^\s*(?:(["'`])([^"'`\\$]*)\1|(true|false))\s*$/.exec(attribute.value);
      const value = literal?.[2] ?? literal?.[3];
      return [[attribute.name, value === undefined ? { kind: 'code' } : { kind: 'literal', value }]];
    }
    case 'spread':
      return [];
    case 'shorthand':
    case 'template-literal':
      return [[attribute.name, { kind: 'code' }]];
    default: {
      const exhaustive: never = attribute.kind;
      return exhaustive;
    }
  }
}
