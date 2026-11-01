// AGENTS.md §6: no boolean parameters — `fetchUsers(true, false)` hides its
// meaning at the call site; an options object names every flag. Two shapes are
// exempt because the call site already names the meaning:
// - A callback written inline where it is passed (`onChange={(checked) =>`):
//   the caller's protocol chooses its parameters, not this code.
// - A setter whose only parameter is the flag (`setOpen(open: boolean)`): the
//   function name states what the value means.

import type { TSESTree } from '@typescript-eslint/utils';
import { functionName, isInlineCallback, parameterAnnotation, unionMembers, type FunctionNode, type RuleModule } from './ast.mts';

const SETTER_PREFIX = /^set[A-Z]/;

export const noBooleanParameter: RuleModule<'booleanParameter'> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Boolean flags travel in a named options object (AGENTS.md §6).' },
    messages: {
      booleanParameter:
        "Parameter '{{name}}' is a boolean flag; pass an options object " + '({ readonly {{name}}?: boolean }) so the call site names it (AGENTS.md §6).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node: FunctionNode | TSESTree.TSDeclareFunction): void {
      if (node.type !== 'TSDeclareFunction') {
        if (isInlineCallback(node)) {
          return;
        }
      }
      const booleans = node.params.filter(isBooleanParameter);
      if (booleans.length === 0) {
        return;
      }
      const name = node.type === 'TSDeclareFunction' ? node.id?.name : functionName(node);
      if (node.params.length === 1) {
        if (name !== undefined) {
          if (SETTER_PREFIX.test(name)) {
            return;
          }
        }
      }
      for (const parameter of booleans) {
        const label = parameterLabel(parameter);
        context.report({ node: parameter, messageId: 'booleanParameter', data: { name: label } });
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

function isBooleanParameter(parameter: TSESTree.Parameter): boolean {
  const annotation = parameterAnnotation(parameter);
  if (annotation === undefined) {
    return false;
  }
  return unionMembers(annotation).some(isBooleanType);
}

// `boolean`, or the literal `true`/`false` a union spells it with.
function isBooleanType(member: TSESTree.TypeNode): boolean {
  if (member.type === 'TSBooleanKeyword') {
    return true;
  }
  if (member.type === 'TSLiteralType') {
    if (member.literal.type === 'Literal') {
      return typeof member.literal.value === 'boolean';
    }
  }
  return false;
}

function parameterLabel(parameter: TSESTree.Parameter): string {
  const target = parameter.type === 'TSParameterProperty' ? parameter.parameter : parameter;
  const binding = target.type === 'AssignmentPattern' ? target.left : target;
  // A destructured boolean has no single name; the options object it becomes
  // will name each field.
  return binding.type === 'Identifier' ? binding.name : 'flag';
}
