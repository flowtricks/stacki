// Stacki's own `/` commands, listed in the composer's command menu above the agent's. They act in
// Stacki rather than being sent to the agent: `/clear` starts a new chat (the Claude adapter refuses
// `/clear`, because a protocol session cannot be emptied in place), `/export` copies the chat as
// Markdown and `/find` opens the search of the chat. An agent command of the same name is left out of
// the menu: Claude Code's own `/export` writes to a terminal Stacki does not show, so it would do nothing.
import { assert } from '../../../../shared/core/assert';
import type { ChatCommand } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';

export const BUILTIN_COMMAND_NAMES = ['clear', 'export', 'find'] as const;
export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];

/** The built-in commands as menu rows, described in the person's language. */
export function builtinCommands(translate: Translator): readonly ChatCommand[] {
  const rows = BUILTIN_COMMAND_NAMES.map((name) => ({ name, description: describe(name, translate), hint: undefined }));
  assert(rows.length === BUILTIN_COMMAND_NAMES.length, 'builtinCommands: one row per name');
  return rows;
}

/** The menu's commands: Stacki's first, then the agent's without the names Stacki answers. */
export function withBuiltinCommands(builtins: readonly ChatCommand[], advertised: readonly ChatCommand[]): readonly ChatCommand[] {
  const taken = new Set(builtins.map((command) => command.name));
  const merged = [...builtins, ...advertised.filter((command) => !taken.has(command.name))];
  assert(merged.length <= builtins.length + advertised.length, 'withBuiltinCommands: nothing is added twice');
  return merged;
}

/** The built-in command a name is, or undefined for an agent's command. */
export function builtinCommandNamed(name: string): BuiltinCommandName | undefined {
  return BUILTIN_COMMAND_NAMES.find((candidate) => candidate === name);
}

/**
 * The built-in command a whole draft is (`/clear`, with any space around it), or undefined. Why the
 * whole draft: `/export these notes` is a message that happens to start with a command's name, and
 * only the bare command is the person asking Stacki to act.
 */
export function builtinCommandOfDraft(text: string): BuiltinCommandName | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }
  return builtinCommandNamed(trimmed.slice(1));
}

function describe(name: BuiltinCommandName, translate: Translator): string {
  switch (name) {
    case 'clear':
      return translate('ai.command.clear');
    case 'export':
      return translate('ai.command.export');
    case 'find':
      return translate('ai.command.find');
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}
