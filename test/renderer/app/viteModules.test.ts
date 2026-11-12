// Goal: renderer startup dependencies must be browser ES modules in development.
// Production bundling and CommonJS test bundles can hide invalid named imports.
// Methodology: transform the real entry modules with Vite, then link and evaluate
// their complete shared dependency graph with the native ES module loader.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SourceTextModule } from 'node:vm';
import { createServer, type ViteDevServer } from 'vite';

// Includes publishing, project metadata, defaults-canvas, and history payload parsers.
// The graph includes the package-source and review-receipt contracts alongside account sign-in.
// The validated merge-result payload adds one module to the 47-module graph.
// The package manager a new site is created with adds one more.
// Saved publish settings now validate their URL through the published-site contract.
// CMS connections and the connected-CMS panel add their contracts (connections, remote
// documents, remote schema): three more. A video link's card (linkPreview) and the
// project's content collections shown as a connection (astroContent): two more.
// A content collection's settings (collectionSettings) and its fields' checks (fieldChecks):
// two more. The unused-selector payloads (selectorUsage) and the styles keep list
// (styleKeepList) that project metadata validates: two more. Reading what a loop goes
// through (loopSource) and the dev server's answer about a page's last-rendered values
// (previewScope), for the binding picker's loop items: two more.
// The page template form's plan and sample payloads (pageTemplate): one more.
// The project scan's length unit (lengthUnit), rem in a Lumos project: one more.
// Media hosting: the IPC payloads validate saved connections, folders and uploads
// (mediaHosting) and a provider account's key and connect request (mediaAccounts): two more.
// Project metadata validates the panels' folder settings (projectFolders): one more.
// The history panel's author pictures validate their request and reply (commitAvatars): one more.
// Project metadata validates the roles file (projectRoles): one more.
// The Stacki Apps IPC payloads validate app ids, capabilities, staged tokens and GitHub
// sources before invoke, as docs/contracts.md asks of every channel (apps): one more.
// The apps manifest parser validates app commands and shortcut claims, whose
// shortcut grammar and reserved range live in their own contract (appShortcuts): one more.
// Sharing and publishing apps add four: the payloads validate shares, repositories and submissions
// (appPublish, which names the marketplace's one license from appMarketplace), and the manifest
// parser reads each app's settings (appSettings) and its secret-scan allowlist (appSecrets).
// App storage's payloads validate keys, scopes, values and writer tokens before invoke (appStorage):
// one more.
// Apps added as a folder: the payloads validate a folder's name before invoke (appFolders): one more.
// App project files and sign-ins: the payloads validate file operations (appFiles) and provider ids,
// and the manifest parser reads each app's `network` and `auth` (appAuth): two more.
// App permissions: the manifest parser and the roles file read each app's `permissions`
// (appPermissions): one more.
// Stacki connections and requests through the host: the manifest parser reads the connections registry
// (appConnections), and the payloads validate a request an app asks the host to make (appNet): two more.
// The Instructions panel's payloads validate its listing and files (instructions), and project
// metadata reads the Audits panel's ignore list (auditIgnores): two more.
// The AI chat's payloads validate chats, prompts and agent events (aiChat), over the chat model
// (chatModel), the agent ids (agentIds) and the chat's bounds (aiLimits): four more. The @ mention
// candidates (mentions) add one.
// The Settings payloads (secrets, mcp and the microphone) validate their changes with the envFile,
// secrets and mcp parsers: about eight more, with a little headroom.
const MODULES_MAX = 96;
// Repository paths; the dev server serves each at `/<path>`.
const ENTRY_MODULES: ReadonlyArray<{ readonly file: string; readonly exportName: string }> = [
  { file: 'src/lib/cleanError.ts', exportName: 'cleanError' },
  { file: 'src/ipc/bridge.ts', exportName: 'scanProject' },
  { file: 'src/editor/dataSuggest.ts', exportName: 'dataTree' },
  { file: 'src/editor/loopBindings.ts', exportName: 'renamedLoopVar' },
  { file: 'src/editor/pagePersistence.ts', exportName: 'createPageSaver' },
];

test('Vite development modules link the renderer contract dependencies', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'stacki-vite-modules-'));
  const server = await createServer({
    cacheDir: cacheDirectory,
    // Vite's own API: `watch: null` turns the file watcher off, where undefined would
    // start the default one.
    // eslint-disable-next-line stacki/no-null -- Vite's documented value for "no watcher".
    server: { middlewareMode: true, hmr: false, watch: null },
    logLevel: 'silent',
  });
  try {
    const loadModule = createModuleLoader(server);
    for (const entry of ENTRY_MODULES) {
      const module = await loadModule(`/${entry.file}`);
      await module.link(loadModule);
      await module.evaluate({ timeout: 1_000, breakOnSigint: false });
      assert.equal(module.status, 'evaluated', `${entry.file} must run before React mounts`);
      const namespace: unknown = module.namespace;
      assert.ok(typeof namespace === 'object');
      assert.ok(namespace);
      const exported: unknown = Reflect.get(namespace, entry.exportName);
      assert.equal(typeof exported, 'function', `${entry.file} keeps its public API`);
    }
  } finally {
    await server.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

function createModuleLoader(server: ViteDevServer): (url: string) => Promise<SourceTextModule> {
  // One bounded cache preserves module identity when contract imports overlap.
  const modules = new Map<string, Promise<SourceTextModule>>();
  return (url) => {
    assert.match(url, /^\/(?:src|shared)\//, 'Only local renderer contracts belong to this graph');
    const existing = modules.get(url);
    if (existing) {
      return existing;
    }
    assert.ok(modules.size < MODULES_MAX, `Contract graph exceeds ${MODULES_MAX} modules`);
    const pending = createModuleLoaderTransform(server, url);
    modules.set(url, pending);
    return pending;
  };
}

async function createModuleLoaderTransform(server: ViteDevServer, url: string): Promise<SourceTextModule> {
  const transformed = await server.transformRequest(url);
  assert.ok(transformed, `Vite must serve ${url}`);
  assert.ok(transformed.code.length > 0, `${url} must contain executable JavaScript`);
  return new SourceTextModule(transformed.code, { identifier: url });
}
