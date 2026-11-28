// The project's dev server, the one the canvas shows: starting it with the
// app's generated config (falling back to the project's own), adopting a
// server the user already runs, stopping it, and its log. One instance per
// main process, made by main.ts; its IPC is registered below.

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import type { IpcResults } from '../../shared/ipc/ipcResults';
import { MAIN_LIMITS, readSource } from '../lib/mainLimits';
import { RUNTIME_PATHS } from '../lib/runtimePaths';
import { commandNeedsShell, sameFilesystemPath } from '../lib/platform';
import { createKeyedQueue } from '../lib/serialQueue';
import type { DevServer } from '../lib/mainTypes';
import { SHORT_COMMAND, errorMessage, parseOptionalString, parseRecord, readJson, toPosix } from '../lib/mainHelpers';
import { resolveAstroBin } from '../project/projectFiles';
import { astroManifestPath, usesYarnPlugAndPlay } from '../lib/installFolders';
import { translateMain } from '../lib/mainLocale';
import { findFreePort, nodeCliCommand, resolveNodeBin, run, spawnAstroServer, stopProcessTree } from '../lib/nodeTools';
import { previewSupportFiles, renderComponentPreviewPage } from '../previewServer/componentPreview';
import { probeUrl } from '../preview/devProbe';
import { inspectPreviewPage } from '../preview/previewInspect';
import { PREVIEW_HEALTH_LIMITS, type PreviewHealth } from '../../shared/ipc/previewHealth';
import { parsePreviewFailure } from '../../shared/ipc/previewFailure';
import { readDevServerLog } from '../preview/devServerLog';
import {
  ASTRO_CONFIG_FILES,
  TRAILING_SLASH_MODES,
  nodeVersionOf,
  parseExistingServer,
  parsesAsModule,
  previewPort,
  serverResponds,
  readAstroLock,
  satisfiesRange,
  serverAlive,
  serverStillServes,
  trailingSlashFromSource,
} from '../preview/devServerChecks';
import { hasContentConfig } from '../content/contentConfig';
import { DATA_ENDPOINT, PATHS_ENDPOINT, VALUE_ENDPOINT, renderMarkerConfig } from '../preview/markerConfig';
import { PROGRESS_CLEARED, installDependencies } from './projectHandlers';
import type { MainHost } from './mainHost';
import { readProjectFolders } from '../lib/projectFolders';
import { configOf } from '../../shared/properties/projectFolders';
import type { Thumbnails } from './thumbnails';
import { devServerArgs, devServerURL, networkAllowedHosts } from '../preview/devServerArgs';
import { selectLanAddresses, type InterfaceTable } from '../preview/lanAddresses';
import {
  DEV_NETWORK_OFF,
  NETWORK_ACCESS_OPEN,
  PREVIEW_KEY_ENV,
  toPreviewKey,
  type DevNetworkMode,
  type DevNetworkReply,
  type DevNetworkRequest,
  type DevNetworkState,
  type NetworkAccess,
  type PreviewKey,
} from '../../shared/ipc/devNetwork';
import { err, ok } from '../../shared/core/result';

// Subscribe before sending the stop signal so a fast exit cannot be missed.
function waitForPreviewExit(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const exited = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      process.removeListener('exit', exited);
      reject(new Error('Preview did not stop in time. Try switching branches again.'));
    }, 10000);
    process.once('exit', exited);
  });
}

// `astro dev stop` ends whatever server the project's lock names. That may be one another Stacki or a terminal
// started since ours: stopping ours must not stop theirs. Ports tell them apart.
function lockNamesAnotherServer(server: DevServer): boolean {
  const lock = readAstroLock(server.projectPath);
  if (lock === undefined || !URL.canParse(lock.url)) {
    return false; // Nothing says it is someone else's: the CLI is left to judge.
  }
  return new URL(lock.url).port !== new URL(server.url).port;
}

// The page patcher, handed to every page as a module. It lives in its own
// file rather than as a string in here because it is real code that has to
// stay readable — and it is read rather than required, since it runs in the
// browser and not in this process. If it cannot be read, pages simply reload
// the way they always did.
//
// It has no bounds to hand over: the patch scales with the page instead of
// reloading past a size (electron/previewClient/morphPatch.ts).
let MORPH_CLIENT = '';
try {
  MORPH_CLIENT = readSource(RUNTIME_PATHS.morphClient);
} catch {
  MORPH_CLIENT = '';
}

