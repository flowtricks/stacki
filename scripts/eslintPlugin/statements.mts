// Small single-node rules from AGENTS.md, each a direct transcription of one
// line in its "Forbidden patterns" table.

import type { TSESTree } from '@typescript-eslint/utils';
import { assert } from '../policy/assert.mts';
import { parameterAnnotation, type FunctionNode, type RuleModule } from './ast.mts';

// §3: `catch` binds `unknown`; spell it, so the narrowing obligation is on the
// page and survives a tsconfig change.
export const catchUnknown: RuleModule<'untyped'> = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: { description: 'Catch bindings are annotated `unknown` (AGENTS.md §3).' },
    messages: {
      untyped: 'Write `catch ({{name}}: unknown)` and narrow before use (AGENTS.md §3).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node) {
        const parameter = node.param;
        if (parameter === null) {
          return;
        }
        if (parameter.type !== 'Identifier') {
          return;
        }
        if (parameter.typeAnnotation !== undefined) {
          return;
        }
        context.report({
          node: parameter,
          messageId: 'untyped',
          data: { name: parameter.name },
          fix: (fixer) => fixer.insertTextAfter(parameter, ': unknown'),
        });
      },
    };
  },
};

// §9: `assert(a && b)` reports one message for two conditions; split it so the
// failure names the one that broke.
export const noCompoundAssert: RuleModule<'compound'> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'One condition per assertion (AGENTS.md §9).' },
    messages: { compound: 'Split into one `assert` per condition (AGENTS.md §9).' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'assert') {
          return;
        }
        const condition = node.arguments[0];
        if (condition === undefined) {
          return;
        }
        if (condition.type === 'LogicalExpression' && condition.operator === '&&') {
          context.report({ node: condition, messageId: 'compound' });
        }
      },
    };
  },
};

// §10: every loop has a provable bound. A constant-true condition states none.
export const noUnboundedLoop: RuleModule<'unbounded'> = {
  meta: {
    type: 'problem',
    docs: { description: 'Loops state their bound (AGENTS.md §10).' },
    messages: {
      unbounded: 'This loop has no bound in its condition; loop on the bounded quantity, or count ' + 'iterations against a LIMITS constant (AGENTS.md §10).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node: TSESTree.DoWhileStatement | TSESTree.WhileStatement): void {
      if (isConstantTrue(node.test)) {
        context.report({ node, messageId: 'unbounded' });
      }
    }
    return {
      WhileStatement: check,
      DoWhileStatement: check,
      ForStatement(node) {
        if (node.test === null || isConstantTrue(node.test)) {
          context.report({ node, messageId: 'unbounded' });
        }
      },
    };
  },
};

function isConstantTrue(test: TSESTree.Expression): boolean {
  if (test.type !== 'Literal') {
    return false;
  }
  return test.value === true || test.value === 1;
}

// §14: an index or a count is an integer; a bare `/` feeding one hides the
// rounding decision. Division is fine for floats (scaling, ratios), so only
// the positions that demand an integer are checked.
const INTEGER_ARGUMENT_METHODS = new Set(['at', 'charAt', 'charCodeAt', 'codePointAt', 'padEnd', 'padStart', 'repeat', 'slice', 'splice', 'substring']);

export const divisionIntent: RuleModule<'bareDivision'> = {
  meta: {
    type: 'problem',
    docs: { description: 'Integer positions state their rounding (AGENTS.md §14).' },
    messages: {
      bareDivision: 'This division feeds an index or count: state the rounding with Math.floor, ' + 'Math.ceil, or Math.trunc (AGENTS.md §14).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== '/') {
          return;
        }
        if (feedsInteger(node)) {
          context.report({ node, messageId: 'bareDivision' });
        }
      },
    };
  },
};

function feedsInteger(node: TSESTree.BinaryExpression): boolean {
  const parent = node.parent;
  if (parent.type === 'MemberExpression') {
    return parent.computed && parent.property === node;
  }
  if (parent.type === 'NewExpression') {
    return parent.callee.type === 'Identifier' && parent.callee.name === 'Array';
  }
  if (parent.type === 'CallExpression') {
    const callee = parent.callee;
    if (callee.type === 'Identifier') {
      return callee.name === 'Array';
    }
    if (callee.type === 'MemberExpression') {
      if (callee.property.type === 'Identifier') {
        return INTEGER_ARGUMENT_METHODS.has(callee.property.name);
      }
    }
  }
  return false;
}

// Non-negotiable 3: string-literal unions and `as const` arrays, never `enum`.
export const noEnum: RuleModule<'enum'> = {
  meta: {
    type: 'problem',
    docs: { description: 'No enums (AGENTS.md non-negotiable 3).' },
    messages: {
      enum: 'Use a string-literal union with an `as const` array instead of `enum` (AGENTS.md §1).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      TSEnumDeclaration: (node) => context.report({ node, messageId: 'enum' }),
    };
  },
};

// Non-negotiable 4: an update type names its fields with `Pick<>`;
// `Partial<T>` accepts an empty object that means nothing.
export const noPartialParameter: RuleModule<'partial'> = {
  meta: {
    type: 'problem',
    docs: { description: 'No Partial<T> function inputs (AGENTS.md non-negotiable 4).' },
    messages: {
      partial: 'Name the accepted fields with `Pick<T, …>` instead of `Partial<T>` (AGENTS.md).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node: FunctionNode | TSESTree.TSDeclareFunction): void {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === undefined) {
          continue;
        }
        if (annotation.type === 'TSTypeReference') {
          const typeName = annotation.typeName;
          if (typeName.type === 'Identifier' && typeName.name === 'Partial') {
            context.report({ node: annotation, messageId: 'partial' });
          }
        }
      }
    }
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      TSDeclareFunction: check,
    };
  },
};

// §8: no overloads — a union parameter or a generic says the same thing with
// one implementation signature the compiler checks.
export const noOverloads: RuleModule<'overload'> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'No function overloads (AGENTS.md §8).' },
    messages: {
      overload: 'Replace overload signatures with a union or generic signature (AGENTS.md §8).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    if (context.filename.endsWith('.d.ts')) {
      return {};
    }
    return {
      TSDeclareFunction(node) {
        // `declare function` describes an external global, not an overload.
        if (node.declare) {
          return;
        }
        context.report({ node, messageId: 'overload' });
      },
      MethodDefinition(node) {
        if (node.value.type === 'TSEmptyBodyFunctionExpression') {
          context.report({ node, messageId: 'overload' });
        }
      },
    };
  },
};

// §6: callbacks go last — they are also invoked last, and a trailing function
// literal reads in execution order at the call site.
export const callbackLast: RuleModule<'callbackNotLast'> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Callback parameters come last (AGENTS.md §6).' },
    messages: {
      callbackNotLast: 'Move the callback parameter to the end of the list (AGENTS.md §6).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node: FunctionNode | TSESTree.TSDeclareFunction): void {
      const count = node.params.length;
      for (let index = 0; index < count; index += 1) {
        const parameter = node.params[index];
        assert(parameter !== undefined, 'callback-last: index within params');
        const annotation = parameterAnnotation(parameter);
        if (annotation === undefined) {
          continue;
        }
        if (annotation.type !== 'TSFunctionType') {
          continue;
        }
        const later = node.params.slice(index + 1);
        if (later.some((next) => parameterAnnotation(next)?.type !== 'TSFunctionType')) {
          context.report({ node: parameter, messageId: 'callbackNotLast' });
        }
      }
    }
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      TSDeclareFunction: check,
    };
  },
};
