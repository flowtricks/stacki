// The core commands: each turns a command's arguments into a read result or into edits, using the app's own planners.
//
// A handler never writes. A read returns data; a write returns `Edit`s that the runner stages into a plan and, only with `--apply`, writes
// atomically (cliPlan.ts, cliApply.ts). The rules (what a breakpoint may be, what a folder may be, what hiding a component means) are the
// app's functions in shared/properties/, called here, never copied: the CLI and Settings cannot disagree about what is allowed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { toRecord } from '../../../shared/core/record';
import type { ConfigOperation } from '../../../shared/properties/cli/stackiConfigEdit';
import { parseConfigPath } from '../../../shared/properties/cli/stackiConfigPath';
import { readConfigValue } from '../../../shared/properties/cli/stackiConfigEdit';
import { accessFeatureOf } from '../../../shared/properties/cli/stackiFeatures';
import { allFiles, fileSchemaById, fileSchemaByPath, STACKI_DOMAIN_FOLDERS, STACKI_UNSETTABLE } from '../../../shared/properties/cli/stackiFiles';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { describeFileSchema } from '../../../shared/properties/cli/stackiDescribe';
import type { FileSchema } from '../../../shared/properties/cli/stackiSchema';
import {
  checkedConfig,
  checkedSetting,
  conflictAt,
  desktopBlocker,
  isBreakpointName,
  isBuiltinBreakpointId,
  nextBreakpointId,
  parseBreakpointsSource,
  serializeBreakpoints,
  withBreakpointAdded,
  withBreakpointName,
  withBreakpointRemoved,
  withDesktop,
  withSettingInPlace,
  BREAKPOINT_DEFAULT_CONFIG,
  type BreakpointConfig,
} from '../../../shared/properties/projectBreakpoints';
import { parseBreakpointSyncSource, serializeBreakpointSyncRecord, withoutEntry } from '../../../shared/properties/breakpointSyncRecord';
import {
  addFolder,
  configOf,
  foldersFor,
  knownFolderKind,
  PROJECT_FOLDER_KINDS,
  readProjectFoldersSource,
  removeFolder,
  serializeProjectFolders,
  withFolders,
  EMPTY_PROJECT_FOLDERS,
  type ProjectFolderKind,
} from '../../../shared/properties/projectFolders';
import {
  ADMIN_ROLE_ID,
  parseProjectRolesSource,
  roleIdFor,
  sameLogin,
  serializeProjectRoles,
  type AccessFeature,
  type ProjectRole,
  type ProjectRoles,
} from '../../../shared/properties/projectRoles';
import { setComponentState, parseComponentPath } from '../../../shared/properties/componentAccess';
import { configEdit, documentEdit, type Edit } from './cliPlan';
import type { EffectRecord } from './cliEffects';
import { documentOf, readFileState, type FileState } from './cliFiles';
import { loadRoles } from './cliRole';

