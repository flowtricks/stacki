// The content collections' IPC: the project's content config, its entries,
// validation, renames across references, and sample data for the canvas.
import path from 'node:path';

import { definedFields, record } from '../../shared/core/boundary';
import { assert } from '../../shared/core/assert';
import { parseValidationResult, parseContentConfig, parseSampleEntry, parseSampleValue } from '../app/mainValidation';
import { resolveImport } from '../content/cmsRefs';
import { readContentConfig, validateEntry } from '../content/contentConfig';
import { listEntries, writeEntry, countEntries, coveredPaths } from '../content/contentEntries';
import { planRename, applyRename } from '../content/contentRefs';
import { astroRemoteService, type AstroRemoteService } from '../content/astroRemoteService';
import type { AstroRemoteEdit, AstroRemoteEditAnswer, AstroRemoteRead, AstroRemoteReadAnswer } from '../../shared/properties/astroContent';
import type { RemoteResult } from '../../shared/properties/cmsRemote';
import { errorMessage, toPosix } from '../lib/mainHelpers';
import { collectionOf } from './cmsFiles';
import type { MainHost } from './mainHost';

export function registerContentHandlers(host: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send' | 'shell'>): void {
  registerContentConfigHandlers(host);
  registerContentRenameHandlers(host);
  registerContentRemoteHandlers(host);
}

// The CMS panel's reads and edits of content collections, answered as a
// connected CMS's are (astroRemoteService.ts): an expected failure — a config
// that will not load, an entry deleted meanwhile — is an answer the panel
// shows, not a crash.
function registerContentRemoteHandlers({ ipcMain, noteAppWrite, send, shell }: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send' | 'shell'>): void {
  const service = (projectPath: string) =>
    astroRemoteService(projectPath, {
      readConfig: async () => parseContentConfig(await readContentConfig(projectPath)),
      trash: (file) => shell.trashItem(file),
    });
  ipcMain.handle('content:remoteRead', async (_event, { projectPath, request }) => answered(() => readRemote(service(projectPath), request)));
  ipcMain.handle('content:remoteEdit', async (_event, { projectPath, request }) => {
    const result = await answered(() => editRemote(service(projectPath), request));
    noteAppWrite();
    send('cms:changed', {});
    return result;
  });
}

