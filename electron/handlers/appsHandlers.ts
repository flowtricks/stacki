// Stacki Apps over IPC, and the `stacki-app:` protocol app frames load from.
// Every network call (GitHub releases) runs here in main, never in the renderer
// (electron/project/appService.ts). The protocol serves an installed app's files
// from the open project's `.stacki/apps/<id>/` only, each document under the
// sandboxing content security policy (shared/properties/appSdk.ts), plus the SDK
// at `stacki-sdk.js`. `stacki-app://<id>/` is one origin per app.
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { MainHost } from './mainHost';
import { APP_LIMITS, APP_SDK_FILE, APPS_DIRECTORY, appsFailure, parseAppId, type AppManifest, type AppsResult } from '../../shared/properties/apps';
import { appContentSecurityPolicy, appSdkSource } from '../../shared/properties/appSdk';
import { appHostAsset, withAppTokens } from '../../shared/properties/appUiKit';
import { deflateRawSync } from 'node:zlib';
import { parseAppSettingValues } from '../../shared/properties/appSettings';
import { createAppService, nodeInflateRaw, type AppService } from '../project/appService';
import { createAppPublishService } from '../project/appPublishService';
import { createAppRepositoryPlaces } from '../project/appRepositoryPlace';
import { appFolderRuns } from '../project/appScan';
import { listInstalledApps, readAppFile, readInstalledManifest } from '../project/appStore';
import { appConnectHosts } from '../../shared/properties/appAuth';
import { forgetAppStorage } from '../project/appStorageStore';
import { registerAppAccessHandlers } from './appAccessHandlers';
import { stackiBrokerOrigin } from '../../shared/properties/appConnections';
import { forgetAppSettings, readAppSettings, writeAppSettings, type SecretVault } from '../project/appSettingsStore';
import type { GitHubFetch } from '../project/appGitHub';
import { marketplaceCheckURL, marketplaceIndexURL, marketplaceSubmissionsURL, type MarketplaceBuild } from '../project/appMarketplace';
import { publishingGitEnvironment } from '../project/publishGitHub';
import { DEFAULT_PUBLISH_CONFIG } from '../../shared/properties/publishConfig';
import { translateMain } from '../lib/mainLocale';

export const APP_SCHEME = 'stacki-app';

/**
 * The `stacki-app:` scheme's privileges, registered before the app is ready
 * (main.ts). `corsEnabled` lets an app's opaque-origin frame fetch its own
 * files (`fetch('config.json')`), which serveAppRequest answers with
 * APP_FILE_CORS_HEADERS; the Electron test registers these same privileges.
 */
export const APP_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } as const;

/**
 * An app's frame is an opaque origin (`null`), so even its own files are
 * cross-origin to it: `fetch('config.json')` needs this answer. The files are
 * the app's public bundle, served to anyone who can load the frame, so `*`
 * opens nothing new; credentials are never allowed with it.
 */
export const APP_FILE_CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const;

