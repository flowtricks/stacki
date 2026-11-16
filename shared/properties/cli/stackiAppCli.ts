// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// The `cli` section of an app's manifest (`stacki-app.json`): the commands and settings files an installed app adds to the Stacki CLI.
//
// What an app may declare, and why it is this small:
//   - `commands`: each is a row of the command table under the app's own namespace (`stacki <appId> <name>`), with inputs in a small JSON-schema-like
//     DSL (string, integer, number, boolean, enum), whether it writes, and a handler that is either DECLARATIVE (a fixed list of config operations
//     on keys the command owns: no code) or a MODULE (the app's own JS file, run by the CLI in a child process under Node's permission model).
//   - `files`: the app's OWN settings files, with their keys in the DSL of shared/properties/cli/stackiSchema.ts written as JSON. They join the
//     registry that powers `stacki schema` and `stacki config`, so everything an app lets a person set is listed, typed and bounded.
//   - `network`: a declaration only (see electron/project/cli/cliAppModule.ts for what the platform cannot enforce).
// Why parsed apart from `parseAppManifest` (shared/properties/apps.ts): a malformed `cli` section must disable the app's COMMANDS, never the app,
// so the manifest parser, which refuses a whole manifest, does not read it; this module reads the same file's `cli` value and answers with a
// value (`none`, `ready`, `refused` with the reason) that `stacki apps commands` shows. Every list and string here is bounded (AGENTS.md section 10).
import { toArray, toRecord } from '../../core/record';
import { parseBundlePath } from '../apps';
import { parseConfigPath, type PathSegment } from './stackiConfigPath';
import { appFilePathProblem, APP_FILE_LIMITS, STACKI_FILES } from './stackiFiles';
import type { ArgKind, ArgSpec, CommandSpec } from './stackiCommands';
import { checkValue, SCHEMA_LIMITS, settableKeys, type FieldSchema, type FileSchema, type ValueSchema } from './stackiSchema';

export const APP_CLI_API_VERSION = 1;

export const APP_CLI_LIMITS = {
  commandsMax: 32,
  inputsMax: 16,
  ownsMax: 8,
  ownedKeysMax: 16,
  operationsMax: 16,
  /** Operations a module handler may answer with in one call. */
  moduleOperationsMax: 256,
  /** A command or file description, one line. */
  descriptionCharsMax: 200,
  commandNameCharsMax: 32,
  inputNameCharsMax: 32,
  /** A tool name is `stacki_<appId>_<command>`; MCP clients bound tool names at 64 characters. */
  toolNameCharsMax: 64,
  /** Nodes in one declared schema (every field and nested value together). */
  schemaNodesMax: 256,
  stringCharsMax: 4096,
  patternCharsMax: 200,
  listItemsMax: 256,
  enumValuesMax: 32,
  enumValueCharsMax: 64,
  literalValueJsonCharsMax: 4096,
  timeoutSecondsMax: 30,
  timeoutSecondsDefault: 10,
} as const satisfies Record<string, number>;

/** Core files an app may never own, so no app command can grant itself or anyone else access: roles, the trust record and the apps lock. */
export const APP_FORBIDDEN_OWNS: readonly string[] = ['roles', 'cli', 'apps'];

/** Option names every command line and tool call already uses; an app input may not shadow them. */
const RESERVED_INPUTS: readonly string[] = ['apply', 'yes', 'project', 'role', 'asRole', 'login', 'json', 'help', 'wait', 'plan'];

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;
const INPUT_NAME = /^[a-z][a-zA-Z0-9]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CLI_APP_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface AppCliInput {
  readonly name: string;
  readonly kind: Exclude<ArgKind, 'json'>;
  readonly description: string;
  readonly required: boolean;
  /** The bounds the argument parser does not know (length, range, pattern): checked again before the handler runs. */
  readonly schema: ValueSchema;
  readonly values?: readonly string[];
}

export type AppCliValue = { readonly kind: 'literal'; readonly value: unknown } | { readonly kind: 'input'; readonly name: string };

