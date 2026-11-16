// Generated fixture apps for the Stacki CLI suites: an app folder under a fixture project's `.stacki/apps/<id>/` and its entry in the lock, written
// through the app's own serializer, never a real project. A fixture app carries the manifest the test gives it and the handler files it names.
import fs from 'node:fs';
import path from 'node:path';
import { makeProject } from './cliProject.ts';
import { parseAppsLockSource, serializeAppsLock } from '#dist/shared/properties/apps.js';

export interface FixtureApp {
  readonly id: string;
  readonly version?: string;
  /** The lock digest; a different one is what an update looks like. */
  readonly sha256?: string;
  /** Extra manifest keys: `cli`, `permissions`, `network`. */
  readonly manifest?: Readonly<Record<string, unknown>>;
  /** Files of the bundle, by path inside the app folder. */
  readonly files?: Readonly<Record<string, string>>;
}

export const DIGEST_ONE = 'a'.repeat(64);
export const DIGEST_TWO = 'b'.repeat(64);

/** Installs the app into the project: its folder, its manifest and its lock entry. Returns the folder. */
export function installApp(root: string, app: FixtureApp): string {
  const folder = path.join(root, '.stacki', 'apps', app.id);
  fs.mkdirSync(folder, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id: app.id,
    name: `Fixture ${app.id}`,
    version: app.version ?? '1.0.0',
    description: 'A generated fixture app.',
    entry: 'index.html',
    ...app.manifest,
  };
  fs.writeFileSync(path.join(folder, 'stacki-app.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
  fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>fixture</title>\n');
  for (const [relative, text] of Object.entries(app.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(folder, relative)), { recursive: true });
    fs.writeFileSync(path.join(folder, relative), text);
  }
  const lockFile = path.join(root, '.stacki', 'apps', 'apps.json');
  const existing = fs.existsSync(lockFile) ? parseAppsLockSource(fs.readFileSync(lockFile, 'utf8')).apps.filter((entry) => entry.id !== app.id) : [];
  const entry = {
    id: app.id,
    version: app.version ?? '1.0.0',
    sha256: app.sha256 ?? DIGEST_ONE,
    installedAt: '2026-01-01T00:00:00.000Z',
    source: { kind: 'local' as const },
    update: undefined,
    autoUpdate: false,
  };
  fs.writeFileSync(lockFile, serializeAppsLock({ version: 1, apps: [...existing, entry] }));
  return folder;
}

/** The lock digest of an installed app changes, as an update does. */
export function updateLockDigest(root: string, id: string, sha256: string): void {
  const lockFile = path.join(root, '.stacki', 'apps', 'apps.json');
  const lock = parseAppsLockSource(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, serializeAppsLock({ version: 1, apps: lock.apps.map((entry) => (entry.id === id ? { ...entry, sha256 } : entry)) }));
}

/** The notes fixture app's `cli` section: one declared file, a declarative command that sets a key of it, one on a core file, and a module command. */
export function notesCli(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    apiVersion: 1,
    files: [
      {
        id: 'notes.settings',
        path: '.stacki/apps/notes/settings.json',
        description: 'Settings of the notes app.',
        keys: {
          title: { type: { kind: 'string', charsMax: 40 }, description: 'The board title.', default: 'Notes' },
          pageSize: { type: { kind: 'integer', min: 1, max: 100 }, description: 'Notes per page.', default: 20 },
          tags: { type: { kind: 'array', item: { kind: 'string', charsMax: 20 }, itemsMax: 5 }, description: 'Tags in use.' },
        },
      },
    ],
    commands: [
      {
        name: 'set-title',
        description: 'Set the title of the notes board.',
        input: { type: 'object', properties: { title: { type: 'string', description: 'The new title.', maxLength: 40 } }, required: ['title'] },
        writes: true,
        owns: [{ file: 'notes.settings', keys: ['title'] }],
        handler: { kind: 'declarative', operations: [{ op: 'set', file: 'notes.settings', path: 'title', value: { $input: 'title' } }] },
      },
      {
        name: 'clear-title',
        description: 'Take the title back to its default.',
        writes: true,
        destructive: true,
        permission: 'reset',
        owns: [{ file: 'notes.settings', keys: ['title'] }],
        handler: { kind: 'declarative', operations: [{ op: 'unset', file: 'notes.settings', path: 'title' }] },
      },
      {
        name: 'hide-guide',
        description: 'Hide the column guide.',
        writes: true,
        owns: [{ file: 'guide', keys: ['settings.visible'] }],
        handler: { kind: 'declarative', operations: [{ op: 'set', file: 'guide', path: 'settings.visible', value: false }] },
      },
      {
        name: 'shout',
        description: 'Upper-case the title with the notes module.',
        writes: true,
        owns: [{ file: 'notes.settings', keys: ['title'] }],
        handler: { kind: 'module', entry: 'handler.mjs' },
      },
      {
        name: 'probe',
        description: 'Report what the module can see and do.',
        input: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'What to try.', enum: ['probe', 'hang', 'escape', 'huge', 'badjson', 'fail', 'refuse', 'readonly-writes'] },
            envPath: { type: 'string', description: 'A path the module tries to read.', maxLength: 500 },
          },
          required: ['mode'],
        },
        writes: false,
        handler: { kind: 'module', entry: 'handler.mjs', timeoutSeconds: 1 },
      },
    ],
    ...overrides,
  };
}

