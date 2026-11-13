// A saved Payload connection's card details: whether the account works (checked on demand, never behind
// the person's back: a check is a login for a password connection), what it can reach, and how to use the
// same server from the site's own pages. The key never appears here; only the address and the variable names.
import { useState } from 'react';
import { checkCmsConnection } from '../../ipc/cmsConnectionsBridge';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { CodeBlock } from '../../ui/CodeBlock';
import type { CmsConnection, PayloadSummary } from '../../../shared/properties/cmsConnections';

type Payload = Extract<CmsConnection, { readonly kind: 'payload' }>;

/** What the last check said: not run, running, the account's summary, or why it failed. */
type CheckState =
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'testing' }
  | { readonly kind: 'ok'; readonly summary: PayloadSummary }
  | { readonly kind: 'failed'; readonly message: string; readonly at: number };

export function PayloadStatus(props: { readonly projectPath: string; readonly connection: Payload; readonly onDisconnect: () => void }) {
  const translate = useTranslate();
  const describe = useTranslateDescribed();
  const format = useFormat();
  const [state, setState] = useState<CheckState>({ kind: 'unchecked' });
  const [snippet, setSnippet] = useState(false);
  const test = async () => {
    setState({ kind: 'testing' });
    const result = await checkCmsConnection(props.projectPath, { action: 'test', id: props.connection.id });
    setState(result.ok ? { kind: 'ok', summary: result.summary } : { kind: 'failed', message: describe(result), at: Date.now() });
  };
  const live = state.kind === 'ok' ? state.summary.collections.filter((collection) => !collection.drafts && !collection.upload) : [];
  return (
    <div className="cms-payload-status">
      <div className="cms-payload-line">
        <span className={`cms-payload-chip is-${state.kind}`} role="status">
          {chipText(state, props.connection, translate)}
        </span>
        {state.kind === 'ok' && (
          <span className="cms-payload-time">
            {translate('settings.cms.payload.status.checked', { time: format.formatRelativeTime(new Date(state.summary.checkedAt), Date.now()) })}
          </span>
        )}
        {state.kind === 'failed' && (
          <span className="cms-payload-time">
            {translate('settings.cms.payload.status.checked', { time: format.formatRelativeTime(state.at, Date.now()) })}
          </span>
        )}
        <span className="cms-payload-spacer" />
        <button type="button" disabled={state.kind === 'testing'} onClick={() => void test()}>
          {translate(state.kind === 'testing' ? 'settings.cms.payload.testing' : 'settings.cms.payload.test')}
        </button>
        <button type="button" className="ghost" onClick={() => setSnippet(!snippet)} aria-expanded={snippet}>
          {translate('settings.cms.payload.snippet.title')}
        </button>
        <button type="button" className="ghost" onClick={props.onDisconnect}>
          {translate('settings.cms.payload.disconnect')}
        </button>
      </div>
      {state.kind === 'failed' && <p className="cms-payload-problem">{state.message}</p>}
      {live.length > 0 && (
        <p className="cms-payload-live">{translate('settings.cms.payload.liveIn', { names: live.map((collection) => collection.slug).join(', ') })}</p>
      )}
      {snippet && <SiteSnippet connection={props.connection} />}
    </div>
  );
}

function chipText(state: CheckState, connection: Payload, translate: ReturnType<typeof useTranslate>): string {
  switch (state.kind) {
    case 'unchecked':
      return translate('settings.cms.payload.status.unchecked');
    case 'testing':
      return translate('settings.cms.payload.testing');
    case 'failed':
      return translate('settings.cms.payload.status.failed');
    case 'ok':
      return connection.auth === 'apiKey' && state.summary.user === connection.collection
        ? translate('settings.cms.payload.status.apiKey')
        : translate('settings.cms.payload.status.connectedAs', { user: state.summary.user });
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// The variables a site's own build reads, and the request that uses them. The value of the key is
// never written here: it lives in the encrypted connection store, and the person copies their own.
function SiteSnippet({ connection }: { readonly connection: Payload }) {
  const translate = useTranslate();
  const header =
    connection.auth === 'apiKey'
      ? `${connection.collection} API-Key \${import.meta.env.PAYLOAD_API_KEY}`
      : 'JWT <token from /api/' + connection.collection + '/login>';
  const env = `PAYLOAD_URL=${connection.baseUrl}\nPAYLOAD_API_KEY=<your API key>`;
  const code = [
    '---',
    'const response = await fetch(`${import.meta.env.PAYLOAD_URL}/api/posts?limit=10&depth=0`, {',
    `  headers: { Authorization: \`${header}\` },`,
    '});',
    'const { docs } = await response.json();',
    '---',
  ].join('\n');
  return (
    <div className="cms-payload-snippet">
      <p>{translate('settings.cms.payload.snippet.info')}</p>
      <CodeBlock text={env} language="shell" label=".env" />
      <CodeBlock text={code} language="astro" label="src/pages/index.astro" />
    </div>
  );
}