export type AppCliOperationKind = 'set' | 'unset' | 'add' | 'remove';

export interface AppCliOperation {
  readonly op: AppCliOperationKind;
  readonly file: string;
  readonly path: string;
  readonly segments: readonly PathSegment[];
  readonly value?: AppCliValue;
}

export interface AppCliOwn {
  readonly file: string;
  readonly keys: readonly { readonly text: string; readonly segments: readonly PathSegment[] }[];
}

export type AppCliHandler =
  | { readonly kind: 'declarative'; readonly operations: readonly AppCliOperation[] }
  | { readonly kind: 'module'; readonly entry: string; readonly timeoutSeconds: number };

export interface AppCliCommand {
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly AppCliInput[];
  readonly writes: boolean;
  readonly destructive: boolean;
  readonly permission?: string;
  readonly owns: readonly AppCliOwn[];
  readonly handler: AppCliHandler;
}

export interface AppCliFile {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly fields: Readonly<Record<string, FieldSchema>>;
}

export interface AppCliSection {
  readonly apiVersion: 1;
  readonly commands: readonly AppCliCommand[];
  readonly files: readonly AppCliFile[];
  /** A declaration only: module handlers cannot be stopped from using the network. `apps enable --network` records that the admin accepted it. */
  readonly network: boolean;
}

export type AppCliParse =
  { readonly kind: 'none' } | { readonly kind: 'ready'; readonly section: AppCliSection } | { readonly kind: 'refused'; readonly reason: string };

class SectionRefusal extends Error {}

const refuse = (message: string): never => {
  throw new SectionRefusal(message);
};

/**
 * The manifest's `cli` value read for app `appId`. `permissionIds` are the permissions the manifest declares. Never throws for a bad section:
 * the answer is `refused` with the reason, so the app still loads and only its commands are off.
 */
export function parseAppCliSection(options: { readonly appId: string; readonly section: unknown; readonly permissionIds: readonly string[] }): AppCliParse {
  if (options.section === undefined) {
    return { kind: 'none' };
  }
  try {
    return { kind: 'ready', section: readSection(options.appId, options.section, options.permissionIds) };
  } catch (error: unknown) {
    if (error instanceof SectionRefusal) {
      return { kind: 'refused', reason: error.message };
    }
    throw error;
  }
}

function readSection(appId: string, input: unknown, permissionIds: readonly string[]): AppCliSection {
  const section = toRecord(input);
  if (section === undefined) {
    return refuse('cli must be an object');
  }
  if (section['apiVersion'] !== APP_CLI_API_VERSION) {
    return refuse(`cli.apiVersion ${JSON.stringify(section['apiVersion'])} is not supported: this Stacki understands apiVersion ${APP_CLI_API_VERSION} only`);
  }
  onlyKeys(section, ['apiVersion', 'commands', 'files', 'network'], 'cli');
  if (!CLI_APP_ID.test(appId)) {
    return refuse(`the app id "${appId}" cannot name CLI commands: use lowercase letters, digits and - only (no dots)`);
  }
  const network = section['network'] ?? false;
  if (typeof network !== 'boolean') {
    return refuse('cli.network must be true or false');
  }
  const files = listOf(section['files'], APP_FILE_LIMITS.perAppMax, 'cli.files').map((item, index) => readFile(appId, item, `cli.files[${index}]`));
  if (new Set(files.map((file) => file.id)).size !== files.length || new Set(files.map((file) => file.path)).size !== files.length) {
    return refuse('cli.files: two files share an id or a path');
  }
  const commands = listOf(section['commands'], APP_CLI_LIMITS.commandsMax, 'cli.commands').map((item, index) =>
    readCommand(appId, item, `cli.commands[${index}]`, { files, permissionIds }),
  );
  if (new Set(commands.map((command) => command.name)).size !== commands.length) {
    return refuse('cli.commands: two commands share a name');
  }
  return { apiVersion: 1, commands, files, network };
}

