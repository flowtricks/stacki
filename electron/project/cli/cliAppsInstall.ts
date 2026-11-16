// `stacki apps add <folder-or-zip>` and `stacki apps remove <app>`: the local side of installing an app, as a plan.
//
// Add reads a local app folder or .zip archive with the app's own readers (`readFolderBundle`, `readAppBundle`: the same checks an upload gets:
// file types, bounds, no code loaded from another host), then plans the folder's files (an effect) and the lockfile entry (an edit of
// `.stacki/apps/apps.json`, written with the app's own serializer). A download is never the CLI's job: a URL, a GitHub or npm reference is refused with the way to
// install it (the Apps panel, which holds the signed-in account, the marketplace approvals and the update policy). Remove plans deleting the folder's files (the
// effect is journalled byte for byte, so undo restores them), the lock entry, the app's trust record in `.stacki/cli.json` and its non-secret values in
// `.stacki/apps/settings.json`. The app platform has no dependency between apps (no manifest key names another app), so there is nothing for a removal to
// refuse on that ground; an app's sealed secrets live in the app's own vault outside the project and are not touched.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { err, ok, type Result } from '../../../shared/core/result';
import { toArray, toRecord } from '../../../shared/core/record';
import { readAppBundle, type AppBundle, type BundleFile } from '../../../shared/properties/appBundle';
import { APP_LIMITS } from '../../../shared/properties/apps';
import { fileSchemaById } from '../../../shared/properties/cli/stackiFiles';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { appFolderDigest, readFolderBundle } from '../appScan';
import type { CommandContext, Handler, Outcome } from './cliCommands';
import type { EffectRecord } from './cliEffects';
import type { Edit } from './cliPlan';
import { readFileState } from './cliFiles';

const refused = (message: string, code: CliError['code'] = 'refused'): Result<never, CliError> => err({ code, message });

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github:|npm:|gh:)/i;
const ARCHIVE_BYTES_MAX = 64 * 1024 * 1024;

function readSource(context: CommandContext, source: string): Result<AppBundle, CliError> {
  if (REMOTE.test(source)) {
    return refused(
      'The CLI installs only an app that is already on this machine: a download needs the account, approvals and update policy the Apps panel holds. Install it from the Apps panel (marketplace, GitHub or a file), or download it yourself and run "stacki apps add <folder or .zip>".',
    );
  }
  const absolute = path.isAbsolute(source) ? source : path.resolve(context.root, source);
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(absolute);
  } catch {
    return refused(`"${source}" does not exist.`, 'missing');
  }
  if (metadata.isSymbolicLink()) {
    return refused('An app source cannot be a symbolic link.');
  }
  try {
    if (metadata.isDirectory()) {
      return ok(readFolderBundle(absolute, path.basename(absolute)));
    }
    if (metadata.isFile() && absolute.endsWith('.zip')) {
      if (metadata.size > ARCHIVE_BYTES_MAX) {
        return refused('That archive is larger than an app may be.');
      }
      return ok(
        readAppBundle(new Uint8Array(fs.readFileSync(absolute)), (data, max) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, max) }))),
      );
    }
  } catch (error: unknown) {
    return refused(`That is not an app Stacki accepts: ${error instanceof Error ? error.message : String(error)}`);
  }
  return refused('An app source is a folder holding stacki-app.json, or a .zip of one.');
}

const inEntries = (files: readonly BundleFile[], id: string): readonly { readonly file: string; readonly base64: string }[] =>
  files.map((file) => ({ file: `.stacki/apps/${id}/${file.path}`, base64: Buffer.from(file.bytes).toString('base64') }));

