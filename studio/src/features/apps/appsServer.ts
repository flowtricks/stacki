// Stacki Apps on the Studio server: the same install, update and approval flow
// as Desktop's main process (vendor/stacki/electron/project/appService.ts, one
// module for both), over HTTP, and the route app frames load their files from.
// GitHub is called from here, never from the browser. Installing, approving and
// removing need the admin role; the automatic update check does not, because it
// only records that an update is available. Files are served under the sandboxing content
// security policy, so an app document is an opaque origin even when opened on
// its own, and cannot act as Studio's origin or reach its API.
//
// The official marketplace is read and installed from here too: browsing needs
// `marketplace:view` and installing an approved version `marketplace:install`
// (serverAccess.ts gates both routes; this module checks again), not admin.
// Switching an app's auto-update is admin-only, like approving an update.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { createAppService, nodeInflateRaw } from '../../../vendor/stacki/electron/project/appService';
import { createAppPublishService } from '../../../vendor/stacki/electron/project/appPublishService';
import { createAppRepositoryPlaces } from '../../../vendor/stacki/electron/project/appRepositoryPlace';
import { listInstalledApps } from '../../../vendor/stacki/electron/project/appStore';
import { forgetAppSettings, readAppSettings, writeAppSettings } from '../../../vendor/stacki/electron/project/appSettingsStore';
import { parseAppSettingValues, parseAppSettingValuesReply } from '../../../vendor/stacki/shared/properties/appSettings';
import {
  parseAppRepositoryRef,
  parseAppScanTarget,
  parseAppShareRequest,
  parseMarketplaceSubmission,
  parseSharedReleaseSource,
} from '../../../vendor/stacki/shared/properties/appPublish';
import { studioSecretVault } from './appSettingsVault';
import { appAccessRoutes, studioBroker } from './appAccessServer';
import { createAppSignIns } from '../../../vendor/stacki/electron/project/appSignIn';
import { forgetAppStorage } from '../../../vendor/stacki/electron/project/appStorageStore';
import { studioAppData, studioLocalStorageDirectory, studioPersonKey, studioVersion } from './appDataServer';
import { readAppFile, readInstalledManifest } from '../../../vendor/stacki/electron/project/appStore';
import { appFolderRuns, readAppFolderStamps } from '../../../vendor/stacki/electron/project/appScan';
import { appConnectHosts } from '../../../vendor/stacki/shared/properties/appAuth';
import {
  marketplaceCheckURL,
  marketplaceIndexURL,
  marketplaceSubmissionsURL,
  type MarketplaceBuild,
} from '../../../vendor/stacki/electron/project/appMarketplace';
import {
  APP_LIMITS,
  APP_SDK_FILE,
  appsFailure,
  parseAppId,
  parseAppVersion,
  parseGitHubSource,
  parseReleaseTag,
  parseStagedToken,
} from '../../../vendor/stacki/shared/properties/apps';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import { appContentSecurityPolicy, appSdkSource } from '../../../vendor/stacki/shared/properties/appSdk';
import { appHostAsset, withAppTokens } from '../../../vendor/stacki/shared/properties/appUiKit';
import { requestRole } from '../roles/serverAccess';
import { record } from '../../shared/validation';

import { APP_FILES_PREFIX_PATH } from './appsPaths';
import { appsRefusal } from './appsRefusal';

/** Where app frames load from: `/studio/api/apps/files/<id>/<path>`. */
const APP_FILES_PREFIX = APP_FILES_PREFIX_PATH;

