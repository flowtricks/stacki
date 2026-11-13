import React from 'react';
import type { PanelData } from '../lib/usePanelData';
import { useTranslate } from '../lib/i18n/useTranslate';

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
  const translate = useTranslate();
  if (state.kind === 'loading') {
    return (
      <div className={`panel-loading panel-loading-layout-${layout}`} role="status" aria-label={translate('ui.panelStatus.loading', { label })}>
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
          {translate('ui.retry')}
        </button>
      </div>
    );
  }
  return undefined;
}