// ----- Files -----

function readFile(appId: string, input: unknown, where: string): AppCliFile {
  const entry = recordOf(input, where);
  onlyKeys(entry, ['id', 'path', 'description', 'keys'], where);
  const id = stringOf(entry['id'], 1, 96, `${where}.id`);
  const prefix = `${appId}.`;
  if (!id.startsWith(prefix) || !/^[a-z][a-z0-9-]*$/.test(id.slice(prefix.length)) || id.length - prefix.length > APP_FILE_LIMITS.nameCharsMax) {
    return refuse(`${where}.id "${id}" must be "${appId}.<name>" with a lowercase name of at most ${APP_FILE_LIMITS.nameCharsMax} characters`);
  }
  const path = stringOf(entry['path'], 1, 200, `${where}.path`);
  const problem = appFilePathProblem(appId, path);
  if (problem !== undefined) {
    return refuse(`${where}.path: ${problem}`);
  }
  const budget: unknown[] = [];
  const fields = readFields(recordOf(entry['keys'], `${where}.keys`), `${where}.keys`, budget, 0);
  for (const [key, declared] of Object.entries(fields)) {
    if (declared.required && declared.default === undefined) {
      return refuse(`${where}.keys.${key}: a required key needs a default, so the empty file is valid`);
    }
  }
  return { id, path, description: stringOf(entry['description'], 1, APP_CLI_LIMITS.descriptionCharsMax, `${where}.description`), fields };
}

function readFields(source: Readonly<Record<string, unknown>>, where: string, budget: unknown[], depth: number): Readonly<Record<string, FieldSchema>> {
  const names = Object.keys(source);
  if (names.length === 0 || names.length > SCHEMA_LIMITS.fieldsMax) {
    return refuse(`${where}: list 1 to ${SCHEMA_LIMITS.fieldsMax} keys`);
  }
  const fields: Record<string, FieldSchema> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name) || name.length > 64) {
      return refuse(`${where}: "${name}" is not a key name (a letter, then letters, digits, _ or -, at most 64 characters)`);
    }
    const entry = recordOf(source[name], `${where}.${name}`);
    onlyKeys(entry, ['type', 'description', 'required', 'default'], `${where}.${name}`);
    const type = readType(entry['type'], `${where}.${name}.type`, budget, depth + 1);
    const required = entry['required'] ?? false;
    if (typeof required !== 'boolean') {
      return refuse(`${where}.${name}.required must be true or false`);
    }
    const fallback = fallbackOf(entry['default'], `${where}.${name}.default`);
    if (fallback !== undefined) {
      const reason = checkValue(type, fallback, `${where}.${name}.default`);
      if (reason !== undefined) {
        return refuse(reason);
      }
    }
    fields[name] = {
      type,
      description: stringOf(entry['description'], 1, APP_CLI_LIMITS.descriptionCharsMax, `${where}.${name}.description`),
      required,
      ...(fallback === undefined ? {} : { default: fallback }),
    };
  }
  return fields;
}