export function appsRoutes(root: string) {
  const service = createAppService({
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    marketplaceIndexURL: marketplaceIndexURL(process.env, studioBuild()),
    stackiVersion: studioVersion(),
  });
  // Studio holds no person's GitHub sign-in: publishing reads public repositories and
  // the marketplace; creating or changing a repository answers that it needs Desktop.
  const publishing = createAppPublishService({
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    tokenFor: undefined,
    inflateRaw: nodeInflateRaw,
    deflateRaw: (data) => new Uint8Array(deflateRawSync(data)),
    submissionsURL: marketplaceSubmissionsURL(process.env, studioBuild()),
    checkURL: marketplaceCheckURL(process.env, studioBuild()),
  });
  // A GitHub app's repository visibility, for the Apps panel's pills. Studio holds no
  // person's token, so it reads anonymously: "public" when GitHub confirms it, else nothing.
  const places = createAppRepositoryPlaces({
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    tokenFor: undefined,
    marketplace: async () => {
      const index = await service.marketplace('cached');
      return index.ok ? index.value : undefined;
    },
  });
  const vault = studioSecretVault();
  const appData = studioAppData(root);
  // Project files and OAuth sign-ins (appAccessServer.ts), with this vault.
  const access = appAccessRoutes(root, vault);
  return async (request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>): Promise<boolean> => {
    if (await access.routes(request, response, pathname, readBody)) {
      return true;
    }
    if (pathname === '/studio/api/apps/storage/events' && request.method === 'GET') {
      await appData.subscribe(request, response);
      return true;
    }
    if (pathname.startsWith(APP_FILES_PREFIX) && (request.method === 'GET' || request.method === 'HEAD')) {
      serveFile(root, request, response, pathname.slice(APP_FILES_PREFIX.length));
      return true;
    }
    if (pathname === '/studio/api/apps' && request.method === 'GET') {
      send(response, service.list(root));
      return true;
    }
    // Apps added as a folder: the folders that do not read as an app, and the stamps the editor polls (appFoldersClient.ts).
    if (pathname === '/studio/api/apps/folders' && request.method === 'GET') {
      send(response, service.folders(root));
      return true;
    }
    if (pathname === '/studio/api/apps/stamps' && request.method === 'GET') {
      send(response, readAppFolderStamps(root));
      return true;
    }
    if (!pathname.startsWith('/studio/api/apps/') || request.method !== 'POST') {
      return false;
    }
    const action = pathname.slice('/studio/api/apps/'.length);
    if (action === 'updates') {
      const input = record(JSON.parse((await readBody()) || '{}'));
      send(response, await service.checkUpdates(root, input['force'] === true));
      return true;
    }
    if (action === 'marketplace' || action === 'marketplace/install') {
      send(response, await marketplaceAction(root, service, action, request, readBody));
      return true;
    }
    // serverAccess.ts gates this on `panel:apps`; the id names an installed app, so only its repository is read.
    if (action === 'visibility') {
      const input = record(JSON.parse((await readBody()) || '{}'));
      send(response, await places.place(root, parseAppId(input['id'])));
      return true;
    }
    if (action.startsWith('publish/')) {
      send(response, await publishAction(root, publishing, action.slice('publish/'.length), request, readBody));
      return true;
    }
    if (action === 'storage/get' || action === 'storage/set' || action === 'storage/keys' || action === 'person' || action === 'people' || action === 'host') {
      send(response, await appData.answer(action, request, readBody));
      return true;
    }
    if (action === 'settings/read' || action === 'settings/write') {
      send(response, await settingsAction(root, vault, action, request, readBody));
      return true;
    }
    if (!(await requestRole(root, request)).isAdmin) {
      send(response, appsRefusal('apps.error.adminOnly'));
      return true;
    }
    send(response, await adminAction(root, service, action, request, readBody));
    return true;
  };
}

async function adminAction(
  root: string,
  service: ReturnType<typeof createAppService>,
  action: string,
  request: IncomingMessage,
  readBody: () => Promise<string>,
) {
  if (action === 'upload') {
    const name = new URL(request.url ?? '/', 'http://studio').searchParams.get('name') ?? 'app.zip';
    try {
      return service.stageFile(root, await bodyBytes(request, APP_LIMITS.archiveBytesMax), name);
    } catch (error: unknown) {
      return { ok: false, ...appsFailure(error) };
    }
  }
  const input = record(JSON.parse((await readBody()) || '{}'));
  switch (action) {
    case 'github':
      return service.stageGitHub(root, publicSource(input['source']), input['tag'] === undefined ? undefined : parseReleaseTag(input['tag']));
    case 'releases': {
      const source = publicSource(input['source']);
      return service.releases(source.owner, source.repository, undefined);
    }
    case 'commit':
      return service.commit(root, parseStagedToken(input['token']));
    case 'discard':
      service.discard(parseStagedToken(input['token']));
      return { ok: true };
    case 'uninstall': {
      const id = parseAppId(input['id']);
      const result = service.uninstall(root, id);
      if (result.ok) {
        // A removed app's settings go with it, its secrets included, and so do its stored values.
        forgetAppSettings(root, studioSecretVault(), id);
        forgetAppSignIns(root, id);
        forgetAppStorage(root, studioLocalStorageDirectory(root, studioPersonKey(request)), id);
      }
      return result;
    }
    case 'update':
      return service.applyUpdate(root, parseAppId(input['id']));
    case 'auto-update': {
      if (typeof input['autoUpdate'] !== 'boolean') {
        return { ok: false, message: 'autoUpdate must be true or false' }; // i18n-ignore: protocol or programmer error answered to the Studio client, not text for the person.
      }
      return service.setAutoUpdate(root, parseAppId(input['id']), { autoUpdate: input['autoUpdate'] });
    }
    default:
      return { ok: false, message: 'Unknown app action' }; // i18n-ignore: protocol or programmer error answered to the Studio client, not text for the person.
  }
}

