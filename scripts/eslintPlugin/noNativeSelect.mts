// AGENTS.md "Dropdowns": a choice from a list is the app's own dropdown,
// src/ui/Dropdown.tsx, never a native `<select>`. A native select draws the
// operating system's menu, which cannot be styled or themed, so it looks and
// behaves differently from every other menu in Desktop and Studio. Both
// spellings of one are rejected: the JSX intrinsic element, and
// `createElement('select')` on `document` or React.
//
// This file imports types only, so Studio's ESLint config can load the vendored
// copy (studio/scripts/shared-source.json) without the rest of the plugin.

import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

const MESSAGE =
  'Use the custom dropdown, src/ui/Dropdown.tsx (Studio: vendor/stacki/src/ui/Dropdown.tsx), never a native <select>: ' +
  'it cannot be styled or themed, so it looks and behaves unlike every other menu (AGENTS.md "Dropdowns").';

export const noNativeSelect: TSESLint.RuleModule<'nativeSelect'> = {
  meta: {
    type: 'problem',
    docs: { description: 'Lists are chosen from the custom dropdown, never a native <select> (AGENTS.md "Dropdowns").' },
    messages: { nativeSelect: MESSAGE },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier') {
          if (node.name.name === 'select') {
            context.report({ node, messageId: 'nativeSelect' });
          }
        }
      },
      CallExpression(node) {
        if (calleeName(node.callee) !== 'createElement') {
          return;
        }
        const first = node.arguments[0];
        if (first === undefined) {
          return;
        }
        if (staticText(first)?.toLowerCase() === 'select') {
          context.report({ node, messageId: 'nativeSelect' });
        }
      },
    };
  },
};

function calleeName(callee: TSESTree.Expression): string | undefined {
  if (callee.type === 'Identifier') {
    return callee.name;
  }
  if (callee.type === 'MemberExpression') {
    if (callee.property.type === 'Identifier') {
      return callee.property.name;
    }
    return undefined;
  }
  return undefined;
}

// The tag a call names when it is spelled out in the source: a string literal
// or a template with no substitutions.
function staticText(argument: TSESTree.CallExpressionArgument): string | undefined {
  if (argument.type === 'Literal') {
    return typeof argument.value === 'string' ? argument.value : undefined;
  }
  if (argument.type === 'TemplateLiteral') {
    if (argument.expressions.length === 0) {
      return argument.quasis[0]?.value.cooked ?? undefined;
    }
    return undefined;
  }
  return undefined;
}
