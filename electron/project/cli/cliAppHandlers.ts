// The handlers of app commands: one turns a command's inputs into config edits, declaratively or by asking the app's module.
//
// The handler never writes. Both kinds end in `Edit`s that `runCommand` stages into a plan and applies atomically only with `--apply`, through the
// same registry check, parser check, role check, project lock and undo journal as every core command. Which kind runs is the manifest's:
//   - declarative: the manifest's fixed list of operations, `$input` references replaced by the (bounds-checked) arguments: no app code runs;
//   - module: the app's JS file answers a list of operations once, always as phase "plan", for this one call. `--apply` writes the files the CLI
//     staged from that single answer; the module is never called a second time and never learns whether an apply follows.
// Either way each operation must lie inside a key the command's manifest `owns` (`ownsPath`), name a registry file that is active, and pass the
// registry's value check, so an app can touch only what it declared, and a bad value is refused before any file changes.
import { err, ok, type Result } from '../../../shared/core/result';
import { toRecord } from '../../../shared/core/record';
import { parseConfigPath } from '../../../shared/properties/cli/stackiConfigPath';
import type { ConfigOperation } from '../../../shared/properties/cli/stackiConfigEdit';
import { APP_CLI_LIMITS, ownsPath, type AppCliCommand, type AppCliOperation } from '../../../shared/properties/cli/stackiAppCli';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { checkValue } from '../../../shared/properties/cli/stackiSchema';
import { fileSchemaById } from '../../../shared/properties/cli/stackiFiles';
import type { CommandContext, Handler, Outcome } from './cliCommands';
import { documentOf, readFileState } from './cliFiles';
import { configEdit, type Edit } from './cliPlan';
import { runModule } from './cliAppModule';
import type { LoadedApp } from './cliAppLoad';

const refused = (message: string, code: CliError['code'] = 'refused'): Result<never, CliError> => err({ code, message });

/** The handler for a command of `app`; for an app that is not active, one that refuses with the typed reason. */
export function appHandler(app: LoadedApp, command: AppCliCommand): Handler {
  if (app.state.kind !== 'active') {
    const reason = app.state.kind === 'none' ? 'declares no commands' : app.state.reason;
    return () => refused(`The ${app.id} app's command "${command.name}" is off: ${reason}`, 'app-untrusted');
  }
  return command.handler.kind === 'declarative' ? declarativeHandler(app, command, command.handler.operations) : moduleHandler(app, command);
}

function declarativeHandler(app: LoadedApp, command: AppCliCommand, operations: readonly AppCliOperation[]): Handler {
  return (context) => {
    const input = checkedInput(command, context);
    if (!input.ok) {
      return input;
    }
    const resolved: ResolvedOperation[] = [];
    for (const operation of operations) {
      const value = valueOf(operation, input.value);
      if (!value.ok) {
        return value;
      }
      resolved.push({ file: operation.file, operation: configOperation(operation.op, operation.segments, value.value) });
    }
    return outcomeOf(app, command, resolved, `Ran ${app.id} ${command.name}.`, ['Declarative command: no app code runs.']);
  };
}

function moduleHandler(app: LoadedApp, command: AppCliCommand): Handler {
  return async (context) => {
    if (command.handler.kind !== 'module') {
      return refused('Not a module command.', 'internal');
    }
    if (app.section?.network === true && app.record?.network !== true) {
      return refused(
        `The ${app.id} app declares network use and its admin has not approved it: run "stacki apps enable ${app.id} --network" to accept it. Module handlers cannot be stopped from using the network.`,
        'app-untrusted',
      );
    }
    const input = checkedInput(command, context);
    if (!input.ok) {
      return input;
    }
    const state = stateOf(command, context.root);
    if (!state.ok) {
      return state;
    }
    const answer = await runModule({
      folder: app.folder,
      entry: command.handler.entry,
      timeoutSeconds: command.handler.timeoutSeconds,
      request: { command: `${app.id} ${command.name}`, input: input.value, state: state.value },
    });
    if (!answer.ok) {
      return answer;
    }
    if (!answer.value.ok) {
      return refused(`The ${app.id} app refused "${command.name}": ${answer.value.message}`);
    }
    if (!command.writes) {
      if (answer.value.operations.length > 0) {
        return refused(`The ${app.id} command "${command.name}" is declared read-only but its module answered with operations. Nothing was changed.`);
      }
      return ok({ kind: 'read', summary: answer.value.summary, result: answer.value.result ?? {}, notes: moduleNotes(app, command) });
    }
    const resolved = operationsOf(command, answer.value.operations);
    if (!resolved.ok) {
      return resolved;
    }
    return outcomeOf(app, command, resolved.value, answer.value.summary, moduleNotes(app, command));
  };
}

function moduleNotes(app: LoadedApp, command: AppCliCommand): readonly string[] {
  const notes = [
    `This command runs code from the ${app.id} app (${command.handler.kind === 'module' ? command.handler.entry : ''}) in a restricted child process: it can read only its own folder, cannot write files or start programs, and gets no environment variables. The CLI applies its answer, never the app.`,
  ];
  if (app.section?.network === true) {
    notes.push('The app declares network use. The permission model cannot block the network, so this is a declaration the admin accepted, not a limit.');
  }
  return notes;
}