// Browsing and installing from the marketplace, each by its own role feature.
async function marketplaceAction(
  root: string,
  service: ReturnType<typeof createAppService>,
  action: 'marketplace' | 'marketplace/install',
  request: IncomingMessage,
  readBody: () => Promise<string>,
) {
  const role = await requestRole(root, request);
  const input = record(JSON.parse((await readBody()) || '{}'));
  if (action === 'marketplace') {
    if (!can(role, 'marketplace:view')) {
      return appsRefusal('apps.error.noMarketplace');
    }
    return service.marketplace(input['refresh'] === true ? 'fresh' : 'cached');
  }
  if (!can(role, 'marketplace:install')) {
    return appsRefusal('apps.error.noMarketplaceInstall');
  }
  return service.installMarketplace(root, parseAppId(input['id']), parseAppVersion(input['version']));
}

// Sharing and publishing, each by its own role feature (serverAccess.ts gates the routes; this checks again).
async function publishAction(
  root: string,
  publishing: ReturnType<typeof createAppPublishService>,
  action: string,
  request: IncomingMessage,
  readBody: () => Promise<string>,
) {
  const role = await requestRole(root, request);
  const input = record(JSON.parse((await readBody()) || '{}'));
  const mayShare = can(role, 'apps:share');
  const mayPublish = can(role, 'marketplace:publish');
  switch (action) {
    case 'scan': {
      if (!mayShare && !mayPublish) {
        return appsRefusal('apps.error.noShareOrPublish');
      }
      const target = parseAppScanTarget(input['target']);
      return target.kind === 'installed'
        ? publishing.scanInstalled(root, target.id)
        : publishing.scanRepository(target.owner, target.repository, target.account);
    }
    case 'status': {
      if (!mayShare && !mayPublish) {
        return appsRefusal('apps.error.noShareOrPublish');
      }
      const ref = parseAppRepositoryRef(input['repository']);
      return publishing.status(ref.owner, ref.repository, ref.account);
    }
    case 'share':
      return mayShare ? publishing.share(root, parseAppShareRequest(input['share']), () => undefined) : appsRefusal('apps.error.noShare');
    case 'switch-source':
      return mayShare ? publishing.switchSource(root, parseAppId(input['id']), parseSharedReleaseSource(input['source'])) : appsRefusal('apps.error.noShare');
    case 'make-public': {
      const ref = parseAppRepositoryRef(input['repository']);
      return mayPublish ? publishing.makePublic(ref.owner, ref.repository, ref.account) : appsRefusal('apps.error.noPublish');
    }
    case 'add-license': {
      const ref = parseAppRepositoryRef(input['repository']);
      return mayPublish ? publishing.addLicense(ref.owner, ref.repository, ref.account) : appsRefusal('apps.error.noPublish');
    }
    case 'check': {
      const ref = parseAppRepositoryRef(input['repository']);
      return mayPublish ? publishing.precheck(ref.owner, ref.repository, ref.account) : appsRefusal('apps.error.noPublish');
    }
    case 'submit':
      return mayPublish ? publishing.submit(parseMarketplaceSubmission(input['submission'])) : appsRefusal('apps.error.noPublish');
    default:
      return { ok: false, message: 'Unknown publish action' }; // i18n-ignore: protocol or programmer error answered to the Studio client, not text for the person.
  }
}

