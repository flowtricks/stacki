// Answers Studio's HTTP routes from the snapshot. Reads return what the server's own
// scanner returned at bake time. Writes the finished page cannot honour answer with
// a plain reason, which the client shows as it shows any server refusal.
import type { BakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { METADATA_FILES, metadataKind, parseMetadataWrite, validateMetadata } from '../vendor/stacki/shared/properties/projectMetadata';
import { managedAsset } from '../src/features/assets/assetStateTypes';
import { record, sourcePath, string } from '../src/shared/validation';
import { UPLOAD_LIMITS, type DemoFiles } from './projectFiles';
import { DEMO_PUBLISH_SOURCE, type DemoPublish } from './publish';
import { publishAccount, publishDiscovery, publishRepositories } from './publishConnections';
import type { DemoRooms } from './room';
import { componentUsage } from './componentUsage';
import { pageAddress } from './pageAddress';
import { contentOperation } from './contentRoutes';
import { bakedTemplateEntries } from './templateEntries';
import type { DemoRoutes } from './fetchStandIn';
import { editDemoVariables, readDemoVariables, type VariableFiles } from './variables';

export const FEATURE_REASON = 'This needs the full Stacki app.';
export const UPLOAD_FOLDER_REASON = 'In the demo, uploads go to public/, the folder the finished site serves.';
export const ASSET_CHANGE_REASON = 'Renaming, moving and deleting files is in the full Stacki app.';
export const SETTINGS_CONFLICT = 'Project settings changed. Reload before saving.';

export interface RouteContext {
  readonly snapshot: BakeSnapshot;
  readonly rooms: DemoRooms;
  /** Settings files the bake did not have, and uploads. */
  readonly files: DemoFiles;
  readonly publish: DemoPublish;
  readonly workspace: string;
  readonly unknownRoute: (path: string) => void;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

function previewURL(context: RouteContext, url: URL): Response {
  const route = url.searchParams.get('page') ?? '/';
  const page = context.snapshot.pages.find((candidate) => candidate.route === route);
  if (page === undefined) {
    return json(400, { error: 'This page is not part of the demo.' });
  }
  // The address the site serves the page at, so a flat 404.html opens as /404 and the
  // frame's reported path still ends in the page's route (see canvasRoute.ts).
  const path = pageAddress(page).slice(1);
  // The interactive preview is the visitor's page, as Studio's server answers it
  // (integration.ts): `#avb-design` would make the frame client treat it as the
  // canvas and keep every click for selection.
  const hash = url.searchParams.get('mode') === 'interactive' ? '#avb-preview' : '#avb-design';
  return json(200, { url: `${context.snapshot.base}${path}${hash}`, origin: location.origin });
}

function styleFiles(context: RouteContext, astro: boolean): Response {
  const files = Object.entries(context.snapshot.sources)
    .filter(([file, source]) => (astro ? file.endsWith('.astro') && /<style\b[^>]*\bis:global\b[^>]*>/i.test(source) : file.endsWith('.css')))
    .map(([file, source]) => ({ rel: file, path: file, name: file.split('/').at(-1), size: source.length }));
  return json(200, { files });
}

function saveSource(context: RouteContext, init: RequestInit | undefined): Response {
  const data = record(JSON.parse(bodyText(init)));
  const file = sourcePath(data['file']);
  const room = context.rooms.get(file);
  if (room.text.toString() !== string(data['base'])) {
    return json(400, { error: 'This file changed. Reload the style panel before editing again.' });
  }
  room.setSource(string(data['source']));
  return json(200, { ok: true });
}

function readFile(context: RouteContext, url: URL): Response {
  const file = sourcePath(url.searchParams.get('file'));
  const source = context.rooms.read(file);
  return source === undefined ? json(404, { error: 'This file is not part of the demo.' }) : json(200, { file, source });
}

/** A settings file as the visitor has it: through its room when baked, else as saved here. */
function settingsSource(context: RouteContext, file: string): string | undefined {
  const source = context.rooms.read(file) ?? context.files.text(file);
  // A site without publish settings would make Publish ask for hosting first.
  return source === undefined && file === METADATA_FILES.publish ? DEMO_PUBLISH_SOURCE : source;
}

function metadataFile(context: RouteContext, url: URL): { readonly source?: string } {
  const source = settingsSource(context, METADATA_FILES[metadataKind(url.searchParams.get('kind'))]);
  return source === undefined ? {} : { source };
}

// The server's save, without a disk: the caller's base must still be current, and a
// file the bake had is written through its room so the client's copy follows.
function saveMetadata(context: RouteContext, init: RequestInit | undefined): Response {
  const input = parseMetadataWrite(JSON.parse(bodyText(init)));
  validateMetadata(input.kind, input.source);
  const file = METADATA_FILES[input.kind];
  if (settingsSource(context, file) !== input.base) {
    return json(400, { error: SETTINGS_CONFLICT });
  }
  if (context.snapshot.sources[file] === undefined) {
    context.files.setText(file, input.source);
  } else {
    context.rooms.get(file).setSource(input.source);
  }
  return json(200, { source: settingsSource(context, file) });
}

function variableFiles(context: RouteContext): VariableFiles {
  return {
    sources: () => {
      const sources = new Map<string, string>();
      for (const file of Object.keys(context.snapshot.sources)) {
        const source = context.rooms.read(file);
        if (source !== undefined) {
          sources.set(file, source);
        }
      }
      return sources;
    },
    write: (file, source) => context.rooms.get(file).setSource(source),
  };
}

function assetCatalog(context: RouteContext): Response {
  const baked = record(context.snapshot.assets);
  const entries = Array.isArray(baked['entries']) ? baked['entries'] : [];
  return json(200, { ...baked, entries: [...entries, ...context.files.uploads()] });
}

function bakedAsset(context: RouteContext, file: string): boolean {
  const entries = record(context.snapshot.assets)['entries'];
  return Array.isArray(entries) && entries.some((entry: unknown) => typeof entry === 'object' && entry !== null && 'rel' in entry && entry.rel === file);
}

async function upload(context: RouteContext, url: URL, init: RequestInit | undefined): Promise<Response> {
  const file = managedAsset(url.searchParams.get('file'));
  if (!file.startsWith('public/')) {
    return json(400, { error: UPLOAD_FOLDER_REASON });
  }
  if (bakedAsset(context, file) || context.files.hasUpload(file)) {
    return json(400, { error: 'An asset with this name already exists' });
  }
  if (context.files.uploadCount() >= UPLOAD_LIMITS.filesMax) {
    return json(400, { error: `The demo keeps at most ${UPLOAD_LIMITS.filesMax} uploads.` });
  }
  const body = init?.body;
  const blob = body instanceof Blob ? body : new Blob([await new Response(body ?? null).arrayBuffer()]);
  if (blob.size > UPLOAD_LIMITS.bytesMax) {
    return json(400, { error: 'Upload exceeds 20 MB' });
  }
  context.files.addUpload(file, blob);
  return json(201, { file });
}

function readRoute(context: RouteContext, url: URL): Response | undefined {
  switch (url.pathname) {
    case '/studio/api/session':
      // Draft editing is what shows Studio's Publish button; the demo simulates it.
      return json(200, { kind: 'local', editing: 'draft' });
    case '/studio/api/status':
      return json(200, { publishing: context.publish.poll() });
    case '/studio/api/publish/availability':
      return json(200, context.publish.availability());
    case '/studio/api/publish/site-url':
      return json(200, {}); // The demo's site has no domain of its own to link to.
    case '/studio/api/project':
      return json(200, { ...context.snapshot.project, workspaceId: context.workspace });
    case '/studio/api/assets':
      return assetCatalog(context);
    case '/studio/api/variables':
      return json(200, readDemoVariables(variableFiles(context)));
    case '/studio/api/preview-url':
      return previewURL(context, url);
    case '/studio/api/page-entries':
      return json(200, bakedTemplateEntries(context.snapshot.pages, sourcePath(url.searchParams.get('page'))));
    case '/studio/api/file':
      return readFile(context, url);
    case '/studio/api/metadata':
      return json(200, metadataFile(context, url));
    case '/studio/api/styles':
      return styleFiles(context, url.searchParams.has('astro'));
    case '/studio/api/component-usage':
      return usage(context, url);
    default:
      return undefined;
  }
}

function cms(context: RouteContext, init: RequestInit | undefined): Response {
  const data = record(JSON.parse(bodyText(init)));
  const files = {
    read: (file: string) => context.rooms.read(file),
    baked: (file: string) => context.snapshot.sources[file],
    write: (file: string, text: string) => context.rooms.get(file).setSource(text),
  };
  try {
    return json(200, { value: contentOperation(context.snapshot.content, string(data['operation'], 50), data['payload'], files), versions: {} });
  } catch (error: unknown) {
    return json(400, { error: error instanceof Error ? error.message : 'The collection could not be read.' });
  }
}

function usage(context: RouteContext, url: URL): Response {
  const sources = new Map<string, string>();
  for (const file of Object.keys(context.snapshot.sources)) {
    const source = context.rooms.read(file);
    if (source !== undefined) {
      sources.set(file, source);
    }
  }
  const file = url.searchParams.get('file');
  const counted = componentUsage(sources, file === null ? undefined : sourcePath(file));
  return json(200, file === null ? counted.map(({ file: component, total }) => ({ file: component, total })) : counted[0]);
}

async function writeRoute(context: RouteContext, url: URL, init: RequestInit | undefined): Promise<Response | undefined> {
  switch (url.pathname) {
    case '/studio/api/metadata':
      return saveMetadata(context, init);
    case '/studio/api/variables':
      return json(200, editDemoVariables(variableFiles(context), JSON.parse(bodyText(init))));
    case '/studio/api/upload':
      return upload(context, url, init);
    case '/studio/api/publish':
      return json(200, context.publish.start(url.searchParams.get('target') ?? undefined));
    case '/studio/api/publish/discover':
      return json(200, publishDiscovery(JSON.parse(bodyText(init))));
    case '/studio/api/publish/repository':
      return json(200, publishRepositories(JSON.parse(bodyText(init))));
    case '/studio/api/publish/account':
      return json(200, publishAccount(JSON.parse(bodyText(init))));
    case '/studio/api/assets':
      return json(403, { error: ASSET_CHANGE_REASON });
    case '/studio/api/cms':
      return cms(context, init);
    default:
      return undefined;
  }
}

export function demoRoutes(context: RouteContext): DemoRoutes {
  return async (url, init) => {
    try {
      const method = init?.method ?? 'GET';
      if (url.pathname === '/studio/api/source' && method === 'POST') {
        return saveSource(context, init);
      }
      if (method === 'POST') {
        const written = await writeRoute(context, url, init);
        if (written !== undefined) {
          return written;
        }
      }
      if (url.pathname === '/studio/api/sync') {
        return json(200, { kind: 'idle' }); // No repository, so nothing is ever behind.
      }
      const read = method === 'GET' ? readRoute(context, url) : undefined;
      if (read !== undefined) {
        return read;
      }
      context.unknownRoute(`${method} ${url.pathname}`);
      return json(403, { error: FEATURE_REASON });
    } catch (error: unknown) {
      return json(400, { error: error instanceof Error ? error.message : 'Request failed' });
    }
  };
}