// The patcher, written as a script Astro is allowed to process — which means
// Astro bundles it and puts it in <head>, exactly as it does for any script a
// component writes. It is still a module (import.meta.hot, which is what it
// listens on), and it is no longer a node in the page's own markup.
//
// It used to carry `is:inline`, which tells Astro to leave a tag exactly where
// it was written. A script is display:none, so a tag in the body looked free —
// and it is a child: :last-child, :nth-child, `+`, `~` and `> *` all count it.
// A page rendered into a layout's slot handed that slot one extra child, and
// CSS written for the children a component is given saw something the real
// build has not got.
const MORPH_TAG_HTML = MORPH_CLIENT ? "<script>import 'virtual:avb-morph';</script>" : '';

/**
 * Starts the project's dev server, or joins the start already running for it (one start per project, see
 * `DevServers.run`). Main calls this as soon as it knows which project the window will open, before the
 * renderer has loaded; the renderer's own `dev:start` then receives the same result.
 */
export function startProjectPreview(
  devServers: DevServers,
  thumbnails: Pick<Thumbnails, 'noteProjectOpened' | 'schedule'>,
  projectPath: string,
): Promise<IpcResults['dev:start']> {
  thumbnails.noteProjectOpened();
  // A restart main is making is waited for: a start slipped between its stop and its start would take another port.
  return devServers.settled().then(() =>
    devServers.run(projectPath, async (assertActive) => {
      const result = await devServers.start(projectPath, assertActive);
      assertActive();
      thumbnails.schedule(projectPath, 6000);
      return { ...result, trailingSlash: devServers.readTrailingSlash(projectPath) };
    }),
  );
}

/** Page files the preview config can be told about (its `/__avb/touch` takes the same). */
const TOUCHABLE_FILE = /\.(astro|md|mdx)$/i;
/** A touch that gets no answer by now is left to the file watcher. */
const TOUCH_TIMEOUT_MS = 1500;

/** The key only scanned devices hold: 32 random bytes, 43 base64url characters, made new each time the option is turned on. */
function newPreviewKey(): PreviewKey {
  const key = toPreviewKey(randomBytes(32).toString('base64url'));
  assert(key.length === 43, 'newPreviewKey: 32 bytes in base64url');
  return key;
}

export class DevServers {
  private server: DevServer | undefined = undefined;
  // Whether the running server's project had a content config when it started.
  // Astro reads src/content.config.* once, at startup: a config that appears
  // later (the CMS's first collection, or one written by hand) is never loaded,
  // and its collections read as empty for as long as that server runs. The
  // content-sync hook cannot fix it, since it re-syncs the config it has.
  private contentConfigAtStart: { readonly url: string; readonly present: boolean } | undefined = undefined;
  private logBuffer: string[] = [];
  // Serialize dev:start calls — concurrent spawns race Astro's daemon lock and
  // the loser dies with "exited before becoming ready".
  private readonly starts = createKeyedQueue<IpcResults['dev:start']>();
  // The project whose preview is open on the local network (`--host 0.0.0.0`), for this run of the app
  // only: never written anywhere, so it is off at every launch, and cleared when the project closes or
  // the app quits (stop()). A restart for any other reason (an .env change, a branch switch) keeps it.
  private networkProject: string | undefined = undefined;
  // Who may open it from the network, while it is open there: anyone, or only the devices that scanned the
  // code, with the key the code carries. Kept like networkProject, in memory only, and cleared with it; a new
  // key is made each time the option is turned on (restartInMode), so an older code stops working.
  private networkAccess: NetworkAccess = NETWORK_ACCESS_OPEN;
  // One change of mode at a time: each is a restart of the dev server, and a second toggle while one
  // restarts would race it.
  private networkChange: 'idle' | 'changing' = 'idle';
  // The restart under way, and the port it is to come back on: the canvas, and a phone with the address, hold that one.
  private restart: { readonly port: number; readonly settled: Promise<void> } | undefined = undefined;

  constructor(
    private readonly host: Pick<MainHost, 'send'>,
    // Extra variables the project's dev server gets (cms/cmsPreviewEnvironment.ts).
    private readonly previewEnvironment: (projectRoot: string) => Readonly<Record<string, string>> = () => ({}),
  ) {}

  /** Settled once no restart of main's own is under way. */
  settled(): Promise<void> {
    return this.restart?.settled ?? Promise.resolve();
  }

  /** The dev server the canvas shows, while one runs. */
  current(): DevServer | undefined {
    return this.server;
  }

  /**
   * Tells the running dev server a page file was just written by the app, so it compiles and
   * announces the change now instead of when its file watcher notices (the preview config's
   * `/__avb/touch`, which drops the watcher's later event for the same bytes). Best effort and
   * never awaited by a write: a server that does not answer is left to its watcher.
   */
  touch(file: string): void {
    const server = this.server;
    if (server === undefined || !TOUCHABLE_FILE.test(file)) {
      return;
    }
    const projectRoot = path.resolve(server.projectPath);
    if (!path.resolve(file).startsWith(projectRoot + path.sep)) {
      return;
    }
    fetch(`${server.url}/__avb/touch?f=${encodeURIComponent(path.resolve(file))}`, { signal: AbortSignal.timeout(TOUCH_TIMEOUT_MS) }).catch(() => undefined);
  }

