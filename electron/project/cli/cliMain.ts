// The `stacki` program: argument reading, output, exit codes. Everything else is in cliRun.ts so the MCP server and the tests share it.
//
// Roles on a shell are a COOPERATIVE guardrail (docs/stacki-cli.md): `--as-role` and `--login` choose the role this command acts as, and
// anyone who can run the CLI as the project owner can choose another. The real enforcement is the Studio server.
import { parseLine, spellingOf, usageOf } from '../../../shared/properties/cli/stackiArgs';
import { COMMANDS, toolNameOf, type CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import { exitCodeOf, CLI_SCHEMA_VERSION, type CliEnvelope } from '../../../shared/properties/cli/stackiOutput';
import { findProject } from './cliFiles';
import { runCommand, visibleCommands } from './cliRun';
import { resolveRoleContext } from './cliRole';
import { loadExtensions } from './cliExtensions';
import type { ExtensionProvider } from './cliExtensionTypes';
import { startMcpServer } from './mcpServer';

export const HELP_HEADER = [
  'stacki: edit the .stacki settings of an Astro project safely.',
  '',
  'Every write command is a DRY RUN that prints its plan. Add --apply to write; commands that delete also need --yes.',
  'Options: --project <dir>  --json  --apply  --yes  --wait <seconds>  --as-role <role>  --login <github-login>',
  'Exit codes: 0 ok, 1 refused (nothing written), 2 usage, 3 locked or conflict (retry), 4 write failed (rolled back), 5 role denied.',
  '',
  'Roles are a cooperative guardrail on a local machine: anyone who can run this command as the project owner can pick another role or edit',
  '.stacki/roles.json. Enforcement for a team is the Studio server, which resolves the signed-in identity.',
  '',
].join('\n');

const MCP_ROW = '  stacki mcp [--role <role>]      Run an MCP server over these commands, pinned to a role.';

/**
 * Help for the whole table (no words), a group (`roles`) or one command (`breakpoints sync`), listing only what the chosen role may run.
 * `project` is the directory the line works in (its `--project`, else the current directory).
 */
export async function helpText(
  project: string,
  request: { readonly role?: string | undefined; readonly login?: string | undefined },
  words: readonly string[] = [],
): Promise<string> {
  const root = findProject(project);
  const role = root.ok ? resolveRoleContext(root.value, request) : undefined;
  const extensions = root.ok ? await loadExtensions(root.value) : undefined;
  const all: readonly CommandSpec[] = [...COMMANDS, ...(extensions?.declared ?? [])];
  const visible: readonly CommandSpec[] = role?.ok === true ? visibleCommands(role.value, extensions) : COMMANDS;
  const roleLabel = role?.ok === true ? ` for role "${role.value.view.id}"` : '';
  const problem = role !== undefined && !role.ok ? `note: ${role.error.message}\n` : '';
  const exact = words.length === 0 ? undefined : all.find((spec) => sameWords(spec.words, words));
  if (exact !== undefined) {
    const allowed = visible.some((spec) => sameWords(spec.words, words));
    return `${problem}${commandHelp(exact, allowed ? 'allowed' : 'denied', role?.ok === true ? role.value.view.id : 'admin')}`;
  }
  const group = visible.filter((spec) => words.every((word, index) => spec.words[index] === word));
  if (words.length > 0 && group.length > 0) {
    return `${problem}Commands under "stacki ${words.join(' ')}"${roleLabel}:\n${rows(group)}\nRun "stacki <command> --help" for a command's arguments.\n`;
  }
  return `${problem}${HELP_HEADER}Commands${roleLabel}:\n${rows(visible)}\n${MCP_ROW}\nRun "stacki <command> --help" for a command's arguments.\n`;
}

function rows(specs: readonly CommandSpec[]): string {
  return specs.map((spec) => `  stacki ${spec.words.join(' ').padEnd(26)} ${spec.access === 'write' ? '[writes] ' : '         '}${spec.summary}`).join('\n');
}

function sameWords(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((word, index) => word === second[index]);
}

/** One command's help: its usage line, what it does, its arguments, its access and the options every command takes. */
export function commandHelp(spec: CommandSpec, access: 'allowed' | 'denied', roleId: string): string {
  const lines = [`Usage: ${usageOf(spec)}`, '', spec.summary, ''];
  if (spec.args.length > 0) {
    lines.push('Arguments:');
    for (const argument of spec.args) {
      lines.push(`  ${spellingOf(argument).padEnd(28)} ${argument.required ? '(required) ' : ''}${argument.description}`);
    }
    lines.push('');
  }
  const writes =
    spec.access === 'write'
      ? `Writes files: a dry run that prints its plan unless --apply is given${spec.destructive ? '; it deletes, so it also needs --yes' : ''}.`
      : 'Reads only: never writes a file.';
  lines.push(writes, `Feature: ${spec.feature} (${spec.featureKey}). MCP tool: ${toolNameOf(spec)}.`);
  if (access === 'denied') {
    lines.push(`Role "${roleId}" may not run this command: it needs ${spec.feature}.`);
  }
  lines.push('Options on every command: --project <dir>  --json  --apply  --yes  --wait <seconds>  --as-role <role>  --login <github-login>', '');
  return lines.join('\n');
}

export function formatText(envelope: CliEnvelope): string {
  if (!envelope.ok) {
    return `Refused (${envelope.error.code}): ${envelope.error.message}\n`;
  }
  const lines = [envelope.summary];
  for (const file of envelope.files) {
    lines.push(`  ${file.action} ${file.file}`);
    for (const change of file.changes) {
      lines.push(`    ${change.path === '' ? '(file)' : change.path}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
    }
  }
  if (envelope.result !== undefined) {
    lines.push(JSON.stringify(envelope.result, undefined, 2));
  }
  for (const note of envelope.notes) {
    lines.push(`note: ${note}`);
  }
  if (envelope.mode === 'plan' && envelope.files.length > 0) {
    lines.push('This is a plan: nothing was written. Add --apply to write it.');
  }
  if (envelope.undoId !== undefined) {
    lines.push(`Undo with: stacki undo ${envelope.undoId}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Runs the program; returns its exit code. `write` receives stdout text. */
export async function main(argv: readonly string[], cwd: string, write: (text: string) => void): Promise<number> {
  if (argv[0] === 'mcp') {
    return startMcpServer(argv.slice(1), cwd);
  }
  if (argv[0] === '--version') {
    write('stacki 1\n');
    return 0;
  }
  // The apps' commands are part of the table this line is read against, so the project is found first (from --project, else the cwd).
  const extensions = await loadExtensions(projectOf(argv, cwd));
  const parsed = parseLine(argv, extensions?.declared ?? []);
  if (!parsed.ok) {
    const failed: CliEnvelope = { schemaVersion: CLI_SCHEMA_VERSION, ok: false, command: argv.join(' '), error: parsed.error };
    write(argv.includes('--json') ? `${JSON.stringify(failed)}\n` : formatText(failed));
    return exitCodeOf(failed);
  }
  if (parsed.value.kind === 'help') {
    const { options, words } = parsed.value;
    write(await helpText(options.project ?? cwd, { role: options.role, login: options.login ?? process.env['STACKI_LOGIN'] }, words));
    return 0;
  }
  const { spec, args, options } = parsed.value;
  const envelope = await runCommand({
    words: spec.words,
    args,
    project: options.project ?? cwd,
    role: { role: options.role, login: options.login ?? process.env['STACKI_LOGIN'] },
    apply: options.apply,
    yes: options.yes,
    waitSeconds: options.waitSeconds,
    ...extensionsFor(extensions),
  });
  write(options.json === 'json' ? `${JSON.stringify(envelope)}\n` : formatText(envelope));
  return exitCodeOf(envelope);
}

/** The directory a line works in: the value of `--project` when it is named, else the current directory. */
function projectOf(argv: readonly string[], cwd: string): string {
  const flag = argv.findIndex((token) => token === '--project' || token.startsWith('--project='));
  const token = argv[flag] ?? '';
  return flag < 0 ? cwd : token.startsWith('--project=') ? token.slice('--project='.length) : (argv[flag + 1] ?? cwd);
}

function extensionsFor(provider: ExtensionProvider | undefined): { readonly extensions?: ExtensionProvider } {
  return provider === undefined ? {} : { extensions: provider };
}
