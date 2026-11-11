// Run the real main-process registration without opening windows, updating the
// app, or starting project services. Individual handlers still use real files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { toRecord } from '#dist/shared/core/record.js';

export interface MainHarness {
  readonly handlers: ReadonlyMap<string, (event: unknown, input?: unknown) => unknown>;
  readonly invoke: (channel: string, input?: unknown) => Promise<unknown>;
  readonly call: (name: string, ...args: readonly unknown[]) => unknown;
  readonly dispose: () => void;
}

/** `entryPath` loads another build's main — the step-5 parity run drives the
 * legacy build's handlers beside the current ones. */
export function mainHarness(userData: string, sourcePath?: string, entryPath = path.resolve('dist/electron/main.js')): MainHarness {
  const entry = entryPath;
  const require = createRequire(entry);
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const electron = mainHarnessElectron(userData, handlers);
  const source = fs.readFileSync(sourcePath ?? entry, 'utf8');
  const helpers: Record<string, unknown> = {};
  vm.runInNewContext(
    source +
      // The helpers tests drive by name: main.js's own, plus those it now
      // imports from area modules, read from the build this main.js belongs to.
      '\nObject.assign(helpers, { readSettings, readRecents, stopWatchingProject, ' +
      'writeMarkerConfig: (projectPath) => devServers.writeMarkerConfig(projectPath), ' +
      "findFreePort: require('./lib/nodeTools.js').findFreePort, " +
      "imageSizeOf: require('./project/assetFiles.js').imageSizeOf, " +
      "satisfiesRange: require('./preview/devServerChecks.js').satisfiesRange });",
    {
      require: (name: string): unknown => (name === 'electron' ? electron : name === 'electron-updater' ? { autoUpdater: {} } : require(name)),
      exports: {},
      __dirname: path.dirname(entry),
      process,
      console,
      Buffer,
      URL,
      Response,
      Headers,
      fetch,
      helpers,
      // eslint-disable-next-line stacki/callback-last -- The platform setTimeout's own signature.
      setTimeout: (callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay);
        timers.add(timer);
        return timer;
      },
      clearTimeout,
    },
  );
  return {
    handlers,
    invoke: async (channel, input) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`Missing handler: ${channel}`);
      }
      return handler({}, input);
    },
    call: (name, ...args) => {
      const helper = toRecord(helpers)?.[name];
      if (!isCallable(helper)) {
        throw new Error(`Missing helper: ${name}`);
      }
      const result: unknown = helper(...args);
      return result;
    },
    dispose: () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    },
  };
}

function isCallable(input: unknown): input is (...args: readonly unknown[]) => unknown {
  return typeof input === 'function';
}

function mainHarnessElectron(userData: string, handlers: Map<string, (event: unknown, input?: unknown) => unknown>) {
  const app = Object.assign(new EventEmitter(), {
    getPath: () => userData,
    getVersion: () => '0.1.48',
    getAppPath: () => path.resolve('.'),
    whenReady: () => ({ then: () => undefined }),
    isPackaged: false,
    isReady: () => false,
  });
  const electron = {
    app,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => handlers.set(channel, handler),
    },
    protocol: { registerSchemesAsPrivileged: () => undefined },
    clipboard: { writeText: () => undefined },
    shell: { trashItem: (file: string) => fs.rmSync(file, { recursive: true, force: true }), showItemInFolder: () => undefined },
  };
  return electron;
}