export function registerAppsHandlers(
  host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'showOpenDialog' | 'noteAppWrite' | 'send' | 'shell'>,
  options: {
    /** A packaged app is a release: it reads the official marketplace index only. */
    readonly build: MarketplaceBuild;
    readonly fetcher?: GitHubFetch;
    /** Where app settings' secrets are sealed: outside every project (electron/project/appSettingsStore.ts). */
    readonly vault: SecretVault;
    /** This person's local app storage for a project (appDataHandlers.ts), which an uninstall clears. */
    readonly localStorageDirectory: (projectRoot: string) => string;
    /** Opens a sign-in's authorize page in the person's own browser (appAccessHandlers.ts). */
    readonly openBrowser: (url: string) => Promise<void>;
    /** This Stacki's version: an app that needs a newer one is refused on install and update. */
    readonly version: () => string;
  },
): AppService {
  const fetcher: GitHubFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  let tokenRoot: string | undefined;
  // A private repository is read with the token of the account signed in for publishing
  // (gh auth, publishGitHub.ts): the same sign-in, never a new one, and never given to an app.
  const tokenFor = async (account: string): Promise<string> => {
    if (tokenRoot === undefined) {
      throw new Error('Open a project to read GitHub with your account.');
    }
    const environment = await publishingGitEnvironment(tokenRoot, { ...DEFAULT_PUBLISH_CONFIG, githubAccount: account });
    const token = environment['GH_TOKEN'];
    if (token === undefined) {
      throw new Error(`Sign in with GitHub as ${account} to read its repositories.`);
    }
    return token;
  };
  const service = createAppService({
    fetch: fetcher,
    now: () => Date.now(),
    tokenFor,
    marketplaceIndexURL: marketplaceIndexURL(process.env, options.build),
    stackiVersion: options.version(),
  });
  const publishing = createAppPublishService({
    fetch: fetcher,
    now: () => Date.now(),
    tokenFor,
    inflateRaw: nodeInflateRaw,
    deflateRaw: (data) => new Uint8Array(deflateRawSync(data)),
    submissionsURL: marketplaceSubmissionsURL(process.env, options.build),
    checkURL: marketplaceCheckURL(process.env, options.build),
  });
  // A GitHub app's repository visibility, for the Apps panel's pills: the same token, cached (appRepositoryPlace.ts).
  const places = createAppRepositoryPlaces({
    fetch: fetcher,
    now: () => Date.now(),
    tokenFor,
    marketplace: async () => {
      const index = await service.marketplace('cached');
      return index.ok ? index.value : undefined;
    },
  });
  // The open project only, by its real path.
  const root = (projectPath: string): string => {
    const canonical = realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    tokenRoot = canonical;
    return canonical;
  };
  const { ipcMain } = host;
  // Project files and OAuth sign-ins, with the same open-project check and vault (appAccessHandlers.ts).
  const signIns = registerAppAccessHandlers(host, {
    root,
    vault: options.vault,
    openBrowser: options.openBrowser,
    broker: stackiBrokerOrigin(process.env, options.build),
  });
  ipcMain.handle('apps:list', (_event, input) => service.list(root(input.projectPath)));
  // Apps added as a folder: the folders that do not read as an app, and showing one in the file manager.
  ipcMain.handle('apps:folders', (_event, input) => service.folders(root(input.projectPath)));
  ipcMain.handle('apps:revealFolder', (_event, input) => {
    const project = root(input.projectPath);
    const folder = path.join(project, APPS_DIRECTORY, input.folder);
    host.assertInProject(folder);
    if (fs.existsSync(folder)) {
      host.shell.showItemInFolder(folder);
    }
    return { ok: true as const };
  });
  ipcMain.handle('apps:pickFile', async (_event, input) => {
    const project = root(input.projectPath);
    const picked = await host.showOpenDialog({
      title: translateMain('dialog.open.apps.title'),
      buttonLabel: translateMain('dialog.open.apps.button'),
      properties: ['openFile'],
      filters: [{ name: translateMain('dialog.open.apps.filter'), extensions: ['zip'] }],
    });
    const file = picked.canceled ? undefined : picked.filePaths[0];
    if (file === undefined) {
      return { ok: true as const, value: undefined };
    }
    const size = fs.statSync(file).size;
    if (size > APP_LIMITS.archiveBytesMax) {
      return { ok: false as const, message: translateMain('error.apps.fileTooLarge', { bytes: APP_LIMITS.archiveBytesMax }) };
    }
    return service.stageFile(project, new Uint8Array(fs.readFileSync(file)), path.basename(file));
  });
  ipcMain.handle('apps:stageGitHub', (_event, input) => service.stageGitHub(root(input.projectPath), input.source, input.tag));
  ipcMain.handle('apps:githubRepositories', (_event, input) => {
    root(input.projectPath);
    return service.repositories(input.account);
  });
  ipcMain.handle('apps:githubReleases', (_event, input) => {
    root(input.projectPath);
    return service.releases(input.source.owner, input.source.repository, input.source.account);
  });
  ipcMain.handle('apps:commit', (_event, input) => {
    const result = service.commit(root(input.projectPath), input.token);
    host.noteAppWrite();
    return result;
  });
  ipcMain.handle('apps:discard', (_event, input) => {
    service.discard(input.token);
    return { ok: true as const };
  });
  ipcMain.handle('apps:uninstall', (_event, input) => {
    const project = root(input.projectPath);
    const result = service.uninstall(project, input.id);
    if (result.ok) {
      // A removed app's settings go with it, its secrets included, and so do its stored values.
      forgetAppSettings(project, options.vault, input.id);
      forgetAppStorage(project, options.localStorageDirectory(project), input.id);
      signIns.forget(project, input.id);
    }
    return result;
  });
  ipcMain.handle('apps:checkUpdates', (_event, input) => service.checkUpdates(root(input.projectPath), input.force));
  ipcMain.handle('apps:applyUpdate', (_event, input) => service.applyUpdate(root(input.projectPath), input.id));
  ipcMain.handle('apps:setAutoUpdate', (_event, input) => service.setAutoUpdate(root(input.projectPath), input.id, { autoUpdate: input.autoUpdate }));
  ipcMain.handle('apps:repositoryVisibility', (_event, input) => places.place(root(input.projectPath), input.id));
  ipcMain.handle('apps:marketplace', (_event, input) => {
    root(input.projectPath);
    return service.marketplace(input.refresh === true ? 'fresh' : 'cached');
  });
  ipcMain.handle('apps:installMarketplace', async (_event, input) => {
    const result = await service.installMarketplace(root(input.projectPath), input.id, input.version);
    host.noteAppWrite();
    return result;
  });
  ipcMain.handle('apps:scanSecrets', (_event, input) => {
    const project = root(input.projectPath);
    const target = input.target;
    if (target.kind === 'installed') {
      return publishing.scanInstalled(project, target.id);
    }
    return publishing.scanRepository(target.owner, target.repository, target.account);
  });
  ipcMain.handle('apps:repositoryStatus', (_event, input) => {
    root(input.projectPath);
    return publishing.status(input.repository.owner, input.repository.repository, input.repository.account);
  });
  ipcMain.handle('apps:makePublic', (_event, input) => {
    root(input.projectPath);
    return publishing.makePublic(input.repository.owner, input.repository.repository, input.repository.account);
  });
  ipcMain.handle('apps:addLicense', (_event, input) => {
    root(input.projectPath);
    return publishing.addLicense(input.repository.owner, input.repository.repository, input.repository.account);
  });
  ipcMain.handle('apps:share', (_event, input) =>
    publishing.share(root(input.projectPath), input.share, (step) => host.send('apps:shareProgress', { id: input.share.id, step })),
  );
  ipcMain.handle('apps:switchSource', async (_event, input) => {
    const result = await publishing.switchSource(root(input.projectPath), input.id, input.source);
    host.noteAppWrite();
    return result;
  });
  ipcMain.handle('apps:checkMarketplace', (_event, input) => {
    root(input.projectPath);
    return publishing.precheck(input.repository.owner, input.repository.repository, input.repository.account);
  });
  ipcMain.handle('apps:submitMarketplace', (_event, input) => {
    root(input.projectPath);
    return publishing.submit(input.submission);
  });
  ipcMain.handle('apps:readSettings', (_event, input) =>
    settingsAction(root(input.projectPath), input.id, (project, manifest) => readAppSettings(project, options.vault, manifest)),
  );
  ipcMain.handle('apps:writeSettings', (_event, input) =>
    settingsAction(root(input.projectPath), input.id, (project, manifest) =>
      writeAppSettings(project, options.vault, manifest, parseAppSettingValues(input.values, manifest.settings)),
    ),
  );
  return service;
}