export interface CommandContext {
  readonly root: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type Outcome =
  | {
      readonly kind: 'read';
      readonly result: unknown;
      readonly summary: string;
      readonly notes?: readonly string[];
      /** A read whose answer is a failure (a health check that found errors): the envelope fails with this error and still carries `result`. */
      readonly verdict?: CliError;
    }
  | {
      readonly kind: 'write';
      readonly edits: readonly Edit[];
      /** Changes that are not settings text (moves, created and removed files); applied before the edits, all or nothing. */
      readonly effects?: readonly EffectRecord[];
      readonly summary: string;
      readonly notes?: readonly string[];
      /** Facts a person needs to judge the plan that are not file changes (the places a breakpoint sync found); carried in the envelope. */
      readonly result?: unknown;
    };

export type Handler = (context: CommandContext) => Result<Outcome, CliError> | Promise<Result<Outcome, CliError>>;

const refused = (message: string, code: CliError['code'] = 'refused'): Result<never, CliError> => err({ code, message });
const text = (context: CommandContext, name: string): string => {
  const value = context.args[name];
  return typeof value === 'string' ? value : '';
};

/** The schema a command's `file` argument names: its id or its path. */
export function schemaOfArgument(name: string): Result<FileSchema, CliError> {
  const found = fileSchemaById(name) ?? fileSchemaByPath(name) ?? fileSchemaByPath(`.stacki/${name}`);
  if (found !== undefined) {
    return ok(found);
  }
  const folder = STACKI_DOMAIN_FOLDERS.find((entry) => name.startsWith(entry.path) || `.stacki/${name}`.startsWith(entry.path));
  if (folder !== undefined) {
    return err({
      code: 'unsupported-file',
      message: `${folder.path} is changed only by its commands (${folder.commands.map((command) => `stacki ${command}`).join(', ')}): ${folder.description}`,
    });
  }
  const unsettable = STACKI_UNSETTABLE.find((entry) => name.startsWith(entry.path) || `.stacki/${name}`.startsWith(entry.path));
  if (unsettable !== undefined) {
    return err({ code: 'unsupported-file', message: `${unsettable.path} is not settable: ${unsettable.reason}` });
  }
  return err({
    code: 'unknown-file',
    message: `"${name}" is not a settings file. Known: ${allFiles()
      .map((file) => file.id)
      .join(', ')}.`,
  });
}

function schemaCommand(context: CommandContext): Result<Outcome, CliError> {
  const name = text(context, 'file');
  if (name === '') {
    return ok({
      kind: 'read',
      summary: `${allFiles().length} settings files; run "stacki schema <file>" for the keys.`,
      result: {
        files: allFiles().map((file) => ({ id: file.id, file: file.file, description: file.description, requires: file.requires, commands: file.commands })),
        domainFolders: STACKI_DOMAIN_FOLDERS,
        notSettable: STACKI_UNSETTABLE,
      },
    });
  }
  const schema = schemaOfArgument(name);
  if (!schema.ok) {
    return schema;
  }
  return ok({ kind: 'read', summary: `${schema.value.file}: ${Object.keys(schema.value.fields).length} keys.`, result: describeFileSchema(schema.value) });
}

function configGet(context: CommandContext): Result<Outcome, CliError> {
  const schema = schemaOfArgument(text(context, 'file'));
  if (!schema.ok) {
    return schema;
  }
  const state = readFileState(context.root, schema.value);
  if (!state.ok) {
    return state;
  }
  const document = documentOf(state.value);
  if (!document.ok) {
    return document;
  }
  const path = parseConfigPath(text(context, 'path'));
  if (!path.ok) {
    return refused(path.error.message, 'bad-path');
  }
  const read = readConfigValue(schema.value, document.value, path.value);
  if (!read.ok) {
    return read;
  }
  return ok({
    kind: 'read',
    summary: `${schema.value.file} ${read.value.path}: ${read.value.present ? JSON.stringify(read.value.value) : 'not set'}`,
    result: { file: schema.value.file, exists: state.value.source !== undefined, ...read.value },
  });
}

function configWrite(kind: ConfigOperation['kind']): Handler {
  return (context) => {
    const schema = schemaOfArgument(text(context, 'file'));
    if (!schema.ok) {
      return schema;
    }
    const path = parseConfigPath(text(context, 'path'));
    if (!path.ok) {
      return refused(path.error.message, 'bad-path');
    }
    const value = context.args['value'];
    const operation = operationOf(kind, path.value, value, context.args['position']);
    if (!operation.ok) {
      return operation;
    }
    return ok({ kind: 'write', edits: [configEdit(schema.value, [operation.value])], summary: `${kind} ${schema.value.file} ${text(context, 'path')}` });
  };
}

function operationOf(kind: ConfigOperation['kind'], path: ConfigOperation['path'], value: unknown, position: unknown): Result<ConfigOperation, CliError> {
  switch (kind) {
    case 'set':
      return ok({ kind, path, value });
    case 'unset':
      return ok({ kind, path });
    case 'add':
      return ok({ kind, path, value, ...(typeof position === 'number' ? { position } : {}) });
    case 'remove':
      return ok({ kind, path, ...(value === undefined ? {} : { value }) });
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

// ----- guides -----

function sizeValue(input: string): Result<unknown, CliError> {
  if (/^--[A-Za-z0-9_-]+$/.test(input)) {
    return ok({ kind: 'variable', name: input });
  }
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(input);
  if (match === null) {
    return refused(`"${input}" is not a length (16px, 3rem), a project variable (--site-margin) or "default".`, 'invalid-value');
  }
  return ok({ kind: 'length', length: { amount: Number(match[1]), unit: match[2] } });
}

function guidesSet(context: CommandContext): Result<Outcome, CliError> {
  const guide = fileSchemaById('guide');
  if (guide === undefined) {
    return refused('The guide registry is missing.', 'internal');
  }
  const operations: ConfigOperation[] = [];
  for (const key of ['visible', 'numbers', 'color', 'opacity']) {
    if (context.args[key] !== undefined) {
      operations.push({ kind: 'set', path: ['settings', key], value: context.args[key] });
    }
  }
  const columns = text(context, 'columns');
  if (columns !== '') {
    const value = /^\d+$/.test(columns)
      ? { kind: 'count', count: Number(columns) }
      : columns === 'automatic'
        ? { kind: 'automatic' }
        : { kind: 'variable', name: columns };
    operations.push({ kind: 'set', path: ['settings', 'columns'], value });
  }
  for (const key of ['margin', 'gutter', 'widthMax']) {
    const input = text(context, key);
    if (input === 'default') {
      operations.push({ kind: 'unset', path: ['settings', key] });
    } else if (input !== '') {
      const size = sizeValue(input);
      if (!size.ok) {
        return size;
      }
      operations.push({ kind: 'set', path: ['settings', key], value: size.value });
    }
  }
  if (operations.length === 0) {
    return refused('Nothing to set: pass at least one of --visible, --numbers, --color, --opacity, --columns, --margin, --gutter, --width-max.', 'usage');
  }
  // A deliberate column choice is marked, as the app does, so the project default does not replace it.
  const marked: readonly ConfigOperation[] = operations.some((operation) => operation.path[1] === 'columns')
    ? [...operations, { kind: 'set', path: ['settings', 'columnDefaultsVersion'], value: 1 }]
    : operations;
  return ok({ kind: 'write', edits: [configEdit(guide, marked)], summary: 'Set the column guide.' });
}

function guidesClear(context: CommandContext): Result<Outcome, CliError> {
  const guide = fileSchemaById('guide');
  if (guide === undefined) {
    return refused('The guide registry is missing.', 'internal');
  }
  const field = text(context, 'field');
  if (field === 'all') {
    return ok({ kind: 'write', edits: [documentEdit(guide, () => ok({ ...guide.empty }))], summary: 'Reset the column guide to its defaults.' });
  }
  return ok({ kind: 'write', edits: [configEdit(guide, [{ kind: 'unset', path: ['settings', field] }])], summary: `Reset the guide's ${field}.` });
}

// ----- breakpoints -----

function breakpointConfig(state: FileState): Result<BreakpointConfig, CliError> {
  const parsed = parseBreakpointsSource(state.source);
  return parsed.ok ? ok(parsed.value) : refused(parsed.error.message, 'invalid-file');
}

function breakpointEdit(extra: readonly Edit[], change: (config: BreakpointConfig) => Result<BreakpointConfig, CliError>): Result<readonly Edit[], CliError> {
  const schema = fileSchemaById('breakpoints');
  if (schema === undefined) {
    return refused('The breakpoints registry is missing.', 'internal');
  }
  const edit: Edit = {
    schema,
    produce: (state) => {
      const config = state.source === undefined ? ok(BREAKPOINT_DEFAULT_CONFIG) : breakpointConfig(state);
      if (!config.ok) {
        return config;
      }
      const next = change(config.value);
      if (!next.ok) {
        return next;
      }
      const checked = checkedConfig(next.value);
      return checked.ok ? ok(serializeBreakpoints(checked.value)) : refused(checked.error.message, 'invalid-value');
    },
  };
  return ok([edit, ...extra]);
}

function breakpointsSet(context: CommandContext): Result<Outcome, CliError> {
  const id = text(context, 'id');
  const edits = breakpointEdit([], (config) => {
    let next = config;
    const requested = context.args['value'] !== undefined || context.args['unit'] !== undefined;
    if (requested) {
      const current = id === 'desktop' ? config.desktop : config.list.find((entry) => entry.id === id)?.setting;
      if (current === undefined) {
        return refused(`There is no breakpoint "${id}" (ids: desktop, ${config.list.map((entry) => entry.id).join(', ')}).`, 'missing');
      }
      const setting = checkedSetting({ value: context.args['value'] ?? current.value, unit: context.args['unit'] ?? current.unit });
      if (!setting.ok) {
        return refused(setting.error.message, 'invalid-value');
      }
      if (id === 'desktop') {
        const blocker = desktopBlocker(config, setting.value);
        if (blocker !== undefined) {
          return refused(`Desktop cannot move there: it would pass the "${blocker.name ?? blocker.id}" breakpoint.`, 'invalid-value');
        }
        next = withDesktop(config, setting.value);
      } else {
        next = withSettingInPlace(config, id, setting.value);
        const conflict = conflictAt(next, id);
        if (conflict !== undefined) {
          return refused(`"${id}" must stay ${conflict.relation} than "${conflict.against.id}".`, 'invalid-value');
        }
      }
    }
    const name = text(context, 'name');
    if (name !== '') {
      if (id === 'desktop') {
        return refused('Desktop has no name to set.', 'invalid-value');
      }
      if (name !== 'default' && !isBreakpointName(name)) {
        return refused('A breakpoint name is 1 to 24 characters without control characters.', 'invalid-value');
      }
      next = withBreakpointName(next, id, name === 'default' ? undefined : name);
    }
    return requested || name !== '' ? ok(next) : refused('Nothing to set: pass --value, --unit or --name.', 'usage');
  });
  return edits.ok
    ? ok({
        kind: 'write',
        edits: edits.value,
        summary: `Change breakpoint ${id}.`,
        notes: ['Media queries that hold the old boundary are not changed. To move them too, use "stacki breakpoints sync <id> --value <n>" instead.'],
      })
    : edits;
}

function breakpointsAdd(context: CommandContext): Result<Outcome, CliError> {
  const name = text(context, 'name');
  if (!isBreakpointName(name)) {
    return refused('A breakpoint name is 1 to 24 characters without control characters.', 'invalid-value');
  }
  const setting = checkedSetting({ value: context.args['value'], unit: context.args['unit'] });
  if (!setting.ok) {
    return refused(setting.error.message, 'invalid-value');
  }
  const edits = breakpointEdit([], (config) => {
    if (config.list.length >= 11) {
      return refused('A project has at most 11 breakpoints.', 'invalid-value');
    }
    return ok(withBreakpointAdded(config, { id: nextBreakpointId(config.list), name, setting: setting.value }));
  });
  return edits.ok ? ok({ kind: 'write', edits: edits.value, summary: `Add breakpoint "${name}".` }) : edits;
}

function breakpointsRemove(context: CommandContext): Result<Outcome, CliError> {
  const id = text(context, 'id');
  if (isBuiltinBreakpointId(id)) {
    return refused(`"${id}" is built in and cannot be removed.`, 'invalid-value');
  }
  const syncSchema = fileSchemaById('breakpointSync');
  const sync: readonly Edit[] =
    syncSchema === undefined
      ? []
      : [
          {
            schema: syncSchema,
            produce: (state) => {
              if (state.source === undefined) {
                return ok(undefined);
              }
              const record = parseBreakpointSyncSource(state.source);
              return record.ok ? ok(serializeBreakpointSyncRecord(withoutEntry(record.value, id))) : refused(record.error.message, 'invalid-file');
            },
          },
        ];
  const edits = breakpointEdit(sync, (config) =>
    config.list.some((entry) => entry.id === id) ? ok(withBreakpointRemoved(config, id)) : refused(`There is no breakpoint "${id}".`, 'missing'),
  );
  return edits.ok ? ok({ kind: 'write', edits: edits.value, summary: `Remove breakpoint ${id} and forget its remembered sync choices.` }) : edits;
}

// ----- roles -----

function rolesEdit(change: (roles: ProjectRoles) => Result<ProjectRoles, CliError>): Result<readonly Edit[], CliError> {
  const schema = fileSchemaById('roles');
  if (schema === undefined) {
    return refused('The roles registry is missing.', 'internal');
  }
  return ok([
    {
      schema,
      produce: (state) => {
        if (state.source === undefined) {
          return refused(
            'The project has no .stacki/roles.json yet. Create it in Settings > Roles (it names the first admin), then use these commands.',
            'missing',
          );
        }
        let roles: ProjectRoles;
        try {
          roles = parseProjectRolesSource(state.source);
        } catch (error: unknown) {
          return refused(error instanceof Error ? error.message : String(error), 'invalid-file');
        }
        const next = change(roles);
        if (!next.ok) {
          return next;
        }
        try {
          return ok(serializeProjectRoles(next.value));
        } catch (error: unknown) {
          return refused(error instanceof Error ? error.message : String(error), 'invalid-value');
        }
      },
    },
  ]);
}

function withRole(roles: ProjectRoles, id: string, change: (role: ProjectRole) => ProjectRole): Result<ProjectRoles, CliError> {
  if (!roles.roles.some((role) => role.id === id)) {
    return refused(`"${id}" is not a role (${roles.roles.map((role) => role.id).join(', ')}).`, 'missing');
  }
  return ok({ ...roles, roles: roles.roles.map((role) => (role.id === id ? change(role) : role)) });
}

const rolesWrite = (spec: {
  readonly build: (context: CommandContext) => (roles: ProjectRoles) => Result<ProjectRoles, CliError>;
  readonly summary: (context: CommandContext) => string;
}): Handler => {
  return (context) => {
    const edits = rolesEdit(spec.build(context));
    return edits.ok ? ok({ kind: 'write', edits: edits.value, summary: spec.summary(context) }) : edits;
  };
};

const rolesAdd = rolesWrite({
  build: (context) => (roles) => {
    const name = text(context, 'name').trim();
    if (name === '') {
      return refused('A role needs a name.', 'invalid-value');
    }
    const id = roleIdFor(
      name,
      roles.roles.map((role) => role.id),
    );
    return ok({ ...roles, roles: [...roles.roles, { id, name, members: [], access: ['cli:read'], appPermissions: {}, pinnedApps: [], componentRules: [] }] });
  },
  summary: (context) => `Add role "${text(context, 'name')}".`,
});

const rolesRemove = rolesWrite({
  build: (context) => (roles) => {
    const id = text(context, 'role');
    if (id === ADMIN_ROLE_ID) {
      return refused('The admin role cannot be removed.', 'invalid-value');
    }
    if (!roles.roles.some((role) => role.id === id)) {
      return refused(`"${id}" is not a role.`, 'missing');
    }
    return ok({ ...roles, defaultRole: roles.defaultRole === id ? ADMIN_ROLE_ID : roles.defaultRole, roles: roles.roles.filter((role) => role.id !== id) });
  },
  summary: (context) => `Remove role ${text(context, 'role')}.`,
});

const membersAdd = rolesWrite({
  build: (context) => (roles) => {
    const login = text(context, 'login');
    const cleared: ProjectRoles = {
      ...roles,
      roles: roles.roles.map((role) => ({ ...role, members: role.members.filter((member) => !sameLogin(member, login)) })),
    };
    return withRole(cleared, text(context, 'role'), (role) => ({ ...role, members: [...role.members, login] }));
  },
  summary: (context) => `Add ${text(context, 'login')} to ${text(context, 'role')}.`,
});

const membersRemove = rolesWrite({
  build: (context) => (roles) =>
    withRole(roles, text(context, 'role'), (role) => ({ ...role, members: role.members.filter((member) => !sameLogin(member, text(context, 'login'))) })),
  summary: (context) => `Remove ${text(context, 'login')} from ${text(context, 'role')}.`,
});

function accessChange(context: CommandContext, change: 'grant' | 'revoke'): (roles: ProjectRoles) => Result<ProjectRoles, CliError> {
  return (roles) => {
    const feature = accessFeatureOf(text(context, 'feature'));
    if (feature === undefined) {
      return refused(`"${text(context, 'feature')}" is not an access feature; run "stacki schema roles".`, 'invalid-value');
    }
    if (text(context, 'role') === ADMIN_ROLE_ID) {
      return refused('Admin always has every feature; its access list is not stored.', 'invalid-value');
    }
    return withRole(roles, text(context, 'role'), (role) => {
      const rest: readonly AccessFeature[] = role.access.filter((entry) => entry !== feature);
      return { ...role, access: change === 'grant' ? [...rest, feature] : rest };
    });
  };
}

const accessGrant = rolesWrite({
  build: (context) => accessChange(context, 'grant'),
  summary: (context) => `Grant ${text(context, 'feature')} to ${text(context, 'role')}.`,
});
const accessRevoke = rolesWrite({
  build: (context) => accessChange(context, 'revoke'),
  summary: (context) => `Revoke ${text(context, 'feature')} from ${text(context, 'role')}.`,
});

function componentState(context: CommandContext, state: 'hidden' | 'visible'): (roles: ProjectRoles) => Result<ProjectRoles, CliError> {
  return (roles) => {
    let target: string;
    try {
      target = parseComponentPath(text(context, 'path'));
    } catch (error: unknown) {
      return refused(error instanceof Error ? error.message : String(error), 'invalid-value');
    }
    const kind = target.endsWith('.astro') ? 'component' : 'folder';
    return withRole(roles, text(context, 'role'), (role) => ({
      ...role,
      componentRules: setComponentState(role.componentRules, { kind, path: target }, state),
    }));
  };
}

const componentsHide = rolesWrite({
  build: (context) => componentState(context, 'hidden'),
  summary: (context) => `Hide ${text(context, 'path')} from ${text(context, 'role')}.`,
});
const componentsShow = rolesWrite({
  build: (context) => componentState(context, 'visible'),
  summary: (context) => `Show ${text(context, 'path')} to ${text(context, 'role')}.`,
});

// ----- folders -----

function foldersWrite(
  change: (
    config: ReturnType<typeof configOf>,
    context: CommandContext,
  ) => Result<import('../../../shared/properties/projectFolders').ProjectFolders, CliError>,
  summary: (context: CommandContext) => string,
): Handler {
  return (context) => {
    const schema = fileSchemaById('folders');
    if (schema === undefined) {
      return refused('The folders registry is missing.', 'internal');
    }
    return ok({
      kind: 'write',
      summary: summary(context),
      edits: [
        {
          schema,
          produce: (state) => {
            const next = change(configOf(readProjectFoldersSource(state.source)), context);
            return next.ok ? ok(serializeProjectFolders(next.value)) : next;
          },
        },
      ],
    });
  };
}

function kindOf(context: CommandContext): ProjectFolderKind {
  const kind = knownFolderKind(text(context, 'kind'));
  return kind ?? PROJECT_FOLDER_KINDS[0];
}

const foldersAdd = foldersWrite(
  (config, context) => {
    const added = addFolder(config, kindOf(context), text(context, 'folder'));
    return added.ok ? ok(added.value) : refused(added.error, 'invalid-value');
  },
  (context) => `Add folder ${text(context, 'folder')} to ${text(context, 'kind')}.`,
);
const foldersRemove = foldersWrite(
  (config, context) =>
    foldersFor(kindOf(context), config).includes(text(context, 'folder'))
      ? ok(removeFolder(config, kindOf(context), text(context, 'folder')))
      : refused(
          `${text(context, 'folder')} is not one of the ${text(context, 'kind')} folders (${foldersFor(kindOf(context), config).join(', ')}).`,
          'missing',
        ),
  (context) => `Remove folder ${text(context, 'folder')} from ${text(context, 'kind')}.`,
);
const foldersReset = foldersWrite(
  (config, context) => ok(withFolders(config ?? EMPTY_PROJECT_FOLDERS, kindOf(context), undefined)),
  (context) => `Reset ${text(context, 'kind')} to the default folders.`,
);

// ----- reads: list, doctor -----

function listCommand(context: CommandContext): Result<Outcome, CliError> {
  const what = text(context, 'what');
  const read = (id: string): Result<FileState, CliError> => {
    const schema = fileSchemaById(id);
    return schema === undefined ? refused(`No registry for ${id}.`, 'internal') : readFileState(context.root, schema);
  };
  switch (what) {
    case 'guides': {
      const state = read('guide');
      if (!state.ok) {
        return state;
      }
      const document = documentOf(state.value);
      return document.ok
        ? ok({
            kind: 'read',
            summary: 'Column guide settings.',
            result: { exists: state.value.source !== undefined, settings: toRecord(document.value['settings']) ?? {} },
          })
        : document;
    }
    case 'breakpoints': {
      const state = read('breakpoints');
      if (!state.ok) {
        return state;
      }
      const config = state.value.source === undefined ? ok(BREAKPOINT_DEFAULT_CONFIG) : breakpointConfig(state.value);
      return config.ok
        ? ok({
            kind: 'read',
            summary: `${config.value.list.length} breakpoints around desktop.`,
            result: { exists: state.value.source !== undefined, desktop: config.value.desktop, breakpoints: config.value.list },
          })
        : config;
    }
    case 'roles': {
      const roles = loadRoles(context.root);
      if (!roles.ok) {
        return roles;
      }
      return ok({
        kind: 'read',
        summary: roles.value === undefined ? 'No roles file: everyone is the owner.' : `${roles.value.roles.length} roles.`,
        result: {
          exists: roles.value !== undefined,
          defaultRole: roles.value?.defaultRole,
          roles: (roles.value?.roles ?? []).map((role) => ({
            id: role.id,
            name: role.name,
            members: role.members.length,
            access: role.access,
            componentRules: role.componentRules.length,
          })),
        },
      });
    }
    case 'folders': {
      const state = read('folders');
      if (!state.ok) {
        return state;
      }
      const config = configOf(readProjectFoldersSource(state.value.source));
      return ok({
        kind: 'read',
        summary: 'Project folders by kind.',
        result: Object.fromEntries(PROJECT_FOLDER_KINDS.map((kind) => [kind, foldersFor(kind, config)])),
      });
    }
    case 'apps': {
      const state = read('apps');
      if (!state.ok) {
        return state;
      }
      const document = documentOf(state.value);
      const apps = document.ok ? (Array.isArray(document.value['apps']) ? document.value['apps'] : []) : [];
      return ok({ kind: 'read', summary: `${apps.length} installed apps.`, result: { exists: state.value.source !== undefined, apps } });
    }
    case 'components': {
      const state = read('folders');
      if (!state.ok) {
        return state;
      }
      const folders = foldersFor('components', configOf(readProjectFoldersSource(state.value.source)));
      const files = componentFiles(context.root, folders);
      return ok({ kind: 'read', summary: `${files.length} components in ${folders.join(', ')}.`, result: { folders, components: files } });
    }
    default:
      return refused(`Unknown list "${what}".`, 'usage');
  }
}

// Every component is listed, at any depth (owner rule: no hard limit that stops a big project). The walk is bounded by the folder tree itself:
// it never follows a symbolic link (a Dirent from readdir does not), so a link cycle cannot loop it, and each real directory is read once.
function componentFiles(root: string, folders: readonly string[]): readonly string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  // Depth first, in name order: the stack holds folders still to read, last pushed first.
  const pending: string[] = [...folders].reverse().map((folder) => folder.replace(/\/$/, ''));
  while (pending.length > 0) {
    const directory = pending.pop();
    assert(directory !== undefined, 'A pending folder exists while the stack is not empty');
    let real: string;
    let entries: fs.Dirent[];
    try {
      real = fs.realpathSync(path.join(root, directory));
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      continue;
    }
    if (visited.has(real)) {
      continue;
    }
    visited.add(real);
    const children: string[] = [];
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        children.push(relative);
      } else if (entry.isFile() && entry.name.endsWith('.astro')) {
        found.push(relative);
      }
    }
    pending.push(...children.reverse());
  }
  assert(
    found.every((file) => file.endsWith('.astro')),
    'Only component files are listed',
  );
  return found;
}