// One installed app's settings: anyone who can open apps reads and fills in theirs.
async function settingsAction(
  root: string,
  vault: ReturnType<typeof studioSecretVault>,
  action: 'settings/read' | 'settings/write',
  request: IncomingMessage,
  readBody: () => Promise<string>,
) {
  const role = await requestRole(root, request);
  if (!can(role, 'panel:apps')) {
    return appsRefusal('apps.error.noApps');
  }
  const input = record(JSON.parse((await readBody()) || '{}'));
  const id = parseAppId(input['id']);
  try {
    const app = listInstalledApps(root).find((summary) => summary.manifest.id === id);
    if (app === undefined) {
      return appsRefusal('apps.error.notInstalled', { id });
    }
    if (action === 'settings/read') {
      return { ok: true, value: readAppSettings(root, vault, app.manifest) };
    }
    const values = parseAppSettingValues(parseAppSettingValuesReply(input['values']), app.manifest.settings);
    return { ok: true, value: writeAppSettings(root, vault, app.manifest, values) };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, ...appsFailure(error) };
  }
}

// Only a local Studio run for development reads another marketplace index; the hosted one never does.
function studioBuild(): MarketplaceBuild {
  if (process.env['STUDIO_CONTAINER_TOKEN']) {
    return 'release';
  }
  return process.env['NODE_ENV'] === 'development' ? 'development' : 'release';
}

function serveFile(root: string, request: IncomingMessage, response: ServerResponse, rest: string): void {
  const slash = rest.indexOf('/');
  let id: string;
  let filePath: string;
  try {
    id = parseAppId(slash < 0 ? rest : rest.slice(0, slash));
    filePath = decodeURIComponent(slash < 0 ? '' : rest.slice(slash + 1)) || 'index.html';
  } catch {
    response.writeHead(400).end();
    return;
  }
  // The folder decides (appScan.ts): a folder that reads as this app is served, a broken or missing one is not.
  if (!appFolderRuns(root, id)) {
    response.writeHead(404).end();
    return;
  }
  // The frame connects only to what its manifest declares (appSdk.ts appContentSecurityPolicy).
  let connectHosts: readonly string[];
  try {
    const manifest = readInstalledManifest(root, id);
    connectHosts = appConnectHosts(manifest.network, manifest.auth);
  } catch {
    response.writeHead(404).end();
    return;
  }
  const host = request.headers.host ?? 'localhost';
  const scheme = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const headers = {
    'Content-Security-Policy': appContentSecurityPolicy(`${scheme}://${host}${APP_FILES_PREFIX}${id}/`, connectHosts),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The frame is an opaque origin, so its own files are cross-origin to it: `fetch('config.json')`
    // needs this. They are the app's public bundle, so `*` opens nothing new (appsHandlers.ts APP_FILE_CORS_HEADERS).
    'Access-Control-Allow-Origin': '*',
  };
  if (filePath === APP_SDK_FILE) {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' }).end(appSdkSource());
    return;
  }
  // The UI kit's reserved folder (appUiKit.ts): the host answers it, never the bundle, as on Desktop.
  const kit = appHostAsset(filePath);
  if (kit.kind === 'kit') {
    response.writeHead(200, { ...headers, 'Content-Type': kit.type }).end(request.method === 'HEAD' ? undefined : kit.body);
    return;
  }
  if (kit.kind === 'reserved') {
    response.writeHead(404, headers).end();
    return;
  }
  let file: ReturnType<typeof readAppFile>;
  try {
    file = readAppFile(root, id, filePath);
  } catch {
    file = undefined;
  }
  if (file === undefined) {
    response.writeHead(404, headers).end();
    return;
  }
  // Every HTML document carries the design tokens, so `var(--stacki-accent)` works without opting in.
  response.writeHead(200, { ...headers, 'Content-Type': file.type }).end(request.method === 'HEAD' ? undefined : Buffer.from(withAppTokens(file)));
}

// Studio reads repositories as public: it holds no person's GitHub sign-in to lend.
function publicSource(input: unknown) {
  const { account: _account, ...source } = parseGitHubSource(input);
  return source;
}

async function bodyBytes(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const input of request) {
    const value: unknown = input;
    if (!Buffer.isBuffer(value)) {
      throw new Error('Invalid upload');
    }
    size += value.length;
    if (size > maximum) {
      throw new Error(`The app file exceeds ${maximum} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

// A removed app's sign-ins go with it. The engine's own `forget` needs the routes' instance; the
// sealed file is per project, so a fresh engine over the same vault forgets the same tokens.
function forgetAppSignIns(root: string, id: string): void {
  createAppSignIns({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), vault: studioSecretVault(), broker: studioBroker() }).forget(root, id);
}
