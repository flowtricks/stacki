// AGENTS.md §6: `undefined` is the one spelling of absence. Our own values and
// types never hold `null`; a platform API that returns one (`querySelector`,
// `localStorage.getItem`, `match`) is converted where it is read — `?? undefined`
// — or checked there with `=== null`. What stays is the fixed list of platform
// calls that require a `null` argument, each named below; anything else needs
// an `eslint-disable-next-line stacki/no-null -- <reason>`.

import type { TSESTree } from '@typescript-eslint/utils';
import type { RuleModule } from './ast.mts';

type MessageIds = 'nullLiteral' | 'nullType';

// Method names whose null argument is the platform's protocol, not a value of
// ours, keyed by the argument index that takes it.
const PLATFORM_NULL_ARGUMENTS: ReadonlyMap<string, number> = new Map([
  ['create', 0], // Object.create(null): a dictionary with no prototype
  ['setPrototypeOf', 1], // Object.setPrototypeOf(x, null)
  ['stringify', 1], // JSON.stringify(value, null, indent): no replacer
  ['pushState', 0], // history.pushState(null, '', url): no state object
  ['replaceState', 0],
  ['useRef', 0], // React's RefObject<T> for a ref prop is built from useRef<T>(null)
]);

export const noNull: RuleModule<MessageIds> = {
  meta: {
    type: 'suggestion',
    docs: { description: '`undefined` is the only spelling of absence (AGENTS.md §6).' },
    messages: {
      nullLiteral:
        'Use `undefined` for absence (AGENTS.md §6). Convert a platform null where it is ' + 'read (`?? undefined`) or compare it there with `=== null`.',
      nullType: 'Types say absence with `undefined` (`T | undefined`), never `null` (AGENTS.md §6).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const declarationFile = context.filename.endsWith('.d.ts');
    return {
      Literal(node) {
        if (node.raw !== 'null') {
          return;
        }
        if (isPlatformNull(node)) {
          return;
        }
        context.report({ node, messageId: 'nullLiteral' });
      },
      TSNullKeyword(node) {
        // A declaration file describes someone else's API as it is.
        if (declarationFile) {
          return;
        }
        context.report({ node, messageId: 'nullType' });
      },
    };
  },
};

function isPlatformNull(node: TSESTree.Literal): boolean {
  const parent = node.parent;
  if (parent.type === 'BinaryExpression') {
    return parent.operator === '===' || parent.operator === '!==';
  }
  if (parent.type === 'CallExpression') {
    const name = calleeName(parent.callee);
    if (name === undefined) {
      return false;
    }
    const index = PLATFORM_NULL_ARGUMENTS.get(name);
    if (index === undefined) {
      return false;
    }
    return parent.arguments[index] === node;
  }
  return false;
}

function calleeName(callee: TSESTree.Expression): string | undefined {
  if (callee.type === 'Identifier') {
    return callee.name;
  }
  if (callee.type === 'MemberExpression') {
    if (callee.property.type === 'Identifier') {
      return callee.property.name;
    }
  }
  return undefined;
}