// ----- Input -----

/** The arguments with the bounds the argument parser does not check (length, range, pattern) applied. */
function checkedInput(command: AppCliCommand, context: CommandContext): Result<Readonly<Record<string, unknown>>, CliError> {
  for (const input of command.inputs) {
    const value = context.args[input.name];
    if (value !== undefined) {
      const reason = checkValue(input.schema, value, input.name);
      if (reason !== undefined) {
        return refused(reason, 'invalid-value');
      }
    }
  }
  return ok(context.args);
}

function valueOf(operation: AppCliOperation, input: Readonly<Record<string, unknown>>): Result<unknown, CliError> {
  const value = operation.value;
  if (value === undefined) {
    return ok(undefined);
  }
  if (value.kind === 'literal') {
    return ok(value.value);
  }
  const given = input[value.name];
  return given === undefined ? refused(`"${value.name}" is needed by this command's ${operation.op} of ${operation.path}.`, 'required') : ok(given);
}

// ----- Operations -----

interface ResolvedOperation {
  readonly file: string;
  readonly operation: ConfigOperation;
}

function configOperation(op: AppCliOperation['op'], path: ConfigOperation['path'], value: unknown): ConfigOperation {
  switch (op) {
    case 'set':
      return { kind: 'set', path, value };
    case 'unset':
      return { kind: 'unset', path };
    case 'add':
      return { kind: 'add', path, value };
    case 'remove':
      return { kind: 'remove', path, ...(value === undefined ? {} : { value }) };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/** A module's answered operations checked against what the command owns: the same rule a declarative one passes at load. */
function operationsOf(command: AppCliCommand, answered: readonly unknown[]): Result<readonly ResolvedOperation[], CliError> {
  if (answered.length > APP_CLI_LIMITS.moduleOperationsMax) {
    return refused(`The module answered with more than ${APP_CLI_LIMITS.moduleOperationsMax} operations.`);
  }
  const resolved: ResolvedOperation[] = [];
  for (const [index, item] of answered.entries()) {
    const entry = toRecord(item);
    const where = `operation ${index + 1}`;
    if (entry === undefined || typeof entry['file'] !== 'string' || typeof entry['path'] !== 'string') {
      return refused(`The module's ${where} needs a file and a path (text).`);
    }
    const op = entry['op'];
    if (op !== 'set' && op !== 'unset' && op !== 'add' && op !== 'remove') {
      return refused(`The module's ${where}: op must be set, unset, add or remove.`);
    }
    const segments = parseConfigPath(entry['path']);
    if (!segments.ok) {
      return refused(`The module's ${where}: ${segments.error.message}`);
    }
    if (!ownsPath(command.owns, entry['file'], segments.value)) {
      return refused(`The module's ${where} (${entry['file']} ${entry['path']}) is outside the keys this command owns. Nothing was changed.`);
    }
    if ((op === 'set' || op === 'add') && entry['value'] === undefined) {
      return refused(`The module's ${where}: ${op} needs a value.`);
    }
    resolved.push({ file: entry['file'], operation: configOperation(op, segments.value, entry['value']) });
  }
  return ok(resolved);
}

/** The documents the module may read: each owned file as it is now, the empty document for one that does not exist. */
function stateOf(command: AppCliCommand, root: string): Result<Readonly<Record<string, unknown>>, CliError> {
  const state: Record<string, unknown> = {};
  for (const own of command.owns) {
    const schema = fileSchemaById(own.file);
    if (schema === undefined) {
      return refused(`The file ${own.file} is not in the key reference (is its app enabled?).`, 'internal');
    }
    const read = readFileState(root, schema);
    if (!read.ok) {
      return read;
    }
    const document = documentOf(read.value);
    if (!document.ok) {
      return document;
    }
    state[own.file] = document.value;
  }
  return ok(state);
}

function outcomeOf(
  app: LoadedApp,
  command: AppCliCommand,
  operations: readonly ResolvedOperation[],
  summary: string,
  notes: readonly string[],
): Result<Outcome, CliError> {
  const edits: Edit[] = [];
  for (const file of new Set(operations.map((entry) => entry.file))) {
    const schema = fileSchemaById(file);
    if (schema === undefined) {
      return refused(`The file ${file} is not in the key reference (is its app enabled?).`, 'internal');
    }
    edits.push(
      configEdit(
        schema,
        operations.filter((entry) => entry.file === file).map((entry) => entry.operation),
      ),
    );
  }
  const touched = command.owns.map((own) => `${own.file} (${own.keys.map((key) => key.text).join(', ')})`).join('; ');
  return ok({
    kind: 'write',
    edits,
    summary,
    notes: [`Command of the ${app.id} app. It may touch only: ${touched || 'nothing'}.`, ...notes],
  });
}
