// AGENTS.md §12: no abbreviations, and qualifiers go last. Checked on every
// name this code declares — variables, parameters, catch bindings, functions,
// classes, and types — word by word, so `srcPath` is caught as surely as
// `src`. Property keys are not checked: they mirror external shapes (an
// `<img src>`, a CSS `maxWidth`) whose names are not ours to choose.

import type { TSESTree } from '@typescript-eslint/utils';
import { assert } from '../policy/assert.mts';
import { identifierWords, patternIdentifiers, type RuleModule } from './ast.mts';

type MessageIds = 'abbreviation' | 'qualifierFirst';
interface Options {
  // Abbreviated word → the full word to use instead.
  readonly words: Readonly<Record<string, string>>;
  // Exact names exempt from the check, each with a reason in the config.
  readonly allowedNames?: readonly string[];
  // Units and quantities that make a `max`/`min` prefix a misplaced qualifier.
  readonly quantityWords?: readonly string[];
}

const QUALIFIERS = new Set(['max', 'min']);

export const naming: RuleModule<MessageIds, [Options]> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Names are unabbreviated, with qualifiers last (AGENTS.md §12).' },
    messages: {
      abbreviation: "'{{name}}' abbreviates '{{word}}': write '{{replacement}}' (AGENTS.md §12).",
      qualifierFirst: "'{{name}}' puts its qualifier first: write the quantity, then '{{qualifier}}' " + '(latencyMsMax, not maxLatencyMs; AGENTS.md §12).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          words: { type: 'object', additionalProperties: { type: 'string' } },
          allowedNames: { type: 'array', items: { type: 'string' } },
          quantityWords: { type: 'array', items: { type: 'string' } },
        },
        required: ['words'],
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ words: {} }],
  create(context) {
    const [options] = context.options;
    assert(options !== undefined, 'naming: options are required');
    const words = new Map(Object.entries(options.words));
    const allowed = new Set(options.allowedNames ?? []);
    const quantities = new Set(options.quantityWords ?? []);

    function check(identifier: TSESTree.Identifier): void {
      if (allowed.has(identifier.name)) {
        return;
      }
      const problem = nameProblem(identifier.name, words, quantities);
      if (problem !== undefined) {
        context.report({ node: identifier, ...problem });
      }
    }

    function checkPattern(pattern: TSESTree.Node): void {
      for (const identifier of patternIdentifiers(pattern)) {
        check(identifier);
      }
    }

    function checkFunction(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.TSDeclareFunction,
    ): void {
      if (node.id) {
        check(node.id);
      }
      for (const parameter of node.params) {
        checkPattern(parameter);
      }
    }

    return {
      VariableDeclarator: (node) => checkPattern(node.id),
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      TSDeclareFunction: checkFunction,
      CatchClause: (node) => {
        if (node.param) {
          checkPattern(node.param);
        }
      },
      ClassDeclaration: (node) => {
        if (node.id) {
          check(node.id);
        }
      },
      TSTypeAliasDeclaration: (node) => check(node.id),
      TSInterfaceDeclaration: (node) => check(node.id),
    };
  },
};

type NameProblem =
  | {
      readonly messageId: 'abbreviation';
      readonly data: { readonly name: string; readonly word: string; readonly replacement: string };
    }
  | {
      readonly messageId: 'qualifierFirst';
      readonly data: { readonly name: string; readonly qualifier: string };
    };

export function nameProblem(name: string, words: ReadonlyMap<string, string>, quantities: ReadonlySet<string>): NameProblem | undefined {
  const parts = identifierWords(name);
  for (const word of parts) {
    const replacement = words.get(word);
    if (replacement !== undefined) {
      return { messageId: 'abbreviation', data: { name, word, replacement } };
    }
  }
  // A lone `max` names nothing but the qualifier; only a qualified quantity
  // (`maxDepth`) can put the qualifier in the wrong place.
  if (parts.length < 2) {
    return undefined;
  }
  const first = parts[0];
  const last = parts.at(-1);
  assert(first !== undefined, 'naming: a multi-word name has a first word');
  assert(last !== undefined, 'naming: a multi-word name has a last word');
  if (QUALIFIERS.has(first)) {
    if (quantities.has(last)) {
      return { messageId: 'qualifierFirst', data: { name, qualifier: first } };
    }
  }
  return undefined;
}