export const appsAdd: Handler = (context) => {
  const source = context.args['source'];
  const lock = fileSchemaById('apps');
  if (typeof source !== 'string' || lock === undefined) {
    return refused('apps add <folder or .zip>', 'usage');
  }
  const bundle = readSource(context, source);
  if (!bundle.ok) {
    return bundle;
  }
  const id = bundle.value.manifest.id;
  if (fs.existsSync(path.join(context.root, '.stacki', 'apps', id))) {
    return refused(`.stacki/apps/${id}/ already exists: remove it first (stacki apps remove ${id}), or keep it.`, 'exists');
  }
  const entry = {
    id,
    version: bundle.value.manifest.version,
    sha256: appFolderDigest(bundle.value.files),
    installedAt: new Date().toISOString(),
    source: { kind: 'local' },
    autoUpdate: false,
  };
  const edit: Edit = {
    schema: lock,
    produce: (state) => {
      const document = state.source === undefined ? { ...lock.empty } : toRecord(JSON.parse(state.source));
      const apps = toArray(document?.['apps']) ?? [];
      if (document === undefined || apps.length >= APP_LIMITS.appsMax) {
        return refused(`A project lists at most ${APP_LIMITS.appsMax} apps.`);
      }
      if (apps.some((app) => toRecord(app)?.['id'] === id)) {
        return refused(`${id} is already in .stacki/apps/apps.json.`, 'exists');
      }
      return ok(
        lock.serialize === undefined
          ? `${JSON.stringify({ ...document, apps: [...apps, entry] }, undefined, 2)}\n`
          : lock.serialize({ ...document, apps: [...apps, entry] }),
      );
    },
  };
  const record: EffectRecord = { kind: 'files-write', data: { files: inEntries(bundle.value.files, id) } };
  return ok({
    kind: 'write',
    edits: [edit],
    effects: [record],
    summary: `Install the ${bundle.value.manifest.name} app (${id} ${entry.version}) from ${source}: ${bundle.value.files.length} files.`,
    notes: [
      bundle.value.manifest.name === ''
        ? ''
        : `Source recorded as "local". If the app declares CLI commands, run "stacki apps enable ${id}" to review and trust them.`,
    ].filter((line) => line !== ''),
  } satisfies Outcome);
};

function folderFiles(root: string, id: string): Result<readonly BundleFile[], CliError> {
  const base = path.join(root, '.stacki', 'apps', id);
  const files: BundleFile[] = [];
  const pending: string[] = [''];
  for (let visited = 0; pending.length > 0; visited += 1) {
    if (visited > APP_LIMITS.filesMax * 4) {
      return refused('That app folder holds more files than an app may.');
    }
    const relative = pending.pop() ?? '';
    for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        return refused(`${child} is a symbolic link; the CLI does not remove a folder that holds links.`);
      }
      if (entry.isDirectory()) {
        pending.push(child);
      } else {
        files.push({ path: child, bytes: new Uint8Array(fs.readFileSync(path.join(base, child))) });
      }
    }
  }
  return ok(files);
}

function withoutApp(schemaId: string, id: string, pick: 'apps-array' | 'apps-map'): Edit | undefined {
  const schema = fileSchemaById(schemaId);
  if (schema === undefined) {
    return undefined;
  }
  return {
    schema,
    produce: (state) => {
      if (state.source === undefined) {
        return ok(undefined);
      }
      const document = toRecord(JSON.parse(state.source));
      if (document === undefined) {
        return ok(undefined);
      }
      if (pick === 'apps-array') {
        const apps = toArray(document['apps']) ?? [];
        const kept = apps.filter((app) => toRecord(app)?.['id'] !== id);
        return kept.length === apps.length ? ok(undefined) : ok(serialize(schema, { ...document, apps: kept }));
      }
      const map = toRecord(document['apps']) ?? {};
      if (!Object.hasOwn(map, id)) {
        return ok(undefined);
      }
      return ok(serialize(schema, { ...document, apps: Object.fromEntries(Object.entries(map).filter(([key]) => key !== id)) }));
    },
  };
}

function serialize(schema: NonNullable<ReturnType<typeof fileSchemaById>>, document: Record<string, unknown>): string {
  return schema.serialize === undefined ? `${JSON.stringify(document, undefined, 2)}\n` : schema.serialize(document);
}

export const appsRemove: Handler = (context) => {
  const id = context.args['app'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    return refused('apps remove <app id>', 'usage');
  }
  const folder = path.join(context.root, '.stacki', 'apps', id);
  const lockSchema = fileSchemaById('apps');
  const lock = lockSchema === undefined ? undefined : readFileState(context.root, lockSchema);
  const listed = lock?.ok === true && lock.value.source !== undefined && lock.value.source.includes(`"${id}"`);
  if (!fs.existsSync(folder) && !listed) {
    return refused(`"${id}" is not installed.`, 'missing');
  }
  const none: readonly BundleFile[] = [];
  const files = fs.existsSync(folder) ? folderFiles(context.root, id) : ok(none);
  if (!files.ok) {
    return files;
  }
  const edits = [withoutApp('apps', id, 'apps-array'), withoutApp('cli', id, 'apps-map'), withoutApp('appSettings', id, 'apps-map')].flatMap(
    (edit) => edit ?? [],
  );
  const effects: readonly EffectRecord[] = files.value.length === 0 ? [] : [{ kind: 'files-delete', data: { files: inEntries(files.value, id) } }];
  return ok({
    kind: 'write',
    edits,
    effects,
    summary: `Remove the ${id} app: ${files.value.length} files, its lock entry, its trust record and its non-secret settings.`,
    notes: ['The app\'s sealed secrets live in the app vault outside the project and are not touched. "stacki undo" puts the folder back byte for byte.'],
  } satisfies Outcome);
};