function doctorCommand(context: CommandContext): Result<Outcome, CliError> {
  const findings: Array<{ readonly file: string; readonly level: 'error' | 'warning' | 'ok'; readonly message: string }> = [];
  for (const schema of allFiles()) {
    const state = readFileState(context.root, schema);
    if (!state.ok) {
      findings.push({ file: schema.file, level: 'error', message: state.error.message });
      continue;
    }
    if (state.value.source === undefined) {
      continue;
    }
    findings.push(...checkFile(schema, state.value.source));
  }
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.filter((finding) => finding.level === 'warning').length;
  const summary = errors === 0 ? `Healthy: no errors${warnings === 0 ? '' : `, ${warnings} warnings`}.` : `${errors} errors, ${warnings} warnings.`;
  // Errors fail the command (exit 1), so CI can gate on "stacki doctor"; warnings alone do not. The findings travel either way.
  const verdict: CliError | undefined =
    errors === 0
      ? undefined
      : {
          code: 'invalid-file',
          message: `${summary} ${findings
            .filter((finding) => finding.level === 'error')
            .map((finding) => `${finding.file}: ${finding.message}`)
            .join('; ')}`,
        };
  return ok({
    kind: 'read',
    summary,
    result: { healthy: errors === 0, errors, warnings, findings },
    notes: ['Selector usage and component-default catalog checks need the component scan: run "astro-studio check-project" for those.'],
    ...(verdict === undefined ? {} : { verdict }),
  });
}

import { checkFile } from './cliDoctor';
import { breakpointsSync } from './cliBreakpointSync';

export const CORE_HANDLERS: Readonly<Record<string, Handler>> = {
  schema: schemaCommand,
  list: listCommand,
  doctor: doctorCommand,
  'config get': configGet,
  'config set': configWrite('set'),
  'config unset': configWrite('unset'),
  'config add': configWrite('add'),
  'config remove': configWrite('remove'),
  'guides set': guidesSet,
  'guides clear': guidesClear,
  'breakpoints set': breakpointsSet,
  'breakpoints sync': breakpointsSync,
  'breakpoints add': breakpointsAdd,
  'breakpoints remove': breakpointsRemove,
  'roles add': rolesAdd,
  'roles remove': rolesRemove,
  'roles members add': membersAdd,
  'roles members remove': membersRemove,
  'roles access grant': accessGrant,
  'roles access revoke': accessRevoke,
  'roles components hide': componentsHide,
  'roles components show': componentsShow,
  'folders add': foldersAdd,
  'folders remove': foldersRemove,
  'folders reset': foldersReset,
};