function readType(input: unknown, where: string, budget: unknown[], depth: number): ValueSchema {
  budget.push(where);
  if (budget.length > APP_CLI_LIMITS.schemaNodesMax) {
    return refuse(`${where}: the declared schema has more than ${APP_CLI_LIMITS.schemaNodesMax} nodes`);
  }
  if (depth > SCHEMA_LIMITS.depthMax) {
    return refuse(`${where}: nested deeper than ${SCHEMA_LIMITS.depthMax} levels`);
  }
  const type = recordOf(input, where);
  switch (type['kind']) {
    case 'boolean':
      onlyKeys(type, ['kind'], where);
      return { kind: 'boolean' };
    case 'integer':
    case 'number': {
      onlyKeys(type, ['kind', 'min', 'max'], where);
      const [min, max] = [type['min'], type['max']];
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return refuse(`${where}: ${String(type['kind'])} needs finite min and max, with min not above max`);
      }
      if (type['kind'] === 'integer' && (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))) {
        return refuse(`${where}: integer min and max are whole numbers`);
      }
      return type['kind'] === 'integer' ? { kind: 'integer', min, max } : { kind: 'number', min, max };
    }
    case 'string':
      return readStringType(type, where);
    case 'enum': {
      onlyKeys(type, ['kind', 'values'], where);
      const values = listOf(type['values'], APP_CLI_LIMITS.enumValuesMax, `${where}.values`).map((value, index) =>
        stringOf(value, 1, APP_CLI_LIMITS.enumValueCharsMax, `${where}.values[${index}]`),
      );
      if (values.length === 0 || new Set(values).size !== values.length) {
        return refuse(`${where}.values: list 1 to ${APP_CLI_LIMITS.enumValuesMax} different values`);
      }
      return { kind: 'enum', values };
    }
    case 'literal': {
      onlyKeys(type, ['kind', 'value'], where);
      const value = type['value'];
      if (typeof value === 'string' && value.length <= 128) {
        return { kind: 'literal', value };
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { kind: 'literal', value };
      }
      return refuse(`${where}.value must be text of at most 128 characters, a number or true/false`);
    }
    case 'array': {
      onlyKeys(type, ['kind', 'item', 'itemsMax', 'unique'], where);
      const itemsMax = boundedInteger(type['itemsMax'], 1, APP_CLI_LIMITS.listItemsMax, `${where}.itemsMax`);
      const unique = type['unique'] ?? false;
      if (typeof unique !== 'boolean') {
        return refuse(`${where}.unique must be true or false`);
      }
      return { kind: 'array', item: readType(type['item'], `${where}.item`, budget, depth + 1), itemsMax, ...(unique ? { unique } : {}) };
    }
    case 'object': {
      onlyKeys(type, ['kind', 'fields'], where);
      return { kind: 'object', fields: readFields(recordOf(type['fields'], `${where}.fields`), `${where}.fields`, budget, depth) };
    }
    case 'map': {
      onlyKeys(type, ['kind', 'value', 'entriesMax', 'keyDescription', 'keyPattern'], where);
      const keyPattern = type['keyPattern'];
      if (keyPattern !== undefined) {
        checkPattern(keyPattern, `${where}.keyPattern`);
      }
      return {
        kind: 'map',
        value: readType(type['value'], `${where}.value`, budget, depth + 1),
        entriesMax: boundedInteger(type['entriesMax'], 1, APP_CLI_LIMITS.listItemsMax, `${where}.entriesMax`),
        keyDescription: stringOf(type['keyDescription'], 1, 80, `${where}.keyDescription`),
        ...(typeof keyPattern === 'string' ? { keyPattern } : {}),
      };
    }
    default:
      return refuse(`${where}.kind ${JSON.stringify(type['kind'])} is not one of boolean, integer, number, string, enum, literal, array, object, map`);
  }
}

function readStringType(type: Readonly<Record<string, unknown>>, where: string): ValueSchema {
  onlyKeys(type, ['kind', 'charsMax', 'charsMin', 'pattern'], where);
  const charsMax = boundedInteger(type['charsMax'], 1, APP_CLI_LIMITS.stringCharsMax, `${where}.charsMax`);
  const charsMin = type['charsMin'] === undefined ? undefined : boundedInteger(type['charsMin'], 0, charsMax, `${where}.charsMin`);
  const pattern = type['pattern'];
  if (pattern !== undefined) {
    checkPattern(pattern, `${where}.pattern`);
  }
  return {
    kind: 'string',
    charsMax,
    ...(charsMin === undefined ? {} : { charsMin }),
    ...(typeof pattern === 'string' ? { pattern } : {}),
  };
}

