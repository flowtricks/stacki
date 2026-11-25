// The demo's entry. It loads the snapshot, puts stand-ins behind the three transports
// Studio's client uses, and only then imports that client, unmodified, which takes the
// page from here. The client never learns there is no server.
import { BAKE_RUNTIME_DIRECTORY, BAKE_SNAPSHOT_FILE } from '../src/features/bake/bakeProtocol';
import { BAKE_ASSET_URLS_FILE, parseAssetURLs } from '../src/features/bake/bakeAssetURLs';
import { parseBakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { documentStorageName } from '../src/shared/workspaceIdentity';
import { installAssetURLs, publicAssetResolver } from './assetURLs';
import { installDemoChrome } from './chrome';
import { installKeepAwake } from './keepAwake';
import { installControls } from './controls';
import { DemoPages } from './demoPages';
import { documentTitle, installPageAddress, servedRoute } from './pageAddress';
import { DemoFiles } from './projectFiles';
import { DEMO_PUBLISH_STATE_FILE, DemoPublish, PUBLISH_NOTE } from './publish';
import { eventSourceStandIn } from './eventSourceStandIn';
import { fetchStandIn } from './fetchStandIn';
import { NOT_SHOWN, planPageChange, settingsLockReason } from './pageChange';
import { DemoRooms } from './room';
import { shareTypeScript } from './sharedTypeScript';
import { shareYjs } from './sharedYjs';
import { demoRoutes } from './routes';
import { socketStandIn } from './socketStandIn';
import { EditPresence } from './editPresence';
import { forgetEdits, openEditStore } from './store';

const SNAPSHOT_TIMEOUT_MS = 20_000;

function siteBase(): string {
  const base = document.querySelector<HTMLMetaElement>('meta[name=stacki-demo-base]')?.content;
  if (base === undefined || !base.startsWith('/') || !base.endsWith('/')) {
    throw new Error('The demo page does not say where its site is');
  }
  return base;
}

/** Where `src/` assets ended up. Optional: a bake from before the map shows them as missing. */
async function loadAssetURLs(nativeFetch: typeof fetch, base: string): Promise<Readonly<Record<string, string>>> {
  try {
    const response = await nativeFetch(`${base}${BAKE_RUNTIME_DIRECTORY}/${BAKE_ASSET_URLS_FILE}`, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
    return response.ok ? parseAssetURLs(await response.text(), base) : {};
  } catch {
    return {};
  }
}

async function start(): Promise<void> {
  const nativeFetch = window.fetch.bind(window);
  const response = await nativeFetch(`${siteBase()}${BAKE_RUNTIME_DIRECTORY}/${BAKE_SNAPSHOT_FILE}`, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`The demo could not load its site (${response.status})`);
  }
  const snapshot = parseBakeSnapshot(await response.text());
  const assetURLs = loadAssetURLs(nativeFetch, snapshot.base); // In flight while the rest loads.
  const workspace = `demo-${snapshot.id}`;
  const chrome = installDemoChrome({
    reset: async () => {
      await forgetEdits(snapshot.id, Object.keys(snapshot.sources), (file) => documentStorageName(location.origin, file, workspace));
      location.reload();
    },
  });
  // The client's cache writes on its own. A full disk reaches here, and only here.
  window.addEventListener('unhandledrejection', (event) => {
    if (String(event.reason).includes('QuotaExceeded')) {
      event.preventDefault();
      chrome.storage('full');
    }
  });
  const controls = installControls((reason) => chrome.note(reason));
  let pagesWarm: () => Promise<void> = () => Promise.resolve();
  const store = await openEditStore(snapshot.id, (state) => chrome.storage(state));
  chrome.storage(store.state());
  const rooms: DemoRooms = new DemoRooms(
    {
      snapshotId: snapshot.id,
      baked: (file) => snapshot.sources[file],
      refusal: (file, next) => {
        const baked = snapshot.sources[file];
        if (baked === undefined) {
          return 'This file is not part of the demo.';
        }
        if (!file.startsWith('src/pages/')) {
          // Inside an open component, only its own text and attributes can show on the
          // pages that use it; an action changes its structure, which needs Astro.
          return NOT_SHOWN.markup;
        }
        return planPageChange(baked, next, { file, catalog: snapshot.components }).notShown[0];
      },
      save: (file, update) => void store.save(file, update),
      changed: () => void pagesWarm(),
      refused: (reason) => chrome.note(reason),
      selected: (file, source, selection) => {
        controls.lockSettings(settingsLockReason(source, selection, { file, catalog: snapshot.components }));
      },
    },
    await store.load(),
  );
  const saved = await store.loadFiles();
  const publish = new DemoPublish({
    siteURL: new URL(snapshot.base, location.href).href,
    saved: saved.texts.get(DEMO_PUBLISH_STATE_FILE),
    persist: (text) => void store.saveFile(DEMO_PUBLISH_STATE_FILE, text),
    finished: () => chrome.note(PUBLISH_NOTE),
  });
  // Reset shows only while something differs from the bake, checked now for a
  // returning visitor and again as each change lands.
  const presence = new EditPresence(
    (file) => snapshot.sources[file],
    { edited: rooms.edited(), savedFiles: [...saved.texts.keys(), ...saved.blobs.keys()] },
    (present) => chrome.edits(present),
  );
  chrome.edits(presence.has());
  // Every source change and upload is something new to push and deploy.
  rooms.onText((file, text) => {
    presence.text(file, text);
    publish.edit();
  });
  const files = new DemoFiles(saved, (file, value) => {
    void store.saveFile(file, value);
    presence.file(file);
    if (value instanceof Blob) {
      publish.edit();
    }
  });
  const pages = new DemoPages(snapshot, rooms, nativeFetch, (reasons) => chrome.notShown(reasons));
  pages.listen();
  pagesWarm = () => pages.warm();
  // Only a visitor with edits needs the early answer, and only then is it worth waiting.
  if (rooms.edited().size > 0) {
    await pages.warm();
  }
  window.fetch = fetchStandIn(
    demoRoutes({ snapshot, rooms, files, publish, workspace, unknownRoute: (route) => console.debug('[stacki demo] answered without data:', route) }),
    nativeFetch,
  );
  window.WebSocket = socketStandIn(rooms, window.WebSocket);
  window.EventSource = eventSourceStandIn(window.EventSource);
  const publicURL = publicAssetResolver(snapshot.base);
  const builtURLs = await assetURLs;
  installAssetURLs((file) => files.uploadURL(file) ?? builtURLs[file] ?? publicURL(file));
  installServedPage(snapshot, nativeFetch);
  openInPreview();
  installKeepAwake(window);
  shareYjs(); // The client's build reads Yjs from here; see sharedYjs.ts.
  shareTypeScript(); // And TypeScript; see sharedTypeScript.ts.
  await import(/* @vite-ignore */ new URL('./studio.js', import.meta.url).href);
}

// The demo opens on the finished site, as a visitor would meet it: Studio's preview,
// with the editor a click on the preview button away. Said before Studio loads, which
// reads it once as it starts (InteractivePreview.tsx OPENS_IN_PREVIEW_META).
function openInPreview(): void {
  const meta = document.createElement('meta');
  meta.name = 'studio-opens-in-preview';
  meta.content = 'true';
  document.head.append(meta);
}

/** Keeps the address bar on the open page when this document stands at a page's own address. */
function installServedPage(snapshot: ReturnType<typeof parseBakeSnapshot>, nativeFetch: typeof fetch): void {
  const route = servedRoute(document);
  if (route === undefined) {
    return;
  }
  installPageAddress({
    pages: snapshot.pages,
    route,
    base: snapshot.base,
    window,
    title: async (page) => {
      try {
        // The canvas loads the same document, so this is usually the browser's cached copy.
        const response = await nativeFetch(`${snapshot.base}${page.document}`, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
        return response.ok ? documentTitle(await response.text()) : undefined;
      } catch {
        return undefined; // The tab keeps the last title; nothing else depends on it.
      }
    },
  });
}

start().catch((error: unknown) => {
  document.body.dataset['demoFailed'] = 'true';
  const message = document.getElementById('root');
  if (message !== null) {
    message.textContent = `The demo could not start. ${error instanceof Error ? error.message : String(error)}`;
  }
});
