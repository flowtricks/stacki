import { useEffect, useSyncExternalStore } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { PreviewPriority } from '../../../shared/properties/previewQueue';
import type { TileState } from '../../../shared/properties/previewTile';
import { TILE_IDLE } from '../../../shared/properties/previewTile';
import type { TrailingSlash } from '../../editor/pageState';
import { componentPreviewURL } from './paletteModel';
import { PreviewSnapshotStore, storeFor, type TileRequest, type TileSource } from './previewSnapshotStore';
import { indexedDBPersistence } from './snapshotPersistence';
import { createFrameProducer } from './snapshotProducer';

// How the palette finds its tiles' store: one per project, made on first use with the browser's own
// IndexedDB behind it, kept across the palette closing and opening, and told when the dev server moves.

interface HostLinks {
  resolvePreviewURL: ((url: string) => Promise<string>) | undefined;
  devURL: string | undefined;
}

const links = new Map<string, HostLinks>();

/** The store of a project's pictures; the same one every time for the same project. */
export function previewStoreFor(
  projectKey: string,
  host: { readonly devURL: string | undefined; readonly resolvePreviewURL?: ((url: string) => Promise<string>) | undefined },
): PreviewSnapshotStore {
  const held: HostLinks = links.get(projectKey) ?? { resolvePreviewURL: undefined, devURL: undefined };
  links.set(projectKey, held);
  held.resolvePreviewURL = host.resolvePreviewURL;
  const store = storeFor(projectKey, () => {
    const produce = createFrameProducer({
      document: () => document,
      resolve: (url) => (held.resolvePreviewURL === undefined ? Promise.resolve(url) : held.resolvePreviewURL(url)),
    });
    return new PreviewSnapshotStore(projectKey, produce, { persistence: indexedDBPersistence(typeof indexedDB === 'undefined' ? undefined : indexedDB) });
  });
  if (held.devURL !== host.devURL) {
    // The server's address changed (a restart picks a new port): what waited for the old one is dropped, pictures stay.
    if (held.devURL !== undefined) {
      store.cancelWaiting();
      store.invalidateChecks();
    }
    held.devURL = host.devURL;
  }
  return store;
}

/** The identity of a component's tile within its project. */
export function tileId(component: ScanComponent): string {
  return component.file ?? [component.folder, `${component.name}.astro`].filter((part) => part !== '').join('/');
}

/** The tile for a component, or undefined when there is no server to render it with. */
export function tileSource(component: ScanComponent, devURL: string | undefined, trailingSlash: TrailingSlash): TileSource | undefined {
  if (devURL === undefined) {
    return undefined;
  }
  return { id: tileId(component), name: component.name, url: componentPreviewURL(devURL, component, trailingSlash, { layout: 'snapshot' }) };
}

export function tileRequests(
  components: readonly ScanComponent[],
  devURL: string | undefined,
  trailingSlash: TrailingSlash,
  visible: ReadonlySet<string>,
): readonly TileRequest[] {
  const requests: TileRequest[] = [];
  components.forEach((component, order) => {
    const source = tileSource(component, devURL, trailingSlash);
    if (source !== undefined) {
      const priority: PreviewPriority = visible.has(source.id) ? 'visible' : 'background';
      requests.push({ source, priority, order });
    }
  });
  return requests;
}

/** The state of one tile, re-read whenever the store changes it. */
export function useTileState(store: PreviewSnapshotStore | undefined, id: string | undefined): TileState {
  const subscribe = (listener: () => void): (() => void) => (store === undefined ? () => undefined : store.subscribe(listener));
  return useSyncExternalStore(subscribe, () => (store === undefined || id === undefined ? TILE_IDLE : store.tile(id)));
}

/**
 * Starts rendering a project's tiles in the background as soon as the dev server is up, a few at a time,
 * so the palette finds them waiting. Quiet: the queue is bounded and each render is one hidden page load.
 */
export function usePreviewPrewarm(
  projectKey: string | undefined,
  components: readonly ScanComponent[] | undefined,
  host: {
    readonly devURL: string | undefined;
    readonly trailingSlash: TrailingSlash;
    readonly resolvePreviewURL?: ((url: string) => Promise<string>) | undefined;
  },
): void {
  const devURL = host.devURL;
  const trailingSlash = host.trailingSlash;
  const resolvePreviewURL = host.resolvePreviewURL;
  useEffect(() => {
    if (projectKey === undefined || components === undefined || devURL === undefined) {
      return;
    }
    // Wait for the browser to be idle: the editor's own first paint comes first.
    const start = (): void => {
      const store = previewStoreFor(projectKey, { devURL, resolvePreviewURL });
      store.request(
        tileRequests(
          components.filter((component) => component.origin?.kind !== 'package'),
          devURL,
          trailingSlash,
          new Set<string>(),
        ),
      );
    };
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(start, { timeout: 4000 }) : window.setTimeout(start, 1500);
    return () => {
      if (typeof cancelIdleCallback === 'function' && typeof idle === 'number') {
        cancelIdleCallback(idle);
      }
      window.clearTimeout(idle);
    };
  }, [projectKey, components, devURL, trailingSlash, resolvePreviewURL]);
}