/** A pattern that compiles, is short, and has no repeated group that itself repeats (the shape that makes a regular expression run for minutes). */
function checkPattern(pattern: unknown, where: string): void {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > APP_CLI_LIMITS.patternCharsMax) {
    return refuse(`${where} must be a pattern of 1 to ${APP_CLI_LIMITS.patternCharsMax} characters`);
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    return refuse(`${where} is not a valid regular expression`);
  }
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/u.test(pattern)) {
    return refuse(`${where} repeats a group that repeats: write it without nested repetition`);
  }
}

function fallbackOf(input: unknown, where: string): string | number | boolean | undefined {
  if (input === undefined || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  return refuse(`${where} must be text, a number or true/false`);
}

// ----- Commands -----

interface CommandContext {
  readonly files: readonly AppCliFile[];
  readonly permissionIds: readonly string[];
}

function readCommand(appId: string, input: unknown, where: string, context: CommandContext): AppCliCommand {
  const entry = recordOf(input, where);
  onlyKeys(entry, ['name', 'description', 'input', 'writes', 'destructive', 'permission', 'owns', 'handler'], where);
  const name = stringOf(entry['name'], 1, APP_CLI_LIMITS.commandNameCharsMax, `${where}.name`);
  if (!COMMAND_NAME.test(name)) {
    return refuse(`${where}.name "${name}" must be lowercase letters, digits and - (starting with a letter)`);
  }
  if (`stacki_${appId}_${name}`.length > APP_CLI_LIMITS.toolNameCharsMax) {
    return refuse(`${where}: the tool name stacki_${appId}_${name} is longer than ${APP_CLI_LIMITS.toolNameCharsMax} characters`);
  }
  const writes = entry['writes'];
  if (typeof writes !== 'boolean') {
    return refuse(`${where}.writes must be true or false`);
  }
  const destructive = entry['destructive'] ?? false;
  if (typeof destructive !== 'boolean' || (destructive && !writes)) {
    return refuse(`${where}.destructive must be true or false, and only a command that writes can be destructive`);
  }
  const permission = entry['permission'];
  if (permission !== undefined && (typeof permission !== 'string' || !context.permissionIds.includes(permission))) {
    return refuse(`${where}.permission must be the id of a permission the manifest declares (declared: ${context.permissionIds.join(', ') || 'none'})`);
  }
  const inputs = readInputs(entry['input'], `${where}.input`);
  const owns = listOf(entry['owns'], APP_CLI_LIMITS.ownsMax, `${where}.owns`).map((item, index) => readOwn(item, `${where}.owns[${index}]`, context));
  const handler = readHandler(entry['handler'], `${where}.handler`, { inputs, owns, writes });
  return {
    name,
    description: stringOf(entry['description'], 1, APP_CLI_LIMITS.descriptionCharsMax, `${where}.description`),
    inputs,
    writes,
    destructive,
    ...(typeof permission === 'string' ? { permission } : {}),
    owns,
    handler,
  };
}

function readInputs(input: unknown, where: string): readonly AppCliInput[] {
  if (input === undefined) {
    return [];
  }
  const schema = recordOf(input, where);
  onlyKeys(schema, ['type', 'properties', 'required'], where);
  if (schema['type'] !== 'object') {
    return refuse(`${where}.type must be "object"`);
  }
  const properties = recordOf(schema['properties'] ?? {}, `${where}.properties`);
  const names = Object.keys(properties);
  if (names.length > APP_CLI_LIMITS.inputsMax) {
    return refuse(`${where}.properties: at most ${APP_CLI_LIMITS.inputsMax} inputs`);
  }
  const required = listOf(schema['required'], APP_CLI_LIMITS.inputsMax, `${where}.required`).map((name, index) =>
    stringOf(name, 1, APP_CLI_LIMITS.inputNameCharsMax, `${where}.required[${index}]`),
  );
  for (const name of required) {
    if (!names.includes(name)) {
      return refuse(`${where}.required names "${name}", which is not a property`);
    }
  }
  return names.map((name) => readInput(name, properties[name], `${where}.properties.${name}`, { required: required.includes(name) }));
}

function readInput(name: string, input: unknown, where: string, options: { readonly required: boolean }): AppCliInput {
  const required = options.required;
  if (!INPUT_NAME.test(name) || name.length > APP_CLI_LIMITS.inputNameCharsMax || RESERVED_INPUTS.includes(name)) {
    return refuse(
      `${where}: "${name}" is not an input name (lowercase camelCase, at most ${APP_CLI_LIMITS.inputNameCharsMax} characters, not one of ${RESERVED_INPUTS.join(', ')})`,
    );
  }
  const property = recordOf(input, where);
  onlyKeys(property, ['type', 'description', 'minLength', 'maxLength', 'pattern', 'enum', 'minimum', 'maximum'], where);
  const description = stringOf(property['description'], 1, APP_CLI_LIMITS.descriptionCharsMax, `${where}.description`);
  switch (property['type']) {
    case 'boolean':
      onlyKeys(property, ['type', 'description'], where);
      return { name, kind: 'boolean', description, required, schema: { kind: 'boolean' } };
    case 'integer':
    case 'number': {
      onlyKeys(property, ['type', 'description', 'minimum', 'maximum'], where);
      const [min, max] = [property['minimum'] ?? -1_000_000_000, property['maximum'] ?? 1_000_000_000];
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return refuse(`${where}: minimum and maximum are finite numbers, minimum not above maximum`);
      }
      const kind = property['type'] === 'integer' ? 'integer' : 'number';
      return { name, kind, description, required, schema: kind === 'integer' ? { kind, min, max } : { kind, min, max } };
    }
    case 'string': {
      if (property['enum'] !== undefined) {
        onlyKeys(property, ['type', 'description', 'enum'], where);
        const values = listOf(property['enum'], APP_CLI_LIMITS.enumValuesMax, `${where}.enum`).map((value, index) =>
          stringOf(value, 1, APP_CLI_LIMITS.enumValueCharsMax, `${where}.enum[${index}]`),
        );
        if (values.length === 0 || new Set(values).size !== values.length) {
          return refuse(`${where}.enum: list 1 to ${APP_CLI_LIMITS.enumValuesMax} different values`);
        }
        return { name, kind: 'enum', description, required, schema: { kind: 'enum', values }, values };
      }
      onlyKeys(property, ['type', 'description', 'minLength', 'maxLength', 'pattern'], where);
      const schema = readStringType(
        {
          kind: 'string',
          charsMax: property['maxLength'] ?? 1024,
          ...(property['minLength'] === undefined ? {} : { charsMin: property['minLength'] }),
          ...(property['pattern'] === undefined ? {} : { pattern: property['pattern'] }),
        },
        where,
      );
      return { name, kind: 'string', description, required, schema };
    }
    default:
      return refuse(`${where}.type ${JSON.stringify(property['type'])} is not one of string, integer, number, boolean`);
  }
}

