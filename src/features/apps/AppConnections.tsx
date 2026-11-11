// What an app reaches outside Stacki, as the editor shows it (docs/apps.md,
// "External services" and "Signing in"):
//
// - `AppNetworkNote`: one line, "Uses external services: host (why), …" on an
//   amber fill, or "Works fully offline". The install confirmation and the
//   marketplace rows show it, so nobody installs an app without seeing where it
//   connects; the frame's content security policy holds the app to the same
//   list (shared/properties/appSdk.ts).
// - `AppConnectionsSection`: the details popup's "Connections" section, one row
//   per OAuth provider the app declares: "Connect Google Analytics", or the
//   account it is connected as and Disconnect. The sign-in runs in the host
//   (src/ipc/appAccessBridge.ts), with the installer's own client from the
//   app's settings; tokens never reach this view.
import { useCallback, useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { networkSummary, type AppAuthStatus, type AppNetworkHost } from '../../../shared/properties/appAuth';
import type { AppSummary } from '../../../shared/properties/apps';
import { connectAppAuth, disconnectAppAuth, onAppAuthChanged, readAppAuthStatus } from '../../ipc/appAccessBridge';
import { WarningTriangleIcon } from '../../ui/Icons';
import { AppDetailsRow, AppDetailsSection } from './AppDetailsLayout';

/** "Uses external services: …" with a small warning style, or "Works fully offline". */
export function AppNetworkNote({ network }: { readonly network: readonly AppNetworkHost[] }) {
  const summary = networkSummary(network);
  if (network.length === 0) {
    return <p className="apps-network-note offline">{summary}</p>;
  }
  return (
    <p className="apps-network-note external" title={summary}>
      <WarningTriangleIcon size={12} />
      <span>{summary}</span>
    </p>
  );
}

type ConnectionsLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly statuses: readonly AppAuthStatus[] };

/** The details popup's "Connections" section; nothing for an app that signs in nowhere. */
export function AppConnectionsSection({ projectPath, app }: { readonly projectPath: string; readonly app: AppSummary }) {
  const { manifest } = app;
  const [load, setLoad] = useState<ConnectionsLoad>({ kind: 'loading' });
  const [working, setWorking] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const declared = manifest.auth.length > 0;
  const refresh = useCallback(() => {
    if (!declared) {
      return;
    }
    void readAppAuthStatus(projectPath, manifest.id).then(
      (answer) => setLoad(answer.ok ? { kind: 'ready', statuses: answer.value } : { kind: 'failed', message: answer.message }),
      (error: unknown) => setLoad({ kind: 'failed', message: String(error) }),
    );
  }, [projectPath, manifest.id, declared]);
  useEffect(() => {
    refresh();
    return onAppAuthChanged((appId) => {
      if (appId === manifest.id) {
        refresh();
      }
    });
  }, [refresh, manifest.id]);
  if (!declared) {
    return undefined;
  }
  const act = (provider: string, run: () => Promise<{ readonly ok: boolean; readonly message?: string }>) => {
    setWorking(provider);
    setProblem(undefined);
    void run().then(
      (answer) => {
        setWorking(undefined);
        if (!answer.ok) {
          setProblem(answer.message);
        }
        refresh();
      },
      (error: unknown) => {
        setWorking(undefined);
        setProblem(String(error));
      },
    );
  };
  return (
    <AppDetailsSection title="Connections" hint="Each person signs in with their own account. Tokens stay on this computer, never in the project.">
      {manifest.auth.map((provider) => {
        const status = load.kind === 'ready' ? load.statuses.find((entry) => entry.provider === provider.id) : undefined;
        const busy = working === provider.id;
        assert(provider.label.length > 0, 'A provider has a label');
        if (status?.connected === true) {
          return (
            <AppDetailsRow key={provider.id} label={provider.label} description={status.account === undefined ? 'Connected' : `Connected as ${status.account}`}>
              <button
                type="button"
                className="apps-button"
                disabled={working !== undefined}
                onClick={() => act(provider.id, () => disconnectAppAuth(projectPath, manifest.id, provider.id))}
              >
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </AppDetailsRow>
          );
        }
        return (
          <AppDetailsRow key={provider.id} label={provider.label} description={describeDisconnected({ busy, load, status })}>
            <button
              type="button"
              className="apps-button primary"
              disabled={working !== undefined || load.kind === 'loading'}
              onClick={() => act(provider.id, () => connectAppAuth(projectPath, manifest.id, provider.id))}
            >
              {busy ? 'Waiting…' : `Connect ${provider.label}`}
            </button>
          </AppDetailsRow>
        );
      })}
      {problem !== undefined && <p className="apps-connections-problem">{problem}</p>}
      <OwnClientNote app={app} />
    </AppDetailsSection>
  );
}

/**
 * The advanced fallback, out of the way until asked for: a Stacki connection that also names client
 * settings signs in with the installer's own OAuth client once they fill those in (appSignIn.ts routeOf).
 * A custom provider always does, which the note says plainly.
 */
function OwnClientNote({ app }: { readonly app: AppSummary }) {
  const own = app.manifest.auth.filter((provider) => provider.clientIdSetting !== undefined);
  if (own.length === 0) {
    return undefined;
  }
  const custom = own.filter((provider) => provider.connection === undefined);
  if (custom.length === own.length) {
    return (
      <p className="apps-connections-note">
        Signs in with your own OAuth client: fill in its client id in App settings, and register this app’s redirect address with it.
      </p>
    );
  }
  return (
    <details className="apps-connections-advanced">
      <summary>Advanced: use your own OAuth client</summary>
      <p>
        Fill in your own client id (and secret, where the provider needs one) in App settings, and Stacki signs in with your client instead of Stacki’s.
        Register the loopback address on this computer as its redirect; clear the client id to go back to Stacki’s connection.
      </p>
    </details>
  );
}

// What a row that is not connected says: waiting on the browser, a failed read, a connection that cannot sign in now, or plainly not connected.
function describeDisconnected(row: { readonly busy: boolean; readonly load: ConnectionsLoad; readonly status: AppAuthStatus | undefined }): string {
  if (row.busy) {
    return 'Finish signing in in your browser.';
  }
  if (row.load.kind === 'failed') {
    return row.load.message;
  }
  if (row.status !== undefined && !row.status.connected && 'code' in row.status) {
    return row.status.message;
  }
  return 'Not connected';
}
