// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/apps/apps.json`: the installed-apps lock. Only the local side is settable: which apps the project lists, where each came from, its
// digest and its update policy. Downloading a bundle (marketplace, GitHub) is not here; the lock records the result.
import { APP_LIMITS, APPS_LOCK_FILE, parseAppsLock, parseAppsLockSource, serializeAppsLock } from '../../apps';
import { arrayOf, bool, field, literal, objectOf, text, variantOf, type FieldSchema, type FileSchema, type ValueSchema } from '../stackiSchema';

const APP_ID = '^[a-z0-9][a-z0-9._-]*$';
const VERSION = '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,20})?$';
const SHA256 = '^[0-9a-f]{64}$';
const GITHUB_NAME = '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$';
const GITHUB_REPOSITORY = '^[A-Za-z0-9._-]+$';
const RELEASE_ASSET = '^[A-Za-z0-9][A-Za-z0-9._ -]*\\.zip$';
/** GitHub's own login limit (ROLE_LIMITS.loginCharsMax): the account that reads a private repository. */
const GITHUB_LOGIN_CHARS_MAX = 39;

const appVersion = (what: string): FieldSchema =>
  field(text(APP_LIMITS.versionCharsMax, { pattern: VERSION }), `${what}: MAJOR.MINOR.PATCH, optionally -prerelease.`, { required: true });
const releaseTag = (what: string): FieldSchema => field(text(APP_LIMITS.tagCharsMax, { charsMin: 1 }), what, { required: true });

const installSource: ValueSchema = variantOf('kind', {
  file: { fileName: field(text(APP_LIMITS.assetNameCharsMax, { charsMin: 1 }), 'The uploaded archive name, kept for the record only.', { required: true }) },
  github: {
    owner: field(text(APP_LIMITS.ownerCharsMax, { pattern: GITHUB_NAME }), 'The GitHub owner of the repository that holds the releases.', { required: true }),
    repository: field(text(APP_LIMITS.repositoryCharsMax, { pattern: GITHUB_REPOSITORY }), 'The repository name.', { required: true }),
    asset: field(text(APP_LIMITS.assetNameCharsMax, { pattern: RELEASE_ASSET }), 'The release asset file name, a .zip such as heatmap.zip.', {
      required: true,
    }),
    account: field(
      text(GITHUB_LOGIN_CHARS_MAX, { pattern: GITHUB_NAME }),
      'The signed-in GitHub account that reads a private repository; absent reads it as public.',
    ),
    tag: releaseTag('The release tag the installed version came from.'),
  },
  marketplace: {
    id: field(text(APP_LIMITS.idCharsMax, { pattern: APP_ID }), 'The marketplace entry; always the lock entry id.', { required: true }),
    version: appVersion('The approved marketplace version'),
  },
  local: {},
});

const update: ValueSchema = objectOf({
  version: appVersion('The newer version an update check found'),
  tag: releaseTag('The release tag of that version.'),
  sha256: field(text(64, { charsMin: 64, pattern: SHA256 }), 'SHA-256 (lowercase hex) of the archive that was checked; Update installs only these bytes.', {
    required: true,
  }),
  additions: field(
    arrayOf(text(APP_LIMITS.updateAdditionCharsMax, { charsMin: 1 }), APP_LIMITS.updateAdditionsMax),
    'Lines for what the update asks for that the installed version did not; absent reads as none.',
  ),
});

const entry: ValueSchema = objectOf({
  id: field(text(APP_LIMITS.idCharsMax, { charsMin: 1, pattern: APP_ID }), 'The app id; also its folder name under .stacki/apps/ and unique in the list.', {
    required: true,
  }),
  version: appVersion('The installed version'),
  sha256: field(text(64, { charsMin: 64, pattern: SHA256 }), 'SHA-256 (lowercase hex) of the archive that was installed.', { required: true }),
  installedAt: field(text(40, { charsMin: 1 }), 'When it was installed: an ISO 8601 date and time.', { required: true }),
  source: field(installSource, 'How the app arrived: file, github, marketplace or local.', { required: true }),
  update: field(update, 'A newer release an update check found; installed when an admin chooses Update.'),
  autoUpdate: field(bool(), 'Whether an update check installs a newer version by itself; apps are third-party code, so off unless an admin chose it.', {
    default: false,
  }),
});

export const APPS_FILE: FileSchema = {
  id: 'apps',
  file: APPS_LOCK_FILE,
  description: 'The installed-apps lock: which apps are installed, where each came from, at which digest. The bundle files live in .stacki/apps/<id>/.',
  requires: 'settings:roles',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    apps: field(arrayOf(entry, APP_LIMITS.appsMax), `The installed apps, at most ${APP_LIMITS.appsMax}; the app writes them sorted by id.`, {
      required: true,
      commands: ['apps remove'],
    }),
  },
  empty: { version: 1, apps: [] },
  validate: (source): void => {
    parseAppsLockSource(source);
  },
  serialize: (document): string => serializeAppsLock(parseAppsLock(document)),
  commands: ['apps remove'],
  parserSources: ['shared/properties/apps.ts', 'electron/project/appStore.ts'],
  parserKeyExceptions: {
    repo: 'Alias of repository, read in a GitHub source but never written.',
    // The rest of apps.ts parses the bundle manifest and GitHub's own replies, which are not this file.
    stacki: 'A manifest key: the oldest Stacki version, read from stacki-app.json.',
    stackiVersionMin: 'A manifest property name, not a lock key.',
    manifestVersion: 'A manifest key, read from stacki-app.json.',
    entry: 'A manifest key: the bundle path the frame opens.',
    icon: 'A manifest key: the app icon path.',
    settings: 'A manifest key: the settings an installer fills in.',
    name: 'A manifest key: the app name.',
    description: 'A manifest key: the app description.',
    window: 'A manifest key: the panel or popup size.',
    author: 'A manifest key: the author block.',
    authorGitHub: 'A manifest property name, not a lock key.',
    commands: 'A manifest key: the app commands.',
    shortcutClaims: 'A manifest property name, not a lock key.',
    secretsAllowlist: 'A manifest key: the secret scan allowance.',
    network: 'A manifest key: the hosts the app calls.',
    auth: 'A manifest key: the OAuth providers.',
    permissions: 'A manifest key: the role switches.',
    github: 'The value of a manifest or lock source kind, not a key.',
    mode: 'A manifest key: window.mode.',
    private: 'A key of GitHub’s repository reply, not this file.',
    stackiApp: 'A key of GitHub’s repository reply, not this file.',
    updatedAt: 'A key of GitHub’s repository reply, not this file.',
    organization: 'A key of GitHub’s repository reply, not this file.',
    assets: 'A key of GitHub’s release reply, not this file.',
    prerelease: 'A key of GitHub’s release reply, not this file.',
    publishedAt: 'A key of GitHub’s release reply, not this file.',
    sizeBytes: 'A key of GitHub’s release asset reply, not this file.',
    manifest: 'A key of the Apps panel summary on the wire, not this file.',
    lock: 'A key of the Apps panel summary on the wire, not this file.',
    token: 'A key of an IPC reply that names a staged bundle, never written to the lock.',
    replaces: 'A key of an IPC reply that names a staged bundle, never written to the lock.',
    message: 'A key of an IPC failure reply, not this file.',
    messageRef: 'A key of an IPC failure reply, not this file.',
    ok: 'A key of an IPC result, not this file.',
    value: 'A key of an IPC result, not this file.',
  },
};
