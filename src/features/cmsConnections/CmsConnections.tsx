import { ChevronDownIcon } from '../../ui/Icons';
// The project's CMS connections, in Settings: which hosted CMS its content comes
// from, and the key Stacki saves drafts with. Shown the same in Desktop and in
// Stacki Studio; only the bridge underneath differs (src/ipc/cmsConnectionsBridge.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import './cmsConnections.css';
import Popup from '../../ui/Popup';
import { ErrorToast } from '../../ui/ErrorToast';
import { CmsIcon, PayloadIcon, SanityIcon } from '../../ui/Icons';
import { CMS_CONNECTION_HOST, listCmsConnections, removeCmsConnection } from '../../ipc/cmsConnectionsBridge';
import type { CmsConnection, CmsConnectionList } from '../../../shared/properties/cmsConnections';
import { SanitySignIn } from './SanitySignIn';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CmsKeyForm, type CmsKeyKind } from './CmsKeyForm';
import { PayloadStatus } from './PayloadStatus';
import { SkeletonRows } from '../../ui/Skeleton';

type Dialog = { readonly kind: 'sanity-login' } | { readonly kind: 'key'; readonly cms: CmsKeyKind };

export function CmsConnections({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const [list, setList] = useState<CmsConnectionList | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const refresh = useCallback(() => {
    listCmsConnections(projectPath).then(setList, (reason: unknown) => setError(String(reason)));
  }, [projectPath]);
  useEffect(refresh, [refresh]);
  const remove = (connection: CmsConnection) => {
    removeCmsConnection(projectPath, connection.id).then(setList, (reason: unknown) => setError(String(reason)));
  };
  const closed = () => {
    setDialog(undefined);
    refresh();
  };
  return (
    <section className="cms-connections" aria-label={translate('cmsConnections.title')}>
      {error && <ErrorToast message={error} />}
      {list?.encryption === 'unavailable' && <p className="cms-connections-alert">{translate('cmsConnections.list.noEncryption')}</p>}
      {list === undefined ? <SkeletonRows count={2} /> : <ConnectionRows projectPath={projectPath} connections={list.connections} onRemove={remove} />}
      <ConnectionActions onOpen={setDialog} />
      {dialog?.kind === 'sanity-login' && <SanitySignIn projectPath={projectPath} close={closed} />}
      {dialog?.kind === 'key' && <CmsKeyForm projectPath={projectPath} cms={dialog.cms} close={closed} />}
    </section>
  );
}

function ConnectionRows(props: {
  readonly projectPath: string;
  readonly connections: readonly CmsConnection[];
  readonly onRemove: (connection: CmsConnection) => void;
}) {
  const translate = useTranslate();
  if (props.connections.length === 0) {
    return <p className="cms-connections-empty">{translate('settings.cms.empty')}</p>;
  }
  return (
    <ul className="cms-connection-list">
      {props.connections.map((connection) => (
        <li key={connection.id} className="cms-connection-row" data-cms={connection.kind}>
          <ConnectionIcon kind={connection.kind} />
          <span className="cms-connection-label">{connection.label}</span>
          <span className="cms-connection-detail">{connectionDetail(connection)}</span>
          {connection.kind !== 'payload' && (
            <button type="button" className="ghost" onClick={() => props.onRemove(connection)}>
              {translate('ui.remove')}
            </button>
          )}
          {connection.kind === 'payload' && (
            <PayloadStatus projectPath={props.projectPath} connection={connection} onDisconnect={() => props.onRemove(connection)} />
          )}
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
  const translate = useTranslate();
  return (
    <div className="cms-connection-actions">
      {CMS_CONNECTION_HOST.sanityLogin === 'none' ? (
        <button type="button" onClick={() => onOpen({ kind: 'key', cms: 'sanity' })}>
          <SanityIcon size={14} />
          {translate('cmsConnections.actions.connectSanity')}
        </button>
      ) : (
        <SanityConnect onOpen={onOpen} />
      )}
      <button type="button" onClick={() => onOpen({ kind: 'key', cms: 'payload' })}>
        <PayloadIcon size={14} />
        {/* i18n-ignore: Payload is a product name. */}
        Payload
      </button>
      <button type="button" onClick={() => onOpen({ kind: 'key', cms: 'custom' })}>
        <CmsIcon size={14} />
        {translate('cmsConnections.kind.custom')}
      </button>
    </div>
  );
}

function SanityConnect({ onOpen }: { readonly onOpen: (dialog: Dialog) => void }) {
  const translate = useTranslate();
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
          {translate('cmsConnections.actions.logInSanity')}
        </button>
        <button
          type="button"
          className="cms-connect-arrow"
          aria-label={translate('cmsConnections.actions.moreSanity')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronDownIcon size={12} />
        </button>
      </div>
      <Popup
        mode="popover"
        portal={false}
        open={open}
        anchor={container.current ?? undefined}
        onClose={() => setOpen(false)}
        className="cms-connect-menu"
        label={translate('cmsConnections.actions.connectSanity')}
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onOpen({ kind: 'key', cms: 'sanity' });
          }}
        >
          <SanityIcon size={16} />
          {translate('cmsConnections.actions.pasteSanityKey')}
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