// One installed app's settings, by its manifest's declarations; an expected failure is a message.
function settingsAction<T>(project: string, id: string, run: (project: string, manifest: AppManifest) => T): AppsResult<T> {
  try {
    const app = listInstalledApps(project).find((summary) => summary.manifest.id === id);
    if (app === undefined) {
      return { ok: false, message: translateMain('error.apps.notInstalled', { id }) };
    }
    return { ok: true, value: run(project, app.manifest) };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, ...appsFailure(error) };
  }
}

/** Answers one `stacki-app://<id>/<path>` request from the open project. */
export function serveAppRequest(requestURL: string, projectRoot: string | undefined): Response {
  if (projectRoot === undefined) {
    return new Response(undefined, { status: 404 });
  }
  let id: string;
  let filePath: string;
  try {
    const url = new URL(requestURL);
    id = parseAppId(url.hostname);
    filePath = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
  } catch {
    return new Response(undefined, { status: 400 });
  }
  const origin = `${APP_SCHEME}://${id}`;
  // The folder decides (appScan.ts): a folder that reads as this app is served, a broken or missing one is not.
  if (!appFolderRuns(projectRoot, id)) {
    return new Response(undefined, { status: 404 });
  }
  // The frame connects only to what its manifest declares (appSdk.ts appContentSecurityPolicy).
  let connectHosts: readonly string[];
  try {
    const manifest = readInstalledManifest(projectRoot, id);
    connectHosts = appConnectHosts(manifest.network, manifest.auth);
  } catch {
    return new Response(undefined, { status: 404 });
  }
  const headers = {
    'Content-Security-Policy': appContentSecurityPolicy(origin, connectHosts),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...APP_FILE_CORS_HEADERS,
  };
  if (filePath === APP_SDK_FILE) {
    return new Response(appSdkSource(), { status: 200, headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
  }
  // The UI kit's reserved folder (shared/properties/appUiKit.ts): the host answers it, never the bundle.
  const kit = appHostAsset(filePath);
  if (kit.kind === 'kit') {
    return new Response(kit.body, { status: 200, headers: { ...headers, 'Content-Type': kit.type } });
  }
  if (kit.kind === 'reserved') {
    return new Response(undefined, { status: 404, headers });
  }
  let file: ReturnType<typeof readAppFile>;
  try {
    file = readAppFile(projectRoot, id, filePath);
  } catch {
    return new Response(undefined, { status: 404, headers });
  }
  if (file === undefined) {
    return new Response(undefined, { status: 404, headers });
  }
  // Every HTML document carries the design tokens, so `var(--stacki-accent)` works without opting in.
  return new Response(new Blob([new Uint8Array(withAppTokens(file))]), { status: 200, headers: { ...headers, 'Content-Type': file.type } });
}
