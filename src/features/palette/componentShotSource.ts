import { useEffect, useMemo, useState } from 'react';
import type { ComponentShotEntry } from '../../../shared/properties/componentShots';

// Where the insert palette gets photographs of components from. The desktop app answers from its
// main process; the Studio in a browser has none, passes nothing, and every card falls back to the
// live preview route. The palette sees only this interface, so neither transport leaks into it.

export interface ComponentShotSource {
  /** The photographs stored now. */
  readonly list: () => Promise<readonly ComponentShotEntry[]>;
  /** One photograph as a data URL; undefined when it is gone. */
  readonly read: (component: string) => Promise<string | undefined>;
  /** Called when a run has stored new photographs. Returns the unsubscribe. */
  readonly onChanged: (listener: () => void) => () => void;
}

/** What a card may ask: is there a photograph for this file, and what are its bytes. */
export interface ShotAccess {
  readonly has: (component: string) => boolean;
  /** The logical width the component was photographed at, so it is drawn at the scale of its card. */
  readonly width: (component: string) => number | undefined;
  readonly load: (component: string) => Promise<string | undefined>;
  /** The photograph could not be read or drawn: from now on the component has none. */
  readonly fail: (component: string) => void;
}

type Catalog =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'ready';
      /** Each photographed component and the logical width it was photographed at. */
      readonly entries: ReadonlyMap<string, number>;
      readonly loads: Map<string, Promise<string | undefined>>;
    };

export interface ShotCatalog {
  /** Undefined without a source, and until the catalog has answered. */
  readonly access: ShotAccess | undefined;
  /**
   * False while a source exists but has not answered yet. A card cannot tell whether it has a photograph
   * before then, and starting its live frame first would waste the frame and then drop it.
   */
  readonly settled: boolean;
}

/**
 * The catalog of stored photographs, kept current: read once when the palette opens and again
 * whenever a run reports new ones. If the first read fails the catalog is empty and settled, since the
 * live preview is always the fallback; a later failed read leaves the previous catalog standing.
 */
export function useShotCatalog(source: ComponentShotSource | undefined): ShotCatalog {
  const [catalog, setCatalog] = useState<Catalog>({ kind: 'pending' });
  // Photographs that turned out to be unreadable: from then on the card has none, and takes the live route.
  const [failed, setFailed] = useState<{ readonly catalog: Catalog; readonly components: ReadonlySet<string> } | undefined>(undefined);
  useEffect(() => {
    if (source === undefined) {
      return;
    }
    let active = true;
    const refresh = (): void => {
      source
        .list()
        .then((entries) => {
          if (active) {
            // New photographs may replace old ones under the same name, so no earlier load is reused.
            setCatalog({ kind: 'ready', entries: new Map(entries.map((entry) => [entry.component, entry.width])), loads: new Map() });
          }
        })
        .catch(() => {
          if (active) {
            setCatalog((current) => (current.kind === 'ready' ? current : { kind: 'ready', entries: new Map(), loads: new Map() }));
          }
        });
    };
    refresh();
    const unsubscribe = source.onChanged(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [source]);
  const access = useMemo((): ShotAccess | undefined => {
    if (source === undefined || catalog.kind === 'pending') {
      return undefined;
    }
    const unreadable = failed?.catalog === catalog ? failed.components : new Set<string>();
    const fail = (component: string): void => {
      setFailed((current) => ({ catalog, components: new Set([...(current?.catalog === catalog ? current.components : []), component]) }));
    };
    return {
      fail,
      has: (component) => catalog.entries.has(component) && !unreadable.has(component),
      width: (component) => catalog.entries.get(component),
      load: (component) => {
        const known = catalog.loads.get(component);
        if (known !== undefined) {
          return known;
        }
        const started = source
          .read(component)
          .catch(() => undefined)
          .then((url) => {
            if (url === undefined) {
              fail(component);
            }
            return url;
          });
        catalog.loads.set(component, started);
        return started;
      },
    };
  }, [source, catalog, failed]);
  return { access, settled: source === undefined || catalog.kind === 'ready' };
}

export type ShotImage =
  { readonly kind: 'none' } | { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly url: string } | { readonly kind: 'failed' };

/**
 * The photograph of `component` once it is wanted. `none` means there is no photograph, which is the
 * live preview's cue; `loading` means there is one and it is on its way.
 */
export function useShotImage(access: ShotAccess | undefined, component: string | undefined, { wanted }: { readonly wanted: boolean }): ShotImage {
  const [loaded, setLoaded] = useState<{ readonly component: string; readonly url: string | undefined } | undefined>(undefined);
  const present = access !== undefined && component !== undefined && access.has(component);
  useEffect(() => {
    if (!present || !wanted || access === undefined || component === undefined) {
      return;
    }
    let active = true;
    void access.load(component).then((url) => {
      if (active) {
        setLoaded({ component, url });
      }
    });
    return () => {
      active = false;
    };
  }, [present, wanted, access, component]);
  if (!present) {
    return { kind: 'none' };
  }
  // A new catalog for the same component keeps the picture on screen until its replacement has been read.
  if (loaded === undefined || loaded.component !== component) {
    return { kind: 'loading' };
  }
  return loaded.url === undefined ? { kind: 'failed' } : { kind: 'ready', url: loaded.url };
}
