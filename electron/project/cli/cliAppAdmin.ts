// `stacki apps enable|disable|commands`: how an admin turns an installed app's CLI commands on, off, and reads what they are.
//
// Enabling is the one trust decision: it records, in `.stacki/cli.json`, that this admin reviewed what the app adds and trusts it, against the lock
// digest of the app as installed. The plan shows what that grants (the commands, the files they may touch, whether any runs app code, the network
// declaration), because a person approving a plan should see what they approve. An update changes the digest, so trust ends until enabled again.
import { err, ok, type Result } from '../../../shared/core/result';
import type { AppCliCommand } from '../../../shared/properties/cli/stackiAppCli';
import { fileSchemaById } from '../../../shared/properties/cli/stackiFiles';
import { toolNameOf } from '../../../shared/properties/cli/stackiCommands';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import type { CliAppRecord } from '../../../shared/properties/cli/files/cliFile';
import type { CommandContext, Handler, Outcome } from './cliCommands';
import { configEdit } from './cliPlan';
import { loadProjectApps, type LoadedApp } from './cliAppLoad';

const refused = (message: string, code: CliError['code'] = 'refused'): Result<never, CliError> => err({ code, message });

function appNamed(context: CommandContext): Result<{ readonly app: LoadedApp | undefined; readonly id: string }, CliError> {
  const id = context.args['app'];
  if (typeof id !== 'string' || id === '') {
    return refused('apps enable|disable <app>', 'usage');
  }
  return ok({ app: loadProjectApps(context.root).apps.find((candidate) => candidate.id === id), id });
}

function handlerKindOf(command: AppCliCommand): string {
  return command.handler.kind === 'module' ? `module ${command.handler.entry} (runs app code in a restricted child process)` : 'declarative (no app code runs)';
}

/** One line per declared command and file: what enabling grants. */
function grantNotes(app: LoadedApp, network: 'approved' | 'declined'): readonly string[] {
  const section = app.section;
  if (section === undefined) {
    return [];
  }
  const notes = [`Trust is recorded against the app's lock digest ${app.sha256.slice(0, 12)}...; an update asks for it again.`];
  for (const command of section.commands) {
    const touches = command.owns.map((own) => `${own.file} ${own.keys.map((key) => key.text).join(', ')}`).join('; ') || 'no files';
    notes.push(
      `Adds "stacki ${app.id} ${command.name}" (${command.writes ? (command.destructive ? 'writes, deletes' : 'writes') : 'read only'}; ${handlerKindOf(command)}; may touch: ${touches}${command.permission === undefined ? '' : `; needs the app permission "${command.permission}"`}).`,
    );
  }
  for (const file of section.files) {
    notes.push(`Adds the settings file ${file.id} (${file.path}), settable with "stacki config".`);
  }
  const usesModule = section.commands.some((command) => command.handler.kind === 'module');
  if (section.network) {
    notes.push(
      network === 'approved'
        ? 'Network: the app declares network use and you approved it. The permission model cannot block the network, so this is a declaration, not a limit.'
        : 'Network: the app declares network use and it is NOT approved: its module commands refuse until you run "stacki apps enable <app> --network". The permission model cannot block the network either way.',
    );
  } else if (usesModule) {
    notes.push('Network: the app declares no network use. The permission model cannot block the network, so a module could still reach it.');
  } else {
    notes.push('Network: the app declares none and runs no code here.');
  }
  return notes;
}

const enable: Handler = (context) => {
  const named = appNamed(context);
  if (!named.ok) {
    return named;
  }
  const { app, id } = named.value;
  const schema = fileSchemaById('cli');
  if (schema === undefined) {
    return refused('The cli registry is missing.', 'internal');
  }
  if (app === undefined) {
    return refused(`"${id}" is not an installed app (no entry in .stacki/apps/apps.json).`, 'missing');
  }
  if (app.state.kind === 'refused') {
    return refused(`The ${id} app's commands cannot be enabled: ${app.state.reason}`);
  }
  if (app.state.kind === 'none') {
    return refused(`The ${id} app declares no CLI commands (its manifest has no "cli" section).`, 'missing');
  }
  const network = context.args['network'] === true;
  const record: CliAppRecord = { enabled: true, trusted: true, sha256: app.sha256, network };
  return ok({
    kind: 'write',
    summary: `Enable and trust the ${id} app's CLI commands (version ${app.version}).`,
    edits: [configEdit(schema, [{ kind: 'set', path: ['apps', id], value: record }])],
    notes: grantNotes(app, network ? 'approved' : 'declined'),
  } satisfies Outcome);
};

const disable: Handler = (context) => {
  const named = appNamed(context);
  if (!named.ok) {
    return named;
  }
  const { app, id } = named.value;
  const schema = fileSchemaById('cli');
  if (schema === undefined) {
    return refused('The cli registry is missing.', 'internal');
  }
  const known = app?.record;
  if (app === undefined && known === undefined) {
    return refused(`"${id}" is not an installed app and has no record in .stacki/cli.json.`, 'missing');
  }
  if (known === undefined) {
    return ok({ kind: 'write', summary: `The ${id} app's commands were never enabled: nothing to do.`, edits: [] } satisfies Outcome);
  }
  const record: CliAppRecord = { enabled: false, trusted: false, sha256: app?.sha256 ?? known.sha256, network: false };
  return ok({
    kind: 'write',
    summary: `Disable the ${id} app's CLI commands and withdraw trust.`,
    edits: [configEdit(schema, [{ kind: 'set', path: ['apps', id], value: record }])],
    notes: ['Its commands and settings files leave the CLI and the MCP tool list. The app itself is unchanged.'],
  } satisfies Outcome);
};

const list: Handler = (context) => {
  const project = loadProjectApps(context.root);
  const apps = project.apps
    .filter((app) => app.state.kind !== 'none')
    .map((app) => ({
      app: app.id,
      version: app.version,
      state: app.state.kind,
      ...(app.state.kind === 'active' || app.state.kind === 'none' ? {} : { reason: app.state.reason }),
      network: app.section?.network ?? false,
      networkApproved: app.record?.network === true,
      commands: (app.section?.commands ?? []).map((command) => ({
        command: `${app.id} ${command.name}`,
        tool: toolNameOf({ words: [app.id, command.name] }),
        description: command.description,
        access: command.writes ? 'write' : 'read',
        destructive: command.destructive,
        handler: command.handler.kind,
        ...(command.permission === undefined ? {} : { permission: command.permission }),
        inputs: command.inputs.map((input) => ({ name: input.name, kind: input.kind, required: input.required, description: input.description })),
        owns: command.owns.map((own) => ({ file: own.file, keys: own.keys.map((key) => key.text) })),
      })),
      files: (app.section?.files ?? []).map((file) => ({ id: file.id, file: file.path, description: file.description })),
    }));
  const active = apps.filter((app) => app.state === 'active').length;
  return ok({
    kind: 'read',
    summary: apps.length === 0 ? 'No installed app adds commands to the CLI.' : `${apps.length} apps declare CLI commands; ${active} active.`,
    result: { apps, ...(project.failure === undefined ? {} : { failure: project.failure }) },
  } satisfies Outcome);
};

export const APP_ADMIN_HANDLERS: Readonly<Record<string, Handler>> = {
  'apps enable': enable,
  'apps disable': disable,
  'apps commands': list,
};
