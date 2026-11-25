// AST helpers shared by the stacki rules. Every helper is pure: it takes nodes
// and returns values, so each rule keeps its own control flow (AGENTS.md §11).

import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import { assert } from '../policy/assert.mts';

export type FunctionNode = TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration | TSESTree.FunctionExpression;

export type RuleModule<MessageIds extends string, Options extends readonly unknown[] = []> = TSESLint.RuleModule<MessageIds, Options>;

export type RuleContext<MessageIds extends string, Options extends readonly unknown[] = []> = Readonly<TSESLint.RuleContext<MessageIds, Options>>;

// Identifier words are split on camelCase humps, digits, and underscores, so
// `sourceElement`, `SOURCE_ELEMENT`, and `source_element` all yield the same
// lower-case words. Upper-case runs stay together: `parseURLValue` yields
// `parse`, `url`, `value`.
const WORD_PATTERN = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;
const IDENTIFIER_CHARS_MAX = 256;

export function identifierWords(name: string): readonly string[] {
  assert(name.length > 0, 'identifierWords: empty identifier');
  assert(name.length <= IDENTIFIER_CHARS_MAX, 'identifierWords: identifier exceeds limit');
  return Array.from(name.matchAll(WORD_PATTERN), (match) => match[0].toLowerCase());
}

// The name a function is known by, where the syntax gives it one: a
// declaration's id, or the variable an expression is bound to.
export function functionName(node: FunctionNode): string | undefined {
  if (node.id) {
    return node.id.name;
  }
  const parent = node.parent;
  if (parent.type === 'VariableDeclarator') {
    if (parent.id.type === 'Identifier') {
      return parent.id.name;
    }
    return undefined;
  }
  if (parent.type === 'MethodDefinition' || parent.type === 'Property') {
    if (parent.key.type === 'Identifier') {
      return parent.key.name;
    }
    return undefined;
  }
  return undefined;
}

// A function written inline where it is handed to something else — an
// argument, a JSX prop, a property of an object literal argument. Its
// parameters are chosen by the caller's protocol, not by this code.
export function isInlineCallback(node: FunctionNode): boolean {
  const parent = node.parent;
  if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
    return parent.arguments.some((argument) => argument === node);
  }
  if (parent.type === 'JSXExpressionContainer') {
    return true;
  }
  if (parent.type === 'Property') {
    return parent.value === node && parent.parent.type === 'ObjectExpression';
  }
  return false;
}

// The binding identifiers a parameter or declarator pattern introduces, in
// source order. Iterative with an explicit stack: patterns nest only as deep
// as the source text, and the stack is bounded by the node count.
const PATTERN_NODES_MAX = 10_000;

export function patternIdentifiers(root: TSESTree.Node): readonly TSESTree.Identifier[] {
  const found: TSESTree.Identifier[] = [];
  const pending: TSESTree.Node[] = [root];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= PATTERN_NODES_MAX, 'patternIdentifiers: pattern exceeds node limit');
    const node = pending.pop();
    assert(node !== undefined, 'patternIdentifiers: stack underflow');
    pending.push(...patternChildren(node));
    if (node.type === 'Identifier') {
      found.push(node);
    }
  }
  return found.reverse();
}

// The sub-patterns one pattern node binds through; none for a leaf.
function patternChildren(node: TSESTree.Node): readonly TSESTree.Node[] {
  if (node.type === 'AssignmentPattern') {
    return [node.left];
  }
  if (node.type === 'RestElement') {
    return [node.argument];
  }
  if (node.type === 'TSParameterProperty') {
    return [node.parameter];
  }
  if (node.type === 'ArrayPattern') {
    return node.elements.filter((element) => element !== null);
  }
  if (node.type === 'ObjectPattern') {
    return node.properties.map((property) => (property.type === 'Property' ? property.value : property));
  }
  return [];
}

// The type annotation written on a parameter, looking through defaults and
// rest syntax. Absent when the parameter is untyped.
export function parameterAnnotation(parameter: TSESTree.Parameter): TSESTree.TypeNode | undefined {
  // A constructor's `private readonly x: T` wraps the parameter one level.
  const target = parameter.type === 'TSParameterProperty' ? parameter.parameter : parameter;
  if (target.type === 'AssignmentPattern') {
    // `flag: boolean = false` carries its annotation on the left side.
    return target.left.type === 'Identifier' ? target.left.typeAnnotation?.typeAnnotation : undefined;
  }
  return target.typeAnnotation?.typeAnnotation;
}

// The members of a union, or the type itself when it is not one.
export function unionMembers(type: TSESTree.TypeNode): readonly TSESTree.TypeNode[] {
  return type.type === 'TSUnionType' ? type.types : [type];
}
