// Where the Assets panel's files come from: the project, or one of the media
// hosts connected to it (Cloudflare R2, Bunny Storage, any S3-compatible host).
// The trail's first item is the current source, a dropdown (the app's shared
// Dropdown) listing every source with its logo, the current one checked at the
// row's end, and "Add connector" at its foot: Project › src › assets, or
// Cloudflare R2 · media › images. Picking another source opens it; picking the
// current one again goes to its top. A host's ⋯ in the panel header edits or
// removes it.
//
// A pick from a field that cannot take a URL (assetPick.ts, no `onPickURL`)
// lists the project alone; a host without media hosting (MEDIA_HOSTING_HOST)
// shows no hosts and no connector action.
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { AssetRequest } from '../../ui/assetPick';
import type { MediaConnection } from '../../../shared/properties/mediaHosting';
import { MEDIA_HOSTING_HOST, listMediaConnections, removeMediaConnection } from '../../ipc/mediaHostingBridge';
import { FolderIcon, PlusIcon } from '../../ui/Icons';
import Dropdown from '../../ui/Dropdown';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { HostedMediaBrowser, type HostedToast } from './HostedMediaBrowser';
import { HostedMediaConnect, ProviderIcon } from './HostedMediaConnect';
import { connectionDetail } from './hostedMediaModel';
import './hostedMedia.css';

/** How a source's view joins the others: the switcher that is the panel's heading. */
export interface SourceNavigation {
  readonly picker: React.ReactNode;
}

const PROJECT = 'project';
const ADD_CONNECTOR = 'add-connector';
// Projects whose last source and connections are remembered, so a reopened panel lays out at once.
const REMEMBERED_PROJECTS_MAX = 32;
const rememberedSources = new Map<string, string>();
const knownConnections = new Map<string, readonly MediaConnection[]>();

function remember<T>(map: Map<string, T>, projectPath: string, value: T): void {
  map.delete(projectPath);
  map.set(projectPath, value);
  if (map.size > REMEMBERED_PROJECTS_MAX) {
    const [oldest] = map.keys();
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

interface SourcesProps {
  readonly projectPath: string;
  readonly pick: AssetRequest | undefined;
  readonly onPickCancel: (() => void) | undefined;
  readonly showToast: HostedToast;
  readonly renderProject: (navigation: SourceNavigation) => React.ReactNode;
}

type Connecting = { readonly kind: 'closed' } | { readonly kind: 'new' } | { readonly kind: 'edit'; readonly connection: MediaConnection };

export function AssetSources(props: SourcesProps) {
  const { projectPath, showToast } = props;
  const translate = useTranslate();
  const [connections, setConnectionsState] = useState<readonly MediaConnection[]>(() => knownConnections.get(projectPath) ?? []);
  const [source, setSourceState] = useState<string>(() => rememberedSources.get(projectPath) ?? PROJECT);
  const [connecting, setConnecting] = useState<Connecting>({ kind: 'closed' });
  const setConnections = useCallback(
    (next: readonly MediaConnection[]) => {
      remember(knownConnections, projectPath, next);
      setConnectionsState(next);
    },
    [projectPath],
  );
  const setSource = useCallback(
    (next: string) => {
      remember(rememberedSources, projectPath, next);
      setSourceState(next);
    },
    [projectPath],
  );
  useEffect(() => {
    if (!MEDIA_HOSTING_HOST.available) {
      return;
    }
    let live = true;
    listMediaConnections(projectPath).then(
      (list) => {
        if (live) {
          setConnections(list.connections);
        }
      },
      (error: unknown) => console.warn('Could not read media connections:', error),
    );
    return () => {
      live = false;
    };
  }, [projectPath, setConnections]);
  const remove = useCallback(
    async (connection: MediaConnection) => {
      const confirmed = await confirmDialog({
        title: translate('assets.source.removeTitle', { label: connection.label }),
        body: translate('assets.source.removeBody'),
        confirmLabel: translate('ui.remove'),
        danger: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        setConnections((await removeMediaConnection(projectPath, connection.id)).connections);
        setSource(PROJECT);
      } catch (error: unknown) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    },
    [projectPath, setConnections, setSource, showToast, translate],
  );
  const hostedAllowed = MEDIA_HOSTING_HOST.available && (props.pick === undefined || props.pick.onPickURL !== undefined);
  const listed = hostedAllowed ? connections : [];
  const hosted = listed.find((connection) => connection.id === source);
  const picker = (
    <SourcePicker
      connections={listed}
      current={hosted?.id ?? PROJECT}
      canConnect={hostedAllowed}
      onPick={(next) => {
        if (next === ADD_CONNECTOR) {
          setConnecting({ kind: 'new' });
        } else {
          setSource(next);
        }
      }}
    />
  );
  const navigation: SourceNavigation = { picker };
  return (
    <>
      {hosted === undefined ? (
        props.renderProject(navigation)
      ) : (
        <HostedMediaBrowser
          key={hosted.id}
          projectPath={projectPath}
          connection={hosted}
          navigation={navigation}
          pick={props.pick}
          onPickCancel={props.onPickCancel}
          showToast={showToast}
          onEdit={() => setConnecting({ kind: 'edit', connection: hosted })}
          onRemove={() => void remove(hosted)}
        />
      )}
      {connecting.kind !== 'closed' && (
        <HostedMediaConnect
          projectPath={projectPath}
          editing={connecting.kind === 'edit' ? connecting.connection : undefined}
          close={() => setConnecting({ kind: 'closed' })}
          onConnected={(list) => {
            setConnections(list.connections);
            setSource(list.connections.at(-1)?.id ?? PROJECT);
          }}
        />
      )}
    </>
  );
}

// The panel's heading is one dropdown (the app's shared Dropdown): the current
// source's icon or logo, its name and a chevron. Its menu lists every source,
// the current one checked at the row's end, and "Add connector" at its foot.
// Going to a source's top is the trail's "Assets" crumb, not the heading.
function SourcePicker(props: {
  readonly connections: readonly MediaConnection[];
  readonly current: string;
  readonly canConnect: boolean;
  readonly onPick: (value: string) => void;
}) {
  const translate = useTranslate();
  const options = [
    { value: PROJECT, label: translate('assets.source.project'), icon: <FolderIcon size={13} /> },
    ...props.connections.map((connection) => ({
      value: connection.id,
      label: connectionDetail(connection),
      icon: <ProviderIcon kind={connection.kind} size={13} />,
    })),
    ...(props.canConnect ? [{ value: ADD_CONNECTOR, label: translate('assets.source.addConnector'), icon: <PlusIcon size={12} />, dim: true }] : []),
  ];
  return (
    <h2 className="asset-source-heading">
      <Dropdown
        value={props.current}
        options={options}
        ariaLabel={translate('assets.source.switch')}
        className="asset-source-switch"
        menuClassName="asset-source-menu"
        menuWidthMin={200}
        livePreview={false}
        onChange={props.onPick}
      />
    </h2>
  );
}