function readRemote(service: AstroRemoteService, request: AstroRemoteRead): Promise<AstroRemoteReadAnswer> {
  switch (request.operation) {
    case 'collections':
      return service.collections();
    case 'documents':
      return service.documents(request.collection, request.columns);
    case 'document':
      return service.document(request.id);
    case 'template':
      return service.template(request.collection);
    case 'settings':
      return service.settings(request.collection);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

function editRemote(service: AstroRemoteService, request: AstroRemoteEdit): Promise<AstroRemoteEditAnswer> {
  switch (request.operation) {
    case 'write':
      return service.write(request.write);
    case 'create':
      return service.create(request.collection);
    case 'delete':
      return service.remove(request.ids);
    case 'createCollection':
      return service.createCollection(request.name);
    case 'settings':
      return service.changeSettings(request.collection, request.change);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

async function answered<T>(run: () => Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    const message = errorMessage(error).slice(0, 900);
    return { ok: false, message: message || 'The content collection could not be read.' };
  }
}

function registerContentConfigHandlers({ ipcMain, noteAppWrite, send }: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send'>): void {
  // What the project's content config declares: every collection, where its
  // entries live, whether they can be written at all, and the JSON Schema its
  // zod schema amounts to. Read from the config itself rather than inferred from
  // the data, so the editor enforces the same rules the build does — see
  // contentConfig.js for how, and why it happens in a child process.
  ipcMain.handle('content:config', async (_event, { projectPath, force }) => parseContentConfig(await readContentConfig(projectPath, { force: !!force })));

  ipcMain.handle('content:collections', async (_event, projectPath) => {
    const config = parseContentConfig(await readContentConfig(projectPath));
    if (config.missing || config.error) {
      return { ...config, collections: [] };
    }
    const collections = (config.collections || []).map((collection) => ({
      name: collection.name,
      editable: collection.editable,
      loader: collection.loader,
      hasSchema: !!collection.schema,
      freeform: !!collection.freeform,
      error: collection.error || undefined,
      count: countEntries(projectPath, collection),
    }));
    return {
      collections,
      covered: coveredPaths(projectPath, config.collections || []),
      configPath: config.configPath,
    };
  });

  ipcMain.handle('content:entries', async (_event, { projectPath, name }) => {
    const { collection } = await collectionOf(projectPath, name);
    return { collection, ...listEntries(projectPath, collection) };
  });

  // A save is a list of edits against one entry, not a new copy of the file: see
  // contentEntries.js and ./formats for what that protects.
  ipcMain.handle('content:writeEntry', async (_event, { projectPath, entry, edits, body, expected }) => {
    const result = writeEntry(projectPath, entry, edits || [], definedFields({ body, expected }));
    noteAppWrite();
    send('cms:changed', {});
    return result;
  });

  ipcMain.handle('content:validate', async (_event, { projectPath, collection, data }) =>
    parseValidationResult(await validateEntry(projectPath, { collection, data })),
  );

  // What renaming an entry's id would change, and then changing it. Two calls,
  // because an id is what every reference to the entry holds: the plan is shown
  // before anything is written, so a rename that would touch six other entries
  // says so first.
  ipcMain.handle('content:renamePlan', async (_event, { projectPath, name, from, to }) => {
    const config = parseContentConfig(await readContentConfig(projectPath));
    const plan = planRename(
      projectPath,
      config.collections.map((collection) => ({
        ...collection,
        loader: collection.loader ?? { kind: 'none' },
      })),
      { collection: name, from, to },
    );
    // The entry data itself is big and the renderer only needs the shape of the
    // change.
    return { ...plan, entry: { id: plan.entry.id, file: plan.entry.file } };
  });
}

function registerContentRenameHandlers({ ipcMain, noteAppWrite, send }: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send'>): void {
  ipcMain.handle('content:rename', async (_event, { projectPath, name, from, to }) => {
    const config = parseContentConfig(await readContentConfig(projectPath));
    const plan = planRename(
      projectPath,
      config.collections.map((collection) => ({
        ...collection,
        loader: collection.loader ?? { kind: 'none' },
      })),
      { collection: name, from, to },
    );
    const result = applyRename(projectPath, plan);
    if (result.files.length > 0) {
      noteAppWrite();
    }
    send('cms:changed', {});
    return result;
  });

  // Every entry of a collection something can point at, as id and label — what a
  // reference field offers instead of asking the user to remember ids.
  ipcMain.handle('content:targets', async (_event, { projectPath, name }) => {
    const { collection } = await collectionOf(projectPath, name);
    const { entries } = listEntries(projectPath, collection);
    return { targets: entries.map((entry) => ({ id: entry.id, title: entry.title })) };
  });

  // One entry of a collection, sampled — what a picker shows beside the fields
  // of a page that lists them. Answered by the dev server because only it can
  // run the project's loaders; without one there is simply no sample.
  ipcMain.handle('content:sampleEntry', async (_event, { devUrl, name, id }) => {
    if (!devUrl || !name) {
      return { entry: undefined };
    }
    try {
      const query = `c=${encodeURIComponent(name)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
      const first = await fetchSampleEntry(`${devUrl}/__avb/data?${query}`);
      if (first.error !== undefined) {
        return first;
      }
      if (first.entry !== undefined && first.entry !== null) {
        return first;
      }
      // None read: the dev server's content store can be stale (see the
      // refresh hook in markerConfig), so it syncs once and is asked again.
      const refreshed = await fetch(`${devUrl}/__avb/refresh`, { method: 'POST' });
      if (!refreshed.ok) {
        // An Astro without the refresh hook answers 404: the empty read stands.
        return first;
      }
      // A sync that fails names the entry its schema rejects: that is the answer.
      const refreshError = optionalText(record(await refreshed.json())['error']);
      if (refreshError !== undefined) {
        return { entry: undefined, error: refreshError };
      }
      return await fetchSampleEntry(`${devUrl}/__avb/data?${query}`);
    } catch (error: unknown) {
      return { entry: undefined, error: errorMessage(error) };
    }
  });

  // What a page's own data call returns — `await getCampusPastors()` — sampled
  // by the dev server, which runs it as the page's render does. The import is
  // resolved here, so only a project module under src is ever asked for.
  ipcMain.handle('content:sampleValue', async (_event, { projectPath, devUrl, pagePath, spec, name }) => {
    const target = devUrl ? resolveImport(projectPath, pagePath, spec) : undefined;
    const rel = target ? toPosix(path.relative(projectPath, target)) : '';
    if (!devUrl || !rel.startsWith('src/')) {
      return { value: undefined };
    }
    try {
      const query = `m=${encodeURIComponent('/' + rel)}&f=${encodeURIComponent(name)}`;
      const response = await fetch(`${devUrl}/__avb/value?${query}`);
      if (!response.ok) {
        return { value: undefined, error: `Dev server returned ${response.status}` };
      }
      const input: unknown = await response.json();
      return parseSampleValue(input);
    } catch (error: unknown) {
      return { value: undefined, error: errorMessage(error) };
    }
  });

  // Where an import in a page actually points. The tag name is only a local
  // binding — `import Layout from '@/layouts/BaseLayout.astro'` renders as
  // <Layout> — so drilling into a component has to follow the import, not the
  // name.
  ipcMain.handle('project:resolveImport', async (_event, { projectPath, fromFile, spec }) => ({
    path: resolveImport(projectPath, fromFile, spec) ?? undefined,
  }));
}

async function fetchSampleEntry(url: string): Promise<ReturnType<typeof parseSampleEntry>> {
  assert(url.includes('/__avb/data?'), 'A sample is read from the data route');
  const response = await fetch(url);
  if (!response.ok) {
    return { entry: undefined, error: `Dev server returned ${response.status}` };
  }
  const input: unknown = await response.json();
  return parseSampleEntry(input);
}

// The refresh hook writes `null` for no error.
function optionalText(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined;
}
