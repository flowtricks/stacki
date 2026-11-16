// Running one command from start to finish: project, role, permission, handler, plan, and (only with apply) the write.
//
// Every entry point (the shell, the MCP server, tests) calls `runCommand`, so a command behaves identically in all of them: the same refusals in
// the same order, the same JSON envelope, the same dry-run default. The order matters for safety: the role is checked before the handler runs, so a
// role that may not run a command learns nothing about what it would have changed.
import { err, ok, type Result } from '../../../shared/core/result';
import { COMMANDS, commandByWords, type CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import { CLI_SCHEMA_VERSION, type CliEnvelope, type CliError, type CliFailure, type PlannedFile } from '../../../shared/properties/cli/stackiOutput';
import { fileSchemaById, fileSchemaByPath, registerAppFiles } from '../../../shared/properties/cli/stackiFiles';
import type { CliAccessFeature } from '../../../shared/properties/cli/stackiFeatures';
import { applyStaged, DEFAULT_WRITER, planUndo, type FileWriter } from './cliApply';
import { describeEffect, type EffectApplier, type EffectRecord } from './cliEffects';
import { APP_ADMIN_HANDLERS } from './cliAppAdmin';
import { CORE_HANDLERS, schemaOfArgument, type Handler, type Outcome } from './cliCommands';
import { findProject } from './cliFiles';
import { appsAdd, appsRemove } from './cliAppsInstall';
import { plannedFiles, stage, type StagedFile } from './cliPlan';
import { fileDenial, resolveRoleContext, roleDenial, type RoleContext, type RoleRequest } from './cliRole';
import type { ExtensionProvider } from './cliExtensionTypes';
import { configEdit } from './cliPlan';

export interface RunRequest {
  readonly words: readonly string[];
  readonly args: Readonly<Record<string, unknown>>;
  /** The directory the command starts from; the project is the nearest ancestor with `.stacki` or an Astro config. */
  readonly project: string;
  readonly role: RoleRequest;
  readonly apply: 'apply' | 'plan';
  readonly yes: 'yes' | 'no';
  readonly waitSeconds: number;
  /** Tests replace the file writer to inject a failure. */
  readonly writer?: FileWriter;
  /** Tests replace the effect applier to inject a failure. */
  readonly effectApplier?: EffectApplier;
  /** Commands installed apps contribute (cliExtensions.ts); absent means none. */
  readonly extensions?: ExtensionProvider;
}

// Handlers registered at startup by modules that live where their planners do (electron/handlers/cliComponentCommands.ts); written only at load.
const registered = new Map<string, Handler>();

export function registerCommandHandler(name: string, handler: Handler): void {
  registered.set(name, handler);
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  ...CORE_HANDLERS,
  'apps add': appsAdd,
  'apps remove': appsRemove,
  ...APP_ADMIN_HANDLERS,
  'apps settings set': (context) => {
    const schema = fileSchemaById('appSettings');
    const [app, setting, value] = [context.args['app'], context.args['setting'], context.args['value']];
    if (schema === undefined || typeof app !== 'string' || typeof setting !== 'string' || typeof value !== 'string' || app === '' || setting === '') {
      return err({ code: 'usage', message: 'apps settings set <app> <setting> <value>' });
    }
    return ok({ kind: 'write', summary: `Set ${app} ${setting}.`, edits: [configEdit(schema, [{ kind: 'set', path: ['apps', app, setting], value }])] });
  },
};

const failure = (command: string, error: CliError): CliFailure => ({ schemaVersion: CLI_SCHEMA_VERSION, ok: false, command, error });

/** The feature a command needs for what it targets: roles, apps and trust files always need their own high-privilege feature. */
export function effectiveFeature(spec: CommandSpec, args: Readonly<Record<string, unknown>>): CliAccessFeature {
  if (spec.words[0] === 'config' && spec.access === 'write' && typeof args['file'] === 'string') {
    const schema = schemaOfArgument(args['file']);
    if (schema.ok && (schema.value.id === 'roles' || schema.value.id === 'cli')) {
      return 'cli:roles';
    }
    if (schema.ok && (schema.value.id === 'apps' || schema.value.id === 'appSettings' || schema.value.appId !== undefined)) {
      return 'cli:apps';
    }
  }
  return spec.feature;
}

/** The commands a role may run, for help and for the MCP tool list: a command the role cannot run is not shown to it. */
export function visibleCommands(role: RoleContext, extensions: ExtensionProvider | undefined): readonly CommandSpec[] {
  const allowed = COMMANDS.filter((spec) => roleDenial(role.view, spec.feature, spec.featureKey) === undefined);
  return [...allowed, ...(extensions?.commands(role) ?? [])];
}

export async function runCommand(request: RunRequest): Promise<CliEnvelope> {
  // The registry's app files are this run's: the provider's active apps, or none (stackiFiles.ts says why this is module state).
  registerAppFiles(request.extensions?.files ?? []);
  const name = request.words.join(' ');
  const spec = commandByWords(request.words) ?? request.extensions?.find(request.words);
  if (spec === undefined) {
    return failure(name, { code: 'usage', message: `Unknown command "${name}". Run "stacki --help".` });
  }
  const root = findProject(request.project);
  if (!root.ok) {
    return failure(name, root.error);
  }
  const role = resolveRoleContext(root.value, request.role);
  if (!role.ok) {
    return failure(name, role.error);
  }
  const denial = roleDenial(role.value.view, effectiveFeature(spec, request.args), spec.featureKey);
  if (denial !== undefined) {
    return failure(name, denial);
  }
  const appDenial = spec.appId === undefined ? undefined : request.extensions?.denial(role.value, spec);
  if (appDenial !== undefined) {
    return failure(name, appDenial);
  }
  if (name === 'undo') {
    return runUndo(request, root.value, role.value, spec);
  }
  const handler = HANDLERS[name] ?? registered.get(name) ?? request.extensions?.handler(request.words);
  if (handler === undefined) {
    return failure(name, {
      code: 'planner-unavailable',
      message: `"${name}" is not available yet: its planner (the rules shared with the app) is not in this build. Nothing was changed.`,
    });
  }
  let outcome: Result<Outcome, CliError>;
  try {
    outcome = await handler({ root: root.value, args: request.args });
  } catch (error: unknown) {
    return failure(name, { code: 'internal', message: `The command failed unexpectedly: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!outcome.ok) {
    return failure(name, outcome.error);
  }
  return finish(request, spec, root.value, role.value, outcome.value);
}

async function finish(request: RunRequest, spec: CommandSpec, root: string, role: RoleContext, outcome: Outcome): Promise<CliEnvelope> {
  const name = spec.words.join(' ');
  const base = {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: true as const,
    command: name,
    project: root,
    role: role.view.id,
    notes: outcome.notes ?? [],
    summary: outcome.summary,
  };
  if (outcome.kind === 'read') {
    return { ...base, mode: 'read', applied: false, files: [], result: outcome.result };
  }
  for (const edit of outcome.edits) {
    const refusal = fileDenial(role.view, edit.schema.requires, edit.schema.file);
    if (refusal !== undefined) {
      return failure(name, refusal);
    }
  }
  let staged: ReturnType<typeof stage>;
  try {
    staged = stage(root, outcome.edits);
  } catch (error: unknown) {
    // A planner that asserts on input it was never meant to get is a refusal here, not a crash of the shell or the MCP server.
    return failure(name, { code: 'refused', message: `The change was refused: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!staged.ok) {
    return failure(name, staged.error);
  }
  const effects = outcome.effects ?? [];
  for (const file of effects.flatMap(describeEffect)) {
    // Effects touching a settings file need the same access as editing it.
    const schema = fileSchemaByPath(file.file);
    const refusal = schema === undefined ? undefined : fileDenial(role.view, schema.requires, schema.file);
    if (refusal !== undefined) {
      return failure(name, refusal);
    }
  }
  return writeOrPlan(request, spec, root, base, staged.value, effects);
}

async function writeOrPlan(
  request: RunRequest,
  spec: CommandSpec,
  root: string,
  base: {
    readonly schemaVersion: number;
    readonly ok: true;
    readonly command: string;
    readonly project: string;
    readonly role: string;
    readonly notes: readonly string[];
    readonly summary: string;
  },
  staged: readonly StagedFile[],
  effects: readonly EffectRecord[],
): Promise<CliEnvelope> {
  const files: readonly PlannedFile[] = [...effects.flatMap(describeEffect), ...plannedFiles(staged)];
  const summary = staged.length === 0 && effects.length === 0 ? `${base.summary} No change: the files already hold this.` : base.summary;
  if (request.apply === 'plan' || (staged.length === 0 && effects.length === 0)) {
    return { ...base, summary, mode: 'plan', applied: false, files };
  }
  if (spec.destructive && request.yes !== 'yes') {
    return failure(base.command, {
      code: 'confirmation-required',
      message: `"${base.command}" removes things people made. Show the plan to the person; apply it with --apply --yes only when they approve.`,
    });
  }
  const applied = await applyStaged(root, base.command, staged, effects, {
    waitSeconds: request.waitSeconds,
    writer: request.writer ?? DEFAULT_WRITER,
    ...(request.effectApplier === undefined ? {} : { effects: request.effectApplier }),
  });
  if (!applied.ok) {
    return failure(base.command, applied.error);
  }
  return { ...base, mode: 'apply', applied: true, files, undoId: applied.value.undoId, summary };
}

async function runUndo(request: RunRequest, root: string, role: RoleContext, spec: CommandSpec): Promise<CliEnvelope> {
  const id = request.args['id'];
  const name = spec.words.join(' ');
  if (typeof id !== 'string') {
    return failure(name, { code: 'usage', message: 'undo <id>' });
  }
  const staged = planUndo(root, id);
  if (!staged.ok) {
    return failure(name, staged.error);
  }
  for (const file of staged.value.files) {
    const refusal = fileDenial(role.view, file.schema.requires, file.schema.file);
    if (refusal !== undefined) {
      return failure(name, refusal);
    }
  }
  return writeOrPlan(
    request,
    spec,
    root,
    { schemaVersion: CLI_SCHEMA_VERSION, ok: true, command: name, project: root, role: role.view.id, notes: [], summary: `Put back what ${id} changed.` },
    staged.value.files,
    staged.value.effects,
  );
}
