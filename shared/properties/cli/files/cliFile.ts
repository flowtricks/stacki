// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/cli.json`: which installed apps may add commands to the Stacki CLI in this project, and the trust that was recorded for each.
//
// Why a file of its own: an app's CLI commands are third-party behaviour (declared operations, or a module that runs in a child process), so they
// are off until an admin enables the app (`stacki apps enable <app>`), and the record names the lock digest the admin trusted. An update changes
// the lock digest, so the record no longer matches and the app's commands stay off until the admin enables it again. Only admin edits this file
// (it requires `settings:roles`, and `config` on it needs `cli:roles`), so an agent without that access cannot trust an app.
import { assert } from '../../../core/assert';
import { toRecord } from '../../../core/record';
import { APP_LIMITS } from '../../apps';
import { bool, field, literal, mapOf, objectOf, text, type FileSchema } from '../stackiSchema';

export const CLI_SETTINGS_FILE = '.stacki/cli.json';

const APP_ID = '^[a-z0-9][a-z0-9._-]*$';
const SHA256 = '^[0-9a-f]{64}$';

/** What the project recorded for one app. */
export interface CliAppRecord {
  readonly enabled: boolean;
  readonly trusted: boolean;
  /** The lock digest of the app at the time it was trusted. */
  readonly sha256: string;
  /** Whether the person approved the app's declared network use (enforced only as a declaration: see docs for module handlers). */
  readonly network: boolean;
}

export type CliSettingsReading =
  { readonly kind: 'ready'; readonly apps: ReadonlyMap<string, CliAppRecord> } | { readonly kind: 'invalid'; readonly reason: string };

/** The file's text read into app records; throws the reason when the file is not a valid `cli.json`. */
export function parseCliSettingsSource(source: string): ReadonlyMap<string, CliAppRecord> {
  assert(source.length >= 0, 'A source has a length');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error(`${CLI_SETTINGS_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = toRecord(parsed);
  if (root === undefined) {
    throw new Error(`${CLI_SETTINGS_FILE} is not a JSON object`);
  }
  for (const key of Object.keys(root)) {
    if (key !== 'version' && key !== 'apps') {
      throw new Error(`${CLI_SETTINGS_FILE}: unknown key "${key}"`);
    }
  }
  if (root['version'] !== 1) {
    throw new Error(`${CLI_SETTINGS_FILE}: version must be 1`);
  }
  const apps = toRecord(root['apps']);
  if (apps === undefined) {
    throw new Error(`${CLI_SETTINGS_FILE}: apps must be an object keyed by app id`);
  }
  const entries = Object.entries(apps);
  if (entries.length > APP_LIMITS.appsMax) {
    throw new Error(`${CLI_SETTINGS_FILE}: at most ${APP_LIMITS.appsMax} apps`);
  }
  const records = new Map<string, CliAppRecord>();
  for (const [id, value] of entries) {
    if (!new RegExp(APP_ID, 'u').test(id) || id.length > APP_LIMITS.idCharsMax) {
      throw new Error(`${CLI_SETTINGS_FILE}: "${id}" is not an app id`);
    }
    records.set(id, parseRecord(id, value));
  }
  return records;
}

function parseRecord(id: string, value: unknown): CliAppRecord {
  assert(id.length > 0, 'An app has an id');
  const entry = toRecord(value);
  if (entry === undefined) {
    throw new Error(`${CLI_SETTINGS_FILE}: ${id} must be an object`);
  }
  for (const key of Object.keys(entry)) {
    if (!['enabled', 'trusted', 'sha256', 'network'].includes(key)) {
      throw new Error(`${CLI_SETTINGS_FILE}: ${id}.${key} is not a key (known: enabled, trusted, sha256, network)`);
    }
  }
  const enabled = entry['enabled'];
  const trusted = entry['trusted'];
  const sha256 = entry['sha256'];
  const network = entry['network'] ?? false;
  if (typeof enabled !== 'boolean') {
    throw new Error(`${CLI_SETTINGS_FILE}: ${id}.enabled must be true or false`);
  }
  if (typeof trusted !== 'boolean') {
    throw new Error(`${CLI_SETTINGS_FILE}: ${id}.trusted must be true or false`);
  }
  if (typeof sha256 !== 'string' || !new RegExp(SHA256, 'u').test(sha256)) {
    throw new Error(`${CLI_SETTINGS_FILE}: ${id}.sha256 must be 64 lowercase hex characters`);
  }
  if (typeof network !== 'boolean') {
    throw new Error(`${CLI_SETTINGS_FILE}: ${id}.network must be true or false`);
  }
  return { enabled, trusted, sha256, network };
}

/** `parseCliSettingsSource` for a caller that wants a value, not a throw; an absent file reads as no records. */
export function readCliSettings(source: string | undefined): CliSettingsReading {
  assert(source === undefined || source.length >= 0, 'A source is text or absent');
  if (source === undefined) {
    return { kind: 'ready', apps: new Map() };
  }
  try {
    return { kind: 'ready', apps: parseCliSettingsSource(source) };
  } catch (error: unknown) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

export const CLI_FILE: FileSchema = {
  id: 'cli',
  file: CLI_SETTINGS_FILE,
  description:
    'Which installed apps may add commands to the Stacki CLI (and so to its MCP server) in this project, and the trust recorded for each: the lock digest that was trusted. Admin only.',
  requires: 'settings:roles',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    apps: field(
      mapOf(
        objectOf({
          enabled: field(bool(), "Whether the app's CLI commands are loaded.", { required: true, commands: ['apps enable', 'apps disable'] }),
          trusted: field(bool(), 'Whether an admin trusted the app to add commands. Without it an enabled app adds none.', {
            required: true,
            commands: ['apps enable', 'apps disable'],
          }),
          sha256: field(
            text(64, { charsMin: 64, pattern: SHA256 }),
            "The app's lock digest (apps.json) when it was trusted. An update changes the digest, so trust must be given again.",
            { required: true, commands: ['apps enable', 'apps disable'] },
          ),
          network: field(
            bool(),
            'Whether the admin approved the network use the app declares. Module handlers cannot be stopped from using the network by the permission model: this is a declaration the admin accepted.',
            { default: false, commands: ['apps enable'] },
          ),
        }),
        APP_LIMITS.appsMax,
        'an installed app id',
        APP_ID,
      ),
      `The record of each app that was ever enabled, by app id, at most ${APP_LIMITS.appsMax}.`,
      { required: true, commands: ['apps enable', 'apps disable'] },
    ),
  },
  empty: { version: 1, apps: {} },
  validate: (source): void => {
    parseCliSettingsSource(source);
  },
  commands: ['apps enable', 'apps disable'],
  parserSources: ['shared/properties/cli/files/cliFile.ts'],
};
