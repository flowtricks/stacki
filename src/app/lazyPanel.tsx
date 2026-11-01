import React from 'react';
import type { ComponentType } from 'react';

// Keep loading inside the panel: suspending the editor hides its preview and
// disconnects layout effects that must stay active while another panel opens.
export function lazyPanel<Props extends object>(load: () => Promise<{ readonly default: ComponentType<Props> }>): ComponentType<Props> {
  const Content = React.lazy(async () => {
    const { default: Panel } = await load();
    return {
      default: function PanelContent({ panelProps }: { readonly panelProps: Props }) {
        return <Panel {...panelProps} />;
      },
    };
  });
  return function DeferredPanel(props: Props) {
    // A Suspense boundary with an undefined fallback is skipped in React 18 and
    // the suspension climbs to the next one; null is what renders nothing here.
    return (
      // eslint-disable-next-line stacki/no-null -- undefined here means "no boundary".
      <React.Suspense fallback={null}>
        <Content panelProps={props} />
      </React.Suspense>
    );
  };
}
