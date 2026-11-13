import type { MessageRef } from '../../../vendor/stacki/shared/core/i18n/messageReference';
import * as css from '../../../vendor/stacki/electron/project/cssVars';
import { parseIpcPayload } from '../../../vendor/stacki/shared/ipc/ipcPayloads';
import { VARIABLE_ROOT } from './variableWorkspace';
import { restoreVariableOperation } from './variableRestore';

export function applyVariableOperation(operation: string, input: unknown) {
  switch (operation) {
    case 'restoreCssVariables':
      return restoreVariableOperation(input);
    case 'setCssVariable':
      return css.setVariable(VARIABLE_ROOT, parseIpcPayload('css:setVariable', input));
    case 'setCssSectionTitle':
      return css.setSectionTitle(VARIABLE_ROOT, parseIpcPayload('css:setSectionTitle', input));
    case 'addCssSection':
      return css.addSection(VARIABLE_ROOT, parseIpcPayload('css:addSection', input));
    case 'removeCssSection':
      return css.removeSection(VARIABLE_ROOT, parseIpcPayload('css:removeSection', input));
    case 'moveCssHeading':
      return css.moveHeading(VARIABLE_ROOT, parseIpcPayload('css:moveHeading', input));
    case 'renameCssVariables':
      return css.renameVariables(VARIABLE_ROOT, parseIpcPayload('css:renameVariables', input));
    case 'addCssVariables':
      return batch(parseIpcPayload('css:addVariables', input).adds ?? [], (add) => css.addVariable(VARIABLE_ROOT, add));
    case 'moveCssVariables':
      return batch(parseIpcPayload('css:moveVariables', input).moves ?? [], (move) =>
        'names' in move ? css.moveSection(VARIABLE_ROOT, move) : css.moveVariable(VARIABLE_ROOT, move),
      );
    default:
      throw new Error('Unknown variable operation');
  }
}
function batch<T>(items: readonly T[], apply: (item: T) => { ok: boolean; error?: string; errorRef?: MessageRef | undefined }) {
  if (items.length > 1000) {
    throw new Error('Too many variable edits');
  }
  for (const item of items) {
    const result = apply(item);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
