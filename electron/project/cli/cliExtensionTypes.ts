// The seam between the core CLI and the commands installed apps contribute (cliExtensions.ts): the runner asks a provider for the commands a
// role may see, for the row of one command, and for the handler that plans it. Core never imports app code; apps never replace core rows.
import type { CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import type { FileSchema } from '../../../shared/properties/cli/stackiSchema';
import type { Handler } from './cliCommands';
import type { RoleContext } from './cliRole';

export interface ExtensionProvider {
  /** The commands of active apps that `role` may run: what help and the MCP tool list show. */
  readonly commands: (role: RoleContext) => readonly CommandSpec[];
  /** The row of any command an installed app declares, active or not, so an inactive one is refused with its reason instead of "unknown". */
  readonly find: (words: readonly string[]) => CommandSpec | undefined;
  readonly handler: (words: readonly string[]) => Handler | undefined;
  /** Every declared row whatever the app's state: a command line for a disabled app still parses. */
  readonly declared: readonly CommandSpec[];
  /** The registry files of active apps; `runCommand` registers them for the run. */
  readonly files: readonly FileSchema[];
  /** Why `role` may not run this app command (its app grant, its manifest permission, the app's state), or undefined. */
  readonly denial: (role: RoleContext, spec: CommandSpec) => CliError | undefined;
}