  /** A checkout must wait until the old watcher stops before replacing its files. */
  async pause(): Promise<void> {
    this.starts.cancel();
    const server = this.server;
    if (!server) {
      return;
    }
    if (server.daemon && server.bin) {
      if (!lockNamesAnotherServer(server)) {
        const [command, args] = nodeCliCommand(server.bin, ['dev', 'stop']);
        await run(command, args, server.projectPath, SHORT_COMMAND);
      }
      if (this.server === server) {
        this.server = undefined;
      }
      return;
    }
    const stopped = waitForPreviewExit(server.proc);
    this.stop(false);
    await stopped;
  }

  /** Runs `task` as the project's one dev start; a later start cancels it. */
  run(projectPath: string, task: (assertActive: () => void) => Promise<IpcResults['dev:start']>): Promise<IpcResults['dev:start']> {
    return this.starts.run(projectPath, task);
  }

  stop(cancelPending = true): void {
    if (cancelPending) {
      this.starts.cancel();
      // A stop that cancels is the project closing or the app quitting, never a restart (pause): the
      // preview goes back to this computer only (see networkProject).
      this.networkProject = undefined;
      this.networkAccess = NETWORK_ACCESS_OPEN;
    }
    if (!this.server) {
      return;
    }
    const { proc, daemon, bin, projectPath } = this.server;
    const replaced = lockNamesAnotherServer(this.server);
    this.server = undefined;
    // Daemonized servers (Astro >= 7 forks a background process) stop via the CLI.
    if (daemon && bin) {
      if (replaced) {
        return;
      }
      try {
        const [cmd, argv] = nodeCliCommand(bin, ['dev', 'stop']);
        execFile(cmd, argv, { ...SHORT_COMMAND, cwd: projectPath, shell: commandNeedsShell(cmd) }, () => {});
      } catch {
        /* best effort */
      }
      return;
    }
    // External servers have no owned process and stay running.
    stopProcessTree(proc);
  }

  /**
   * Restarts the dev server at `devUrl` when its project gained a content
   * config after it started, so Astro loads the collections it declares.
   * Once per server: the restarted one starts with the config, so it never
   * asks again. Resolves true when the server is back at the same address
   * (its port comes from the project path, so it normally is) — the canvas's
   * Vite client reconnects to it by itself. False when there was nothing to
   * do, or the server came back somewhere else; the app hears the new address
   * (`dev:restart`) and shows the preview from there.
   */
  async restartForNewContentConfig(devUrl: string): Promise<boolean> {
    const server = this.server;
    const atStart = this.contentConfigAtStart;
    if (server === undefined || server.external === true || server.url !== devUrl) {
      return false;
    }
    if (atStart === undefined || atStart.url !== devUrl || atStart.present) {
      return false;
    }
    if (!hasContentConfig(server.projectPath)) {
      return false;
    }
    // Cleared before the restart, so a second empty read meanwhile does not
    // start another one.
    this.contentConfigAtStart = undefined;
    const { projectPath } = server;
    this.pushLog('\n[stacki] the content config appeared after the preview started; restarting it so Astro loads its collections.\n');
    const restarted = await this.restartAt(projectPath, devUrl);
    assert(hasContentConfig(projectPath), 'A server restarted for its content config starts with one');
    return restarted;
  }

  /**
   * Restarts this project's dev server after its .env changed, because Astro
   * reads env files only as it starts. False when no server of ours is running
   * for the project, or it came back at another address.
   */
  async restartForProjectEnv(projectPath: string): Promise<boolean> {
    const server = this.server;
    if (server === undefined || server.external === true || !sameFilesystemPath(server.projectPath, projectPath)) {
      return false;
    }
    this.pushLog('\n[stacki] the project .env changed; restarting the preview so Astro reads it.\n');
    return this.restartAt(server.projectPath, server.url);
  }

  /**
   * Restarts this project's dev server because an integration was added to its Astro config, which a running server never
   * loads. The address the server answers on afterwards, or undefined when none of ours runs for the project.
   */
  async restartForNewIntegration(projectPath: string): Promise<string | undefined> {
    const server = this.server;
    if (server === undefined || server.external === true || !sameFilesystemPath(server.projectPath, projectPath)) {
      return undefined;
    }
    this.pushLog('\n[stacki] an integration was added to the Astro config; restarting the preview so it is loaded.\n');
    await this.restartAt(server.projectPath, server.url);
    return this.server?.url;
  }

