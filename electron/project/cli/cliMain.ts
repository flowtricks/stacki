// The `stacki` program: argument reading, output, exit codes. Everything else is in cliRun.ts so the MCP server and the tests share it.
//
// Roles on a shell are a COOPERATIVE guardrail (docs/stacki-cli.md): `--as-role` and `--login` choose the role this command acts as, and
// anyone who can run the CLI as the project owner can choose another. The real enforcement is the Studio server.
import { parseLine } from '../../../shared/properties/cli/stackiArgs';
import { COMMANDS } from '../../../shared/properties/cli/stackiCommands';
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

export async function helpText(project: string, request: { readonly role?: string | undefined; readonly login?: string | undefined }): Promise<string> {
  const root = findProject(project);
  const rows = (specs: typeof COMMANDS): string =>
    specs.map((spec) => `  stacki ${spec.words.join(' ').padEnd(26)} ${spec.access === 'write' ? '[writes] ' : '         '}${spec.summary}`).join('\n');
  if (!root.ok) {
    return `${HELP_HEADER}Commands:\n${rows(COMMANDS)}\n`;
  }
  const role = resolveRoleContext(root.value, request);
  const extensions = await loadExtensions(root.value);
  const specs = role.ok ? visibleCommands(role.value, extensions) : COMMANDS;
  return `${HELP_HEADER}Commands${role.ok ? ` for role "${role.value.view.id}"` : ''}:\n${rows(specs)}\n  stacki mcp --role <role>      Run an MCP server over these commands, pinned to a role.\n`;
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
  if (parsed.value === 'top-help' || parsed.value.options.help === 'help') {
    write(await helpText(cwd, parsed.value === 'top-help' ? {} : { role: parsed.value.options.role, login: parsed.value.options.login }));
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
