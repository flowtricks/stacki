// The seam between the core CLI and the commands installed apps contribute (cliExtensions.ts): the runner asks a provider for the commands a
// role may see, for the row of one command, and for the handler that plans it. Core never imports app code; apps never replace core rows.
import type { CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import type { Handler } from './cliCommands';
import type { RoleContext } from './cliRole';

export interface ExtensionProvider {
  readonly commands: (role: RoleContext) => readonly CommandSpec[];
  readonly find: (words: readonly string[]) => CommandSpec | undefined;
  readonly handler: (words: readonly string[]) => Handler | undefined;
}