  // Stops and starts the server on purpose, on the same port while it is free. The app is told before and after
  // (shared/ipc/devRestart.ts), so it neither calls the preview dead meanwhile nor misses a new address. Resolves
  // true when the server is back where it was.
  private async restartAt(projectPath: string, devUrl: string): Promise<boolean> {
    const port = Number(new URL(devUrl).port);
    assert(Number.isSafeInteger(port), 'restartAt: the old address has a port');
    assert(port > 0, 'restartAt: the port is positive');
    let finish = (): void => {};
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.restart = { port, settled };
    this.host.send('dev:restart', { kind: 'begun' });
    let url: string | undefined;
    try {
      await this.pause();
      const restarted = await this.run(projectPath, async (assertActive) => ({
        ...(await this.start(projectPath, assertActive)),
        trailingSlash: this.readTrailingSlash(projectPath),
      }));
      assert(restarted.url.length > 0, 'A restarted server has an address');
      url = restarted.url;
    } finally {
      this.restart = undefined;
      finish();
      this.host.send('dev:restart', { kind: 'done', url });
    }
    return url === devUrl;
  }

  /** The trailing-slash mode the project's dev server serves. */
  readTrailingSlash(projectPath: string): string {
    // What the dev server resolved beats what the config says: it has been
    // through Astro's own defaults, and it accounts for a value that arrives by
    // variable, spread or integration rather than as a literal. Only this app's
    // own server writes it, so it is only trustworthy while that server is the
    // one running — an adopted external server never loads the marker config,
    // and a file left behind by an earlier run would answer for a config that
    // has since changed.
    const ours = this.server && sameFilesystemPath(this.server.projectPath, projectPath) && !this.server.external;
    try {
      if (!ours) {
        throw new Error('no server of ours');
      }
      const resolved = parseRecord(readJson(path.join(projectPath, 'node_modules', '.avb', 'resolved.json')));
      const mode = parseOptionalString(resolved['trailingSlash']);
      if (mode && TRAILING_SLASH_MODES.includes(mode)) {
        return mode;
      }
    } catch {
      /* no server has run yet — read the config instead */
    }
    for (const file of ASTRO_CONFIG_FILES) {
      let text;
      try {
        text = readSource(path.join(projectPath, file));
      } catch {
        continue;
      }
      const mode = trailingSlashFromSource(text);
      if (mode) {
        return mode;
      }
      break; // the first config that exists is the one Astro loads
    }
    return 'ignore'; // Astro's default, and the one that serves either spelling
  }

  /**
   * Whether this project's dev server answers this computer only, or the local network too. A server
   * for another project, or none, is local: the mode belongs to the project that turned it on.
   */
  networkMode(projectPath: string): DevNetworkMode {
    const project = this.networkProject;
    if (project !== undefined && sameFilesystemPath(project, projectPath)) {
      return 'network';
    }
    return 'local';
  }

  /** What the toolbar shows: on, with the port and the machine's network addresses, only while our server runs that way. */
  networkState(projectPath: string, interfaces: InterfaceTable = os.networkInterfaces()): DevNetworkState {
    const server = this.server;
    if (server === undefined || server.external === true || !sameFilesystemPath(server.projectPath, projectPath)) {
      return DEV_NETWORK_OFF;
    }
    if (this.networkMode(projectPath) === 'local') {
      return DEV_NETWORK_OFF;
    }
    const port = Number(new URL(server.url).port);
    assert(Number.isSafeInteger(port), 'networkState: the server has a port');
    assert(port > 0, 'networkState: the port is positive');
    return { kind: 'on', port, addresses: selectLanAddresses(interfaces), access: this.networkAccess };
  }

  /**
   * Opens this project's preview on the local network, or takes it back to this computer only, by
   * restarting its dev server with the other `--host` (devServerArgs.ts). The canvas keeps its loopback
   * address and reconnects by itself. A restart that fails leaves the mode off and the server started
   * again on loopback, once; the reply says it failed, for the renderer's toast. At most two restarts.
   * While it is on, asking for the other access (anyone, or only scanned devices) restarts it the same way.
   */
  async setNetwork(request: DevNetworkRequest, interfaces: InterfaceTable = os.networkInterfaces()): Promise<DevNetworkReply> {
    // First: while a change restarts the server there is no server to judge, and the answer is "wait".
    if (this.networkChange === 'changing') {
      return err('busy');
    }
    const server = this.server;
    if (server === undefined || !sameFilesystemPath(server.projectPath, request.projectPath)) {
      return err('no-server');
    }
    // A server the user runs themselves has no command line of ours to change.
    if (server.external === true) {
      return err('external');
    }
    if (this.runsAsAsked(request)) {
      return ok(this.networkState(request.projectPath, interfaces));
    }
    // A machine on no network has no address for a phone to open: stay local and say so.
    if (request.mode === 'network' && selectLanAddresses(interfaces).length === 0) {
      return err('no-address');
    }
    this.networkChange = 'changing';
    try {
      return await this.restartInMode(server.projectPath, server.url, request, interfaces);
    } finally {
      this.networkChange = 'idle';
    }
  }

