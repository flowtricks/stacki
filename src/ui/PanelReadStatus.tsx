import React from 'react';
import type { PanelData } from '../lib/usePanelData';

export function PanelReadStatus({
  state,
  label,
  retry,
  layout = 'rows',
}: {
  readonly state: PanelData<unknown>;
  readonly label: string;
  readonly retry: () => Promise<void>;
  readonly layout?: 'rows' | 'assets' | 'history';
}) {
  if (state.kind === 'loading') {
    return (
      <div className={`panel-loading panel-loading-layout-${layout}`} role="status" aria-label={`Loading ${label}…`}>
        <div className="panel-loading-rows" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty" role="alert">
        <p>{state.message}</p>
        <button className="ghost" onClick={() => void retry()}>
          Retry
        </button>
      </div>
    );
  }
  return undefined;
}