function readOwn(input: unknown, where: string, context: CommandContext): AppCliOwn {
  const entry = recordOf(input, where);
  onlyKeys(entry, ['file', 'keys'], where);
  const file = stringOf(entry['file'], 1, 96, `${where}.file`);
  const own = context.files.find((candidate) => candidate.id === file);
  const core = own === undefined ? STACKI_FILES.find((candidate) => candidate.id === file) : undefined;
  if (own === undefined && core === undefined) {
    return refuse(`${where}.file "${file}" is neither a file this app declares nor a core file id`);
  }
  if (core !== undefined && APP_FORBIDDEN_OWNS.includes(core.id)) {
    return refuse(`${where}.file "${file}" cannot be owned by an app: it decides who may do what`);
  }
  const fields = own?.fields ?? core?.fields ?? {};
  const known = own === undefined ? settableKeys(fields) : Object.keys(fields);
  const keys = listOf(entry['keys'], APP_CLI_LIMITS.ownedKeysMax, `${where}.keys`).map((item, index) => {
    const text = stringOf(item, 1, 200, `${where}.keys[${index}]`);
    const segments = parseConfigPath(text);
    const first = segments.ok ? segments.value[0] : undefined;
    if (!segments.ok || typeof first !== 'string' || !known.includes(first)) {
      return refuse(`${where}.keys[${index}] "${text}" does not start with a key of ${file} (known: ${known.join(', ')})`);
    }
    return { text, segments: segments.value };
  });
  if (keys.length === 0) {
    return refuse(`${where}.keys: name at least one key`);
  }
  return { file, keys };
}