  /** Whether the server already runs as `request` asks: in its mode and, on the network, with its access. */
  private runsAsAsked(request: DevNetworkRequest): boolean {
    if (this.networkMode(request.projectPath) !== request.mode) {
      return false;
    }
    if (request.mode === 'local') {
      return true;
    }
    return this.networkAccess.kind === request.access;
  }

  private async restartInMode(projectPath: string, devUrl: string, request: DevNetworkRequest, interfaces: InterfaceTable): Promise<DevNetworkReply> {
    assert(this.networkChange === 'changing', 'restartInMode: one change at a time');
    const mode: DevNetworkMode = request.mode;
    this.networkProject = mode === 'network' ? projectPath : undefined;
    this.networkAccess = request.mode === 'network' && request.access === 'key' ? { kind: 'key', key: newPreviewKey() } : NETWORK_ACCESS_OPEN;
    this.pushLog(
      mode === 'network'
        ? `\n[stacki] opening the preview on the local network${this.networkAccess.kind === 'key' ? ', to the devices that scan its code' : ''}; restarting it with --host 0.0.0.0.\n`
        : '\n[stacki] taking the preview back to this computer only; restarting it with --host 127.0.0.1.\n',
    );
    try {
      await this.restartAt(projectPath, devUrl);
      assert(this.networkMode(projectPath) === mode, 'restartInMode: the server restarted in the asked mode');
      return ok(this.networkState(projectPath, interfaces));
    } catch (error: unknown) {
      this.pushLog(`\n[stacki] the preview did not restart: ${errorMessage(error)}\n`);
    }
    // The second and last restart: back to this computer only, the mode that started before.
    this.networkProject = undefined;
    this.networkAccess = NETWORK_ACCESS_OPEN;
    try {
      await this.restartAt(projectPath, devUrl);
    } catch {
      this.host.send('dev:exit', { code: 1, log: this.recentLog() });
    }
    assert(this.networkMode(projectPath) === 'local', 'restartInMode: a failed change ends local');
    return err('restart-failed');
  }

  /**
   * The key the dev server checks (previewServer/loopbackGuard.ts), in its environment and nowhere else: only
   * on the network, and only while only scanned devices may open the preview.
   */
  private previewKeyEnvironment(mode: DevNetworkMode): Readonly<Record<string, string>> {
    const access = this.networkAccess;
    if (mode === 'network' && access.kind === 'key') {
      return { [PREVIEW_KEY_ENV]: access.key };
    }
    return {};
  }

  /** The generated config's path, or undefined when the dev server runs without it. `networkHosts`: the hosts Vite answers to on the local network, only in that mode. */
  writeMarkerConfig(projectPath: string, networkHosts?: readonly string[]): string | undefined {
    try {
      const directory = path.join(projectPath, 'node_modules', '.avb');
      fs.mkdirSync(directory, { recursive: true });
      // Stale until this run's astro:config:done writes it again; until then the
      // config's own text is the better answer.
      fs.rmSync(path.join(directory, 'resolved.json'), { force: true });
      fs.rmSync(path.join(directory, 'routes.json'), { force: true });
      const userConfig = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'].find((name) => fs.existsSync(path.join(projectPath, name)));
      // Unpacked copies: the dev server is plain Node (see runtimePaths.ts).
      const markersPath = RUNTIME_PATHS.previewMarkers;
      const previewHelperPath = RUNTIME_PATHS.componentPreview;
      // Vite normally resolves symlinks before loading source (including
      // macOS /var -> /private/var). Match both spellings because a project's
      // preserveSymlinks option can keep the original one instead.
      const projectDirectories = [...new Set([toPosix(path.resolve(projectPath)), toPosix(fs.realpathSync(projectPath))])];
      const config = renderMarkerConfig([
        userConfig ? `import userConfig from '../../${userConfig}';` : 'const userConfig = {};',
        JSON.stringify(markersPath),
        JSON.stringify(previewHelperPath),
        JSON.stringify(RUNTIME_PATHS.studioEntry),
        JSON.stringify(RUNTIME_PATHS.previewWarmup),
        JSON.stringify(RUNTIME_PATHS.previewImageCache),
        JSON.stringify(projectDirectories),
        JSON.stringify(MORPH_CLIENT),
        JSON.stringify(MORPH_TAG_HTML),
        // JavaScript's own null in the generated file: the config reads it as "this computer only".
        networkHosts === undefined ? 'null' : JSON.stringify(networkHosts),
        JSON.stringify(toPosix(path.join(directory, 'preview.astro'))),
        JSON.stringify(toPosix(path.join(directory, 'paths.js'))),
        JSON.stringify(toPosix(path.join(directory, 'data.js'))),
        JSON.stringify(toPosix(path.join(directory, 'value.js'))),
      ]);
      const configPath = path.join(directory, 'astro.config.mjs');
      fs.writeFileSync(configPath, config);
      // The route's globs follow the project's component folders as they are now; a later
      // change to .stacki/folders.json reaches previews when the dev server next starts.
      fs.writeFileSync(path.join(directory, 'preview.astro'), renderComponentPreviewPage(configOf(readProjectFolders(projectPath))));
      // The page imports the recipe node component from beside it (componentPreviewRecipe.ts).
      for (const [name, text] of Object.entries(previewSupportFiles())) {
        fs.writeFileSync(path.join(directory, name), text);
      }
      fs.writeFileSync(path.join(directory, 'paths.js'), PATHS_ENDPOINT);
      fs.writeFileSync(path.join(directory, 'data.js'), DATA_ENDPOINT);
      fs.writeFileSync(path.join(directory, 'value.js'), VALUE_ENDPOINT);
      // This file is assembled here and handed to Astro as its config. If it
      // will not parse, Astro does not start, and the project gets no preview at
      // all — the editor's own canvas broken by the editor's own scaffolding,
      // over something the project never asked for. Read it back the way node
      // will and say no rather than hand over something that cannot load: the
      // caller falls back to a plain dev server, which costs the outlines and
      // the live patching and keeps everything else working.
      if (!parsesAsModule(configPath)) {
        this.pushLog(
          '\n[stacki] the generated preview config did not parse; starting the dev ' +
            'server without it. Outlines and live updates are off for this session.\n',
        );
        return undefined;
      }
      return configPath;
    } catch {
      return undefined; // preview still works, just without outlines
    }
  }