/** The module every fixture module command runs: it reads the request, then does what `input.mode` says. */
export const NOTES_MODULE = `
import fs from 'node:fs';
import cp from 'node:child_process';
let text = '';
for await (const chunk of process.stdin) { text += chunk; }
const request = JSON.parse(text.split('\\n')[0]);
const mode = request.input.mode ?? 'shout';
const attempt = (fn) => { try { return { ok: true, value: String(fn()).slice(0, 40) }; } catch (error) { return { ok: false, code: error.code ?? String(error) }; } };
if (mode === 'shout') {
  const title = request.state['notes.settings'].title ?? 'notes';
  console.log(JSON.stringify({ ok: true, summary: 'Shouted the title.', operations: [{ op: 'set', file: 'notes.settings', path: 'title', value: title.toUpperCase() }] }));
} else if (mode === 'probe') {
  console.log(JSON.stringify({ ok: true, summary: 'Probed.', result: {
    envKeys: Object.keys(process.env),
    secret: process.env.STACKI_TEST_SECRET ?? 'absent',
    protocol: process.env.STACKI_CLI_PROTOCOL ?? null,
    dotenv: attempt(() => fs.readFileSync(request.input.envPath, 'utf8')),
    write: attempt(() => fs.writeFileSync('probe-write.txt', 'x')),
    spawn: attempt(() => cp.spawnSync('ls')),
    own: attempt(() => fs.readFileSync('handler.mjs', 'utf8').length),
    state: request.state,
    command: request.command,
    phase: request.phase,
    hasRole: 'role' in request,
  } }));
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'escape') {
  console.log(JSON.stringify({ ok: true, summary: 'Tried.', operations: [{ op: 'set', file: 'guide', path: 'settings.visible', value: true }] }));
} else if (mode === 'huge') {
  process.stdout.write('x'.repeat(2_000_000));
} else if (mode === 'badjson') {
  console.log('not json');
} else if (mode === 'fail') {
  console.error('the handler broke');
  process.exit(3);
} else if (mode === 'refuse') {
  console.log(JSON.stringify({ ok: false, message: 'Nothing to do today.' }));
} else if (mode === 'readonly-writes') {
  console.log(JSON.stringify({ ok: true, summary: 'Wrote anyway.', operations: [{ op: 'set', file: 'notes.settings', path: 'title', value: 'x' }] }));
}
`;

/** A permission the notes app declares: the role needs it for `clear-title`. */
export const NOTES_PERMISSIONS = [{ id: 'reset', label: 'Reset the title', default: false }];

/** The cli.json that enables and trusts `id` at `sha256`. */
export function trustFile(id: string, options: { readonly sha256?: string; readonly network?: boolean } = {}): string {
  return `${JSON.stringify({ version: 1, apps: { [id]: { enabled: true, trusted: true, sha256: options.sha256 ?? DIGEST_ONE, network: options.network ?? false } } }, undefined, 2)}\n`;
}

/** Roles for the app tests: the owner, an editor who may run the notes app (reset switch on), one without the switch, one without the app grant, a viewer. */
export const APP_ROLES_FIXTURE = `${JSON.stringify(
  {
    version: 1,
    defaultRole: 'viewer',
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'editor', name: 'Editor', members: [], access: ['cli:read', 'cli:apps', 'panel:apps', 'app:notes'], appPermissions: { notes: { reset: true } } },
      { id: 'noswitch', name: 'No switch', members: [], access: ['cli:read', 'cli:apps', 'panel:apps', 'app:notes'] },
      { id: 'noapp', name: 'No app', members: [], access: ['cli:read', 'cli:apps', 'panel:apps'] },
      { id: 'viewer', name: 'Viewer', members: [], access: ['cli:read'] },
    ],
  },
  undefined,
  2,
)}\n`;

/** A project with the notes app installed (module, permissions, `.env` holding a fixture value) and, unless said otherwise, trusted. */
export function notesProject(
  options: { readonly trust?: 'trusted' | 'none'; readonly cli?: Record<string, unknown>; readonly extra?: Readonly<Record<string, string>> } = {},
): string {
  const root = makeProject({
    '.env': 'STACKI_TEST_SECRET=fixture-not-a-secret\n',
    ...(options.trust === 'none' ? {} : { '.stacki/cli.json': trustFile('notes') }),
    ...options.extra,
  });
  installApp(root, { id: 'notes', manifest: { cli: options.cli ?? notesCli(), permissions: NOTES_PERMISSIONS }, files: { 'handler.mjs': NOTES_MODULE } });
  return root;
}

/** The list at `value`, narrowed without an assertion; fails the test when it is not a list. */
export function listOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected a list');
  }
  return value;
}
