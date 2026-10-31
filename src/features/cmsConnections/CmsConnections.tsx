// The project's CMS connections, in Settings: which hosted CMS its content comes
// from, and the key Stacki saves drafts with. Shown the same in Desktop and in
// Stacki Studio; only the bridge underneath differs (src/ipc/cmsConnectionsBridge.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import './cmsConnections.css';
import { InfoLabel } from '../../ui/InfoLabel';
import Popup from '../../ui/Popup';
import { ErrorToast } from '../../ui/ErrorToast';
import { CmsIcon, PayloadIcon, SanityIcon } from '../../ui/Icons';
import {
  CMS_CONNECTION_HOST,
  listCmsConnections,
  removeCmsConnection,
} from '../../ipc/cmsConnectionsBridge';
import type { CmsConnection, CmsConnectionList } from '../../../shared/properties/cmsConnections';
import { SanitySignIn } from './SanitySignIn';
import { CmsKeyForm, type CmsKeyKind } from './CmsKeyForm';

type Dialog =
  { readonly kind: 'sanity-login' } | { readonly kind: 'key'; readonly cms: CmsKeyKind };

export function CmsConnections({ projectPath }: { readonly projectPath: string }) {
  const [list, setList] = useState<CmsConnectionList | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const refresh = useCallback(() => {
    listCmsConnections(projectPath).then(setList, (reason: unknown) => setError(String(reason)));
  }, [projectPath]);
  useEffect(refresh, [refresh]);
  const remove = (connection: CmsConnection) => {
    removeCmsConnection(projectPath, connection.id).then(setList, (reason: unknown) =>
      setError(String(reason)),
    );
  };
  const closed = () => {
    setDialog(undefined);
    refresh();
  };
  return (
    <section className="cms-connections" aria-label="CMS connections">
      <h3>
        <InfoLabel
          label="CMS connections"
          description={
            'Connect the CMS this site’s content comes from, so text from it can be edited on ' +
            'the canvas. Edits are saved as drafts in the CMS; nothing is published.'
          }
        />
      </h3>
      {error && <ErrorToast message={error} />}
      {list?.encryption === 'unavailable' && (
        <p className="cms-connections-alert">
          This computer can’t encrypt keys, so Stacki won’t save any.
        </p>
      )}
      <ConnectionRows connections={list?.connections ?? []} onRemove={remove} />
      <ConnectionActions onOpen={setDialog} />
      {dialog?.kind === 'sanity-login' && <SanitySignIn projectPath={projectPath} close={closed} />}
      {dialog?.kind === 'key' && (
        <CmsKeyForm projectPath={projectPath} cms={dialog.cms} close={closed} />
      )}
    </section>
  );
}

function ConnectionRows(props: {
  readonly connections: readonly CmsConnection[];
  readonly onRemove: (connection: CmsConnection) => void;
}) {
  if (props.connections.length === 0) {
    return <p>No CMS connected.</p>;
  }
  return (
    <ul className="cms-connection-list">
      {props.connections.map((connection) => (
        <li key={connection.id} className="cms-connection-row" data-cms={connection.kind}>
          <ConnectionIcon kind={connection.kind} />
          <span className="cms-connection-label">{connection.label}</span>
          <span className="cms-connection-detail">{connectionDetail(connection)}</span>
          <button type="button" className="ghost" onClick={() => props.onRemove(connection)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

// Sanity as a split button, like Publish: its login where the host has one, a
// pasted key behind the arrow (and in front where there is no login, as in
// Studio until Sanity registers Stacki for OAuth). Payload and custom CMSs sit
// beside it as buttons of their own.
function ConnectionActions({ onOpen }: { readonly onOpen: (dialog: Dialog) => void }) {
  return (
    <div className="cms-connection-actions">
      {CMS_CONNECTION_HOST.sanityLogin === 'none' ? (
        <button type="button" onClick={() => onOpen({ kind: 'key', cms: 'sanity' })}>
          <SanityIcon size={14} />
          Connect Sanity
        </button>
      ) : (
        <SanityConnect onOpen={onOpen} />
      )}
      <button type="button" onClick={() => onOpen({ kind: 'key', cms: 'payload' })}>
        <PayloadIcon size={14} />
        Payload
      </button>
      <button type="button" onClick={() => onOpen({ kind: 'key', cms: 'custom' })}>
        <CmsIcon size={14} />
        Custom CMS
      </button>
    </div>
  );
}

function SanityConnect({ onOpen }: { readonly onOpen: (dialog: Dialog) => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  return (
    <div
      className="cms-connect-control"
      ref={container}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
        }
      }}
    >
      <div className="cms-connect-split">
        <button type="button" onClick={() => onOpen({ kind: 'sanity-login' })}>
          <SanityIcon size={14} />
          Log in with Sanity
        </button>
        <button
          type="button"
          className="cms-connect-arrow"
          aria-label="More ways to connect Sanity"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <svg width="6" height="4" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M0 0h10L5 6z" fill="currentColor" />
          </svg>
        </button>
      </div>
      <Popup
        mode="popover"
        portal={false}
        open={open}
        anchor={container.current ?? undefined}
        onClose={() => setOpen(false)}
        className="cms-connect-menu"
        label="Connect Sanity"
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onOpen({ kind: 'key', cms: 'sanity' });
          }}
        >
          <SanityIcon size={16} />
          Paste a Sanity key
        </button>
      </Popup>
    </div>
  );
}

function ConnectionIcon({ kind }: { readonly kind: CmsConnection['kind'] }) {
  switch (kind) {
    case 'sanity':
      return <SanityIcon size={16} />;
    case 'payload':
      return <PayloadIcon size={16} />;
    case 'custom':
      return <CmsIcon size={16} />;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function connectionDetail(connection: CmsConnection): string {
  switch (connection.kind) {
    case 'sanity':
      return `${connection.projectId} / ${connection.dataset}`;
    case 'payload':
    case 'custom':
      return new URL(connection.baseUrl).host;
    default: {
      const exhaustive: never = connection;
      return exhaustive;
    }
  }
}