  // The server already held for this project, when it still serves; otherwise it is let go, so a start replaces it.
  // Why asked at all: a server that died or hung would be answered with for as long as the project stayed open.
  private async stillRunning(current: DevServer): Promise<{ readonly url: string; readonly external?: true } | undefined> {
    const serves = await serverStillServes(current.url);
    // It may have exited, or been replaced, while it was asked.
    if (this.server !== current) {
      return undefined;
    }
    if (serves) {
      return current.external === true ? { url: current.url, external: true } : { url: current.url };
    }
    this.pushLog('\n[stacki] the preview server stopped answering; starting it again.\n');
    const exited = waitForPreviewExit(current.proc);
    this.stop(false);
    // A server that will not end is left behind: the new one takes the next free port.
    await exited.catch(() => undefined);
    return undefined;
  }

  /** Starts the project's dev server, or answers with the one already running. */
  async start(projectPath: string, assertActive: () => void) {
    assertActive();
    if (this.server && sameFilesystemPath(this.server.projectPath, projectPath)) {
      const running = await this.stillRunning(this.server);
      assertActive();
      if (running !== undefined) {
        return running;
      }
    }
    assertActive();
    // The mode belongs to the project that turned it on: another project starts on this computer only.
    if (this.networkProject !== undefined && !sameFilesystemPath(this.networkProject, projectPath)) {
      this.networkProject = undefined;
      this.networkAccess = NETWORK_ACCESS_OPEN;
    }
    this.stop(false);
    this.logBuffer = [];

    const localBin = await this.installedBin(projectPath, assertActive);

    // A lock file means a daemon exists (possibly stale, possibly started
    // without the app's marker config) — pass --force so ours replaces it.
    const configPresent = hasContentConfig(projectPath);
    let lastError: unknown = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const force = attempt > 0 || !!readAstroLock(projectPath);
      try {
        // Retry with --force: first-attempt daemon startup can flake (stale
        // daemon state, vite re-optimizing after a config change).
        const url = await this.spawn(projectPath, localBin, { force, bare: false }, assertActive);
        this.contentConfigAtStart = { url, present: configPresent };
        return { url };
      } catch (error: unknown) {
        assertActive();
        lastError = error;
        this.stop(false);
        // Another dev server already running for this project?
        const existing = parseExistingServer(this.recentLog());
        if (existing) {
          const alive = await serverAlive(existing);
          assertActive();
          if (alive) {
            // Adopt the user's own server instead of fighting it.
            this.server = { proc: undefined, url: existing, projectPath, external: true };
            return { url: existing, external: true };
          }
        }
        this.logBuffer = [];
        await new Promise((resolve) => setTimeout(resolve, 800));
        assertActive();
      }
    }
    // Everything above ran with this app's generated config. A project whose
    // preview will not come up is worse than one without outlines, so try once
    // more on the project's own config before giving up. What starts here has no
    // markers and no live patching — an edit reloads the page, the way it did
    // before any of this — but the canvas is a canvas again.
    try {
      const url = await this.spawn(projectPath, localBin, { force: true, bare: true }, assertActive);
      this.pushLog(
        "\n[stacki] the preview would not start with this app's config, so it is " +
          "running on the project's own. Outlines and live updates are off; the " +
          'log above says why.\n',
      );
      if (this.server) {
        this.server = { ...this.server, bare: true };
      }
      return { url, bare: true };
    } catch {
      assertActive();
      this.stop(false);
      throw lastError; // report the first failure: it is the one that explains it
    }
  }

  private async spawn(projectPath: string, localBin: string, { force, bare }: { readonly force: boolean; readonly bare: boolean }, assertActive: () => void) {
    // A restart asks for the port it left; if that is taken now, the search goes on from it.
    const port = await findFreePort(this.restart?.port ?? previewPort(fs.realpathSync(projectPath)));
    assertActive();
    // Every attempt (the first, the --force retry and the bare fallback) starts in the project's mode:
    // on the local network only when it was turned on for this project (setNetwork).
    const mode = this.networkMode(projectPath);
    const networkHosts = mode === 'network' ? networkAllowedHosts(selectLanAddresses(os.networkInterfaces()).map((lan) => lan.address)) : undefined;
    // Astro resolves --config against the project root and rejects absolute
    // paths ([ConfigNotFound]), so pass it relative to the spawn cwd.
    // `bare` is the last resort: the project's own config, none of this app's,
    // so a preview still comes up even if what this app generates cannot run.
    const markerConfig = bare ? undefined : this.writeMarkerConfig(projectPath, networkHosts);
    const args = devServerArgs({ port, mode, configPath: markerConfig ? toPosix(path.relative(projectPath, markerConfig)) : undefined, force });

    const startedAtMs = Date.now();
    const extra = { ...this.previewEnvironment(fs.realpathSync(projectPath)), ...this.previewKeyEnvironment(mode) };
    const proc = spawnAstroServer(projectPath, localBin, args, extra);

    // Loopback in every mode: the canvas, thumbnails and main's own requests never change address.
    const url = devServerURL(port);
    this.server = { proc, url, projectPath, bin: localBin };
    // Startup failures belong to start()'s retries and final IPC reply. Only an
    // exit after readiness should take the renderer's running preview offline.
    let ready = false;

    proc.stdout.on('data', (chunk: Buffer) => this.pushLog(chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => this.pushLog(chunk.toString()));
    proc.on('error', (error) => {
      this.pushLog(`\n[spawn error] ${errorMessage(error)}\n`);
      if (this.server?.proc === proc) {
        this.server = undefined;
      }
    });
    proc.on('exit', (code) => {
      if (this.server && this.server.proc === proc) {
        // Astro >= 7 daemonizes: the CLI exits 0 after forking the real server
        // into a background process. That's a success, not a failure.
        const running = this.recentLog().match(/Dev server running at (https?:\/\/[^\s"\\)]+)/i);
        if (code === 0 && running) {
          this.server = { proc: undefined, url, projectPath, daemon: true, bin: localBin };
        } else {
          this.server = undefined;
          if (ready) {
            this.host.send('dev:exit', { code, log: this.recentLog() });
          }
        }
      }
    });

    // The daemon's own failure reasons land in its separate project log.

    // Wait for HTTP readiness; a listening socket alone can leave the iframe blank.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      assertActive();
      if (!this.server) {
        throw new Error('Dev server exited before it was ready.\n\n' + (await this.failureDetail(projectPath, localBin, startedAtMs)));
      }
      if (await serverResponds(url)) {
        assertActive();
        if (this.server) {
          ready = true;
          return url;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('Astro dev server did not start within 60 seconds.\n\n' + (await this.failureDetail(projectPath, localBin, startedAtMs)));
  }

  // The project's astro CLI, installing the project's dependencies first when it
  // has none.
  private async installedBin(projectPath: string, assertActive: () => void): Promise<string> {
    // Without this the failure is the shim's "env: node: No such file or
    // directory", which reads like a broken project rather than a missing tool.
    if (!resolveNodeBin()) {
      throw new Error(
        'Node.js could not be found. Install a current Node.js release, restart Stacki, and ' +
          'try again. Stacki checks standard installers and common version managers.',
      );
    }

    const found = resolveAstroBin(projectPath);
    if (found !== undefined) {
      return found;
    }
    // Dependencies missing or incomplete — install with the right PM first. In a workspace this installs the whole
    // workspace, and astro may land at its root.
    await installDependencies(this.host, projectPath);
    assertActive();
    this.host.send('progress', PROGRESS_CLEARED);
    // Asked again, not remembered: which file it is depends on what the install made.
    const installed = resolveAstroBin(projectPath);
    if (installed === undefined) {
      if (usesYarnPlugAndPlay(projectPath)) {
        throw new Error(translateMain('error.project.yarnPlugAndPlay'));
      }
      throw new Error('astro is not installed in this project (no node_modules/.bin/astro after install). ' + 'Is astro listed in package.json dependencies?');
    }
    return installed;
  }

  private async failureDetail(projectPath: string, localBin: string, startedAtMs: number): Promise<string> {
    let log = this.recentLog();
    const daemonLog = await readDevServerLog(projectPath, startedAtMs);
    if (daemonLog) {
      return `${log}\n\n— Astro startup log —\n${daemonLog}`; // i18n-ignore: developer log text.
    }
    try {
      const [logCmd, logArgs] = nodeCliCommand(localBin, ['dev', 'logs']);
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
        execFile(logCmd, logArgs, { ...SHORT_COMMAND, cwd: projectPath, shell: commandNeedsShell(logCmd) }, (error, so) =>
          error ? reject(error) : resolve({ stdout: so.toString() }),
        ),
      );
      const tail = stdout.trim().split('\n').slice(-12).join('\n');
      if (tail) {
        log += `\n\n— astro dev logs —\n${tail}`;
      }
    } catch {
      /* no daemon logs available */
    }
    return log;
  }

  private pushLog(chunk: string): void {
    this.logBuffer.push(chunk.slice(-MAIN_LIMITS.logChunkCharsMax));
    // Keep roughly the last 200 chunks.
    if (this.logBuffer.length > 200) {
      this.logBuffer = this.logBuffer.slice(-200);
    }
    this.host.send('dev:log', chunk);
  }

  /** The end of the dev server's log with colour removed, for a notice that shows why a page failed. */
  logTail(): string {
    return this.recentLog(PREVIEW_HEALTH_LIMITS.logTailCharsMax);
  }

  /**
   * Whether the page at `url` can be shown. Only the dev server's own origin is asked about: this is the app's
   * question about its own preview, not a way for the renderer to make main fetch an address of its choosing.
   */
  async inspectPage(url: string): Promise<PreviewHealth> {
    const ours = this.server?.url;
    const address = parsePreviewFailure(url);
    if (ours === undefined || new URL(address).origin !== new URL(ours).origin) {
      return { kind: 'unreachable', status: 0, thrown: undefined, logTail: this.logTail() };
    }
    return inspectPreviewPage(address, this.logTail());
  }

  private recentLog(charsMax = 1200): string {
    const text = this.logBuffer.join('').replace(/\x1b\[[0-9;]*m/g, '');
    return text.slice(-charsMax).trim();
  }
}

export function registerDevServerHandlers({
  ipcMain,
  devServers,
  thumbnails,
}: Pick<MainHost, 'ipcMain'> & {
  readonly devServers: DevServers;
  readonly thumbnails: Thumbnails;
}): void {
  ipcMain.handle('dev:start', (_event, projectPath) => startProjectPreview(devServers, thumbnails, projectPath));

  ipcMain.handle('dev:stop', async () => {
    await devServers.pause();
    return { ok: true as const };
  });

  ipcMain.handle('dev:probe', (_event, url) => probeUrl(url));

  ipcMain.handle('dev:inspect', (_event, url) => devServers.inspectPage(url));

  ipcMain.handle('dev:network', (_event, projectPath) => devServers.networkState(projectPath));

  ipcMain.handle('dev:setNetwork', (_event, request) => devServers.setNetwork(request));

  ipcMain.handle('dev:diagnose', async (_event, projectPath) => {
    const nodePath = resolveNodeBin() ?? undefined;
    const nodeVersion = nodePath ? nodeVersionOf(nodePath) : undefined;

    let astroVersion: string | undefined = undefined;
    let requires: string | undefined = undefined;
    try {
      const manifest = astroManifestPath(projectPath);
      const pkg = manifest === undefined ? {} : parseRecord(readJson(manifest));
      astroVersion = parseOptionalString(pkg['version']) || undefined;
      requires = parseOptionalString(toRecord(pkg['engines'])?.['node']) || undefined;
    } catch {
      /* astro not installed — reported as its own kind below */
    }

    // The preview's own folder under node_modules is not an install, and a workspace installs at its root.
    const hasDeps = astroManifestPath(projectPath) !== undefined;
    const nodeOk = nodeVersion ? satisfiesRange(nodeVersion, requires) : false;

    let kind = 'unknown';
    if (!nodePath) {
      kind = 'no-node';
    } else if (!hasDeps || !astroVersion) {
      kind = 'no-deps';
    } else if (!nodeOk) {
      kind = 'node-too-old';
    }

    return {
      kind,
      nodePath,
      nodeVersion,
      astroVersion,
      requires,
      launchedFromGui: !process.env['SHELL'],
    };
  });
}
