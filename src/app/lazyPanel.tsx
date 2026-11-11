import React, { useState } from 'react';
import type { ComponentType } from 'react';
import { assert } from '../../shared/core/assert';

/** A panel loaded on demand, whose chunk can also be fetched ahead of its first open. */
export type LazyPanel<Props extends object> = ComponentType<Props> & {
  /** Fetches the chunk; a panel mounted after it settles renders in its first frame. */
  readonly preload: () => Promise<void>;
};

// Keep loading inside the panel: suspending the editor hides its preview and
// disconnects layout effects that must stay active while another panel opens.
//
// Why `preload`: React.lazy suspends on the first render of its component even
// when the chunk is already in the module cache, because it learns of the
// resolved promise only in a later microtask. That suspended render commits an
// empty panel for a frame, which read as a flicker the first time each panel
// opened. Once `preload` has settled, a new instance renders the loaded
// component directly and never suspends.
export function lazyPanel<Props extends object>(load: () => Promise<{ readonly default: ComponentType<Props> }>): LazyPanel<Props> {
  let loaded: ComponentType<Props> | undefined;
  let loading: Promise<ComponentType<Props>> | undefined;
  const start = (): Promise<ComponentType<Props>> => {
    if (loading === undefined) {
      loading = load().then(
        ({ default: Panel }) => {
          loaded = Panel;
          return Panel;
        },
        (error: unknown) => {
          // A failed fetch is not remembered: the next open asks again.
          loading = undefined;
          throw error;
        },
      );
    }
    return loading;
  };
  const Content = React.lazy(async () => {
    const Panel = await start();
    return {
      default: function PanelContent({ panelProps }: { readonly panelProps: Props }) {
        return <Panel {...panelProps} />;
      },
    };
  });
  function DeferredPanel(props: Props) {
    // Chosen once per instance: switching from the lazy element to the loaded
    // component later would remount the panel and discard its state.
    const [Ready] = useState(() => loaded);
    // A Suspense boundary with an undefined fallback is skipped in React 18 and
    // the suspension climbs to the next one; null is what renders nothing here.
    return (
      // eslint-disable-next-line stacki/no-null -- undefined here means "no boundary".
      <React.Suspense fallback={null}>{Ready === undefined ? <Content panelProps={props} /> : <Ready {...props} />}</React.Suspense>
    );
  }
  const preload = async (): Promise<void> => {
    const Panel = await start();
    assert(loaded === Panel, 'lazyPanel: a settled preload leaves the panel ready to render');
  };
  return Object.assign(DeferredPanel, { preload });
}