function readHandler(
  input: unknown,
  where: string,
  context: { readonly inputs: readonly AppCliInput[]; readonly owns: readonly AppCliOwn[]; readonly writes: boolean },
): AppCliHandler {
  const handler = recordOf(input, where);
  if (handler['kind'] === 'module') {
    onlyKeys(handler, ['kind', 'entry', 'timeoutSeconds'], where);
    let entry: string;
    try {
      entry = parseBundlePath(handler['entry']);
    } catch (error: unknown) {
      return refuse(`${where}.entry: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!entry.endsWith('.mjs') && !entry.endsWith('.js')) {
      return refuse(`${where}.entry must be a .mjs or .js file inside the app folder`);
    }
    if (context.writes && context.owns.length === 0) {
      return refuse(`${where}: a module command that writes must say which files and keys it owns`);
    }
    const timeoutSeconds =
      handler['timeoutSeconds'] === undefined
        ? APP_CLI_LIMITS.timeoutSecondsDefault
        : boundedInteger(handler['timeoutSeconds'], 1, APP_CLI_LIMITS.timeoutSecondsMax, `${where}.timeoutSeconds`);
    return { kind: 'module', entry, timeoutSeconds };
  }
  if (handler['kind'] !== 'declarative') {
    return refuse(`${where}.kind must be "declarative" or "module"`);
  }
  onlyKeys(handler, ['kind', 'operations'], where);
  if (!context.writes) {
    return refuse(`${where}: a declarative command changes files, so its writes must be true`);
  }
  const operations = listOf(handler['operations'], APP_CLI_LIMITS.operationsMax, `${where}.operations`).map((item, index) =>
    readOperation(item, `${where}.operations[${index}]`, context),
  );
  if (operations.length === 0) {
    return refuse(`${where}.operations: list at least one operation`);
  }
  return { kind: 'declarative', operations };
}

function readOperation(
  input: unknown,
  where: string,
  context: { readonly inputs: readonly AppCliInput[]; readonly owns: readonly AppCliOwn[] },
): AppCliOperation {
  const entry = recordOf(input, where);
  onlyKeys(entry, ['op', 'file', 'path', 'value'], where);
  const op = entry['op'];
  if (op !== 'set' && op !== 'unset' && op !== 'add' && op !== 'remove') {
    return refuse(`${where}.op must be set, unset, add or remove`);
  }
  const file = stringOf(entry['file'], 1, 96, `${where}.file`);
  const path = stringOf(entry['path'], 1, 200, `${where}.path`);
  const segments = parseConfigPath(path);
  if (!segments.ok) {
    return refuse(`${where}.path: ${segments.error.message}`);
  }
  if (!ownsPath(context.owns, file, segments.value)) {
    return refuse(`${where}: ${file} ${path} is not inside a key this command owns`);
  }
  const given = entry['value'];
  if (given === undefined && (op === 'set' || op === 'add')) {
    return refuse(`${where}.value is required for ${op}`);
  }
  if (given !== undefined && op === 'unset') {
    return refuse(`${where}.value is not used by unset`);
  }
  return {
    op,
    file,
    path,
    segments: segments.value,
    ...(given === undefined ? {} : { value: readValue(given, `${where}.value`, context.inputs) }),
  };
}

function readValue(input: unknown, where: string, inputs: readonly AppCliInput[]): AppCliValue {
  const reference = toRecord(input);
  if (reference !== undefined && Object.hasOwn(reference, '$input')) {
    const name = reference['$input'];
    if (Object.keys(reference).length !== 1 || typeof name !== 'string' || !inputs.some((candidate) => candidate.name === name)) {
      return refuse(
        `${where}: {"$input": name} names one input this command declares (declared: ${inputs.map((candidate) => candidate.name).join(', ') || 'none'})`,
      );
    }
    return { kind: 'input', name };
  }
  if (JSON.stringify(input).length > APP_CLI_LIMITS.literalValueJsonCharsMax) {
    return refuse(`${where}: a literal value is at most ${APP_CLI_LIMITS.literalValueJsonCharsMax} characters of JSON`);
  }
  return { kind: 'literal', value: input };
}

/** Whether `segments` of `file` are an owned key or inside one: the one rule every operation of a command passes, declarative or from a module. */
export function ownsPath(owns: readonly AppCliOwn[], file: string, segments: readonly PathSegment[]): boolean {
  return owns.some(
    (own) =>
      own.file === file &&
      own.keys.some((key) => key.segments.length <= segments.length && key.segments.every((segment, index) => segment === segments[index])),
  );
}

// ----- Registry and table rows -----

/** The registry entry of a declared file: validated by the declared keys, so a file with no app parser still cannot hold a key the app did not declare. */
export function appFileSchema(appId: string, file: AppCliFile, commandNames: readonly string[]): FileSchema {
  const empty = Object.fromEntries(
    Object.entries(file.fields).flatMap(([key, entry]) => (entry.required && entry.default !== undefined ? [[key, entry.default]] : [])),
  );
  return {
    id: file.id,
    file: file.path,
    description: file.description,
    requires: 'cli:apps',
    fields: file.fields,
    empty,
    validate: (source): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch (error: unknown) {
        throw new Error(`${file.path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const reason = checkValue({ kind: 'object', fields: file.fields }, parsed, file.path);
      if (reason !== undefined) {
        throw new Error(reason);
      }
    },
    commands: commandNames.map((name) => `${appId} ${name}`),
    parserSources: [],
    appId,
  };
}

/** The command table row of an app's command: its words are `[appId, name]`, so it can never be a core command. */
export function appCommandSpec(appId: string, command: AppCliCommand): CommandSpec {
  const args: ArgSpec[] = command.inputs.map((input) => ({
    name: input.name,
    kind: input.kind,
    required: input.required,
    description: input.description,
    ...(input.values === undefined ? {} : { values: input.values }),
  }));
  return {
    words: [appId, command.name],
    summary: `${command.description} (Added by the ${appId} app.)`,
    access: command.writes ? 'write' : 'read',
    destructive: command.destructive,
    feature: 'cli:apps',
    featureKey: `cli.app.${appId}.${command.name}`,
    args,
    appId,
    ...(command.permission === undefined ? {} : { permission: command.permission }),
  };
}

// ----- Small readers -----

function recordOf(input: unknown, where: string): Readonly<Record<string, unknown>> {
  return toRecord(input) ?? refuse(`${where} must be an object`);
}

function listOf(input: unknown, max: number, where: string): readonly unknown[] {
  if (input === undefined) {
    return [];
  }
  const list = toArray(input);
  if (list === undefined) {
    return refuse(`${where} must be a list`);
  }
  return list.length <= max ? list : refuse(`${where}: at most ${max} entries`);
}

function stringOf(input: unknown, min: number, max: number, where: string): string {
  if (typeof input !== 'string' || input.length < min || input.length > max) {
    return refuse(`${where} must be text of ${min} to ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(input)) {
    return refuse(`${where} must not hold control characters`);
  }
  return input;
}

function boundedInteger(input: unknown, min: number, max: number, where: string): number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= min && input <= max
    ? input
    : refuse(`${where} must be a whole number from ${min} to ${max}`);
}

function onlyKeys(entry: Readonly<Record<string, unknown>>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      refuse(`${where}.${key} is not a key (known: ${allowed.join(', ')})`);
    }
  }
}
