import { createPanelCache, usePanelData, type PanelData } from '../../lib/usePanelData';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import type { Result } from '../../../shared/core/result';
import { cmsTransport } from '../../ipc/editorEnvironment';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection } from './cmsSchema';
import type { CmsPanelContent, CmsPanelContentCollection, CmsPanelFile } from './cmsPanelBridge';
import { collectionHasContent, collectionOf, labelize } from './cmsSchema';
import { createCmsCollection, readCmsFiles, readContentCollections } from './cmsPanelBridge';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CmsIcon,
  CollectionIcon,
  FileIcon,
  FolderDefaultIcon,
  GearIcon,
  HideIcon,
  PlusIcon,
} from '../../ui/Icons';
import { listCmsConnections } from '../../ipc/cmsConnectionsBridge';
import type { CmsConnection } from '../../../shared/properties/cmsConnections';
import { RemoteCmsBrowser } from './RemoteCmsBrowser';
import { prefetchConnection } from './remoteCmsCache';
import { ConnectionLogo, type RemoteCmsSelection } from './remoteCmsShared';

const CONTENT_KEY = '\u0000content';

interface CmsPanelProps {
  readonly project: { readonly path: string };
  readonly selectedRel: string | undefined;
  readonly selectedContent: string | undefined;
  readonly currentFile: string | undefined;
  readonly refreshKey: string | number;
  readonly onSelect: (rel: string | undefined) => void;
  readonly onSelectContent: (name: string | undefined) => void;
  /** The connected-CMS document open in the main view, if any. A host with no
   *  connected CMS (Studio, for now) leaves both out. */
  readonly selectedRemote?: RemoteCmsSelection | undefined;
  readonly onSelectRemote?: ((selection: RemoteCmsSelection | undefined) => void) | undefined;
  readonly onOpenSettings: (rel: string) => void;
  /** Where a host without an app Settings window (Studio) adds a connection. */
  readonly onConnect?: (() => void) | undefined;
  readonly showToast: (message: string, kind: 'error') => void;
}

interface CollectionGroup {
  readonly key: string;
  readonly kind: 'file' | 'folder';
  readonly label: string;
  readonly path: string;
  readonly items: readonly Collection[];
  readonly current: boolean;
  readonly badge: 'this page' | 'open' | undefined;
}

interface CmsPanelData {
  readonly state: PanelData<unknown>;
  readonly files: readonly CmsPanelFile[];
  readonly content: CmsPanelContent;
  readonly refresh: () => Promise<void>;
}

const EMPTY_CONTENT: CmsPanelContent = {
  collections: [],
  covered: { files: [], dirs: [] },
};

export default function CmsPanel(props: CmsPanelProps) {
  // A different project must not inherit the previous project's open folder.
  return <ProjectCmsPanel key={props.project.path} {...props} />;
}

function ProjectCmsPanel(props: CmsPanelProps) {
  const connections = useCmsConnections(props.project.path, props.refreshKey);
  const [remote, setRemote] = useState<CmsConnection | undefined>(props.selectedRemote?.connection);
  if (remote) {
    return (
      <RemoteCmsBrowser
        projectPath={props.project.path}
        connection={remote}
        selected={props.selectedRemote}
        onOpen={props.onSelectRemote ?? (() => undefined)}
        onClose={() => setRemote(undefined)}
      />
    );
  }
  // Moving to a connected CMS closes whatever local collection was open beside it.
  const openRemote = (connection: CmsConnection) => {
    props.onSelect(undefined);
    props.onSelectContent(undefined);
    setRemote(connection);
  };
  return <LocalCmsPanel {...props} connections={connections} onOpenRemote={openRemote} />;
}

function LocalCmsPanel(
  props: CmsPanelProps & {
    readonly connections: readonly CmsConnection[];
    readonly onOpenRemote: (connection: CmsConnection) => void;
  },
) {
  const { files, content, refresh, state } = useCmsPanelData(props.project.path, props.refreshKey);
  const [creating, setCreating] = useState(false);
  const [openKey, setOpenKey] = useState<string | undefined>(
    props.selectedContent ? CONTENT_KEY : undefined,
  );
  const collections = useMemo(() => visibleCollections(files, content), [files, content]);
  const groups = useMemo(
    () => collectionGroups(collections, props.currentFile),
    [collections, props.currentFile],
  );
  useSelectedGroup(props.selectedRel, openKey, collections, setOpenKey);
  const open = openKey === undefined ? undefined : groups.find((group) => group.key === openKey);
  const create = useCreateCollection(props, setCreating, setOpenKey, refresh);
  return (
    <div className="panel-section grow">
      <PanelHeader
        open={open}
        openKey={openKey}
        onBack={() => closeGroup(props, setOpenKey)}
        onCreate={() => setCreating(true)}
      />
      <div className="panel-body">
        {creating && <CreateRow onCreate={create} />}
        {!open && openKey !== CONTENT_KEY && (
          <>
            <ConnectionRows
              connections={props.connections}
              onOpen={props.onOpenRemote}
              onConnect={props.onConnect}
            />
            <GroupList
              content={content}
              groups={groups}
              selectedRel={props.selectedRel}
              onOpen={(key) => openGroup(groups, key, { select: props.onSelect, open: setOpenKey })}
            />
          </>
        )}
        {openKey === CONTENT_KEY && (
          <ContentCollectionList
            collections={content.collections}
            selected={props.selectedContent}
            onSelect={props.onSelectContent}
          />
        )}
        {open && (
          <JsonCollectionList
            collections={open.items}
            selected={props.selectedRel}
            onSelect={props.onSelect}
            onOpenSettings={props.onOpenSettings}
          />
        )}
        {/* Collections in other Astro files are hidden, so count only visible groups. */}
        <PanelReadStatus state={state} label="collections" retry={refresh} />
        {state.kind === 'ready' &&
          groups.length === 0 &&
          content.collections.length === 0 &&
          props.connections.length === 0 &&
          !creating && <EmptyPanel onCreate={() => setCreating(true)} />}
      </div>
    </div>
  );
}

const EMPTY_FILES: readonly CmsPanelFile[] = [];
interface CmsCatalog {
  readonly files: readonly CmsPanelFile[];
  readonly content: CmsPanelContent;
}
const cmsCache = createPanelCache<CmsCatalog>();
function useCmsPanelData(projectPath: string, refreshKey: string | number): CmsPanelData {
  const read = useCallback(() => readCmsCatalog(projectPath), [projectPath]);
  const { state, refresh } = usePanelData(cmsCache, projectPath, read, cmsTransport.onCmsChanged);
  // The hook already loads once; only later external refresh keys request another read.
  const previous = useRef(refreshKey);
  useEffect(() => {
    if (previous.current !== refreshKey) {
      previous.current = refreshKey;
      void refresh();
    }
  }, [refresh, refreshKey]);
  return {
    state,
    files: state.kind === 'ready' ? state.value.files : EMPTY_FILES,
    content: state.kind === 'ready' ? state.value.content : EMPTY_CONTENT,
    refresh,
  };
}
async function readCmsCatalog(projectPath: string): Promise<Result<CmsCatalog, string>> {
  const [files, content] = await Promise.all([
    readCmsFiles(projectPath),
    readContentCollections(projectPath),
  ]);
  if (!files.ok) {
    return files;
  }
  if (!content.ok) {
    return content;
  }
  return { ok: true, value: { files: files.value, content: content.value } };
}

function useCreateCollection(
  props: CmsPanelProps,
  setCreating: React.Dispatch<React.SetStateAction<boolean>>,
  setOpenKey: React.Dispatch<React.SetStateAction<string | undefined>>,
  refresh: () => Promise<void>,
): (name: string) => Promise<void> {
  return useCallback(
    async (name: string): Promise<void> => {
      setCreating(false);
      if (name.trim().length === 0) {
        return;
      }
      const result = await createCmsCollection(props.project.path, name);
      if (!result.ok) {
        props.showToast(result.error, 'error');
        return;
      }
      await refresh();
      setOpenKey(groupIdentity(result.value.rel, directoryOf(result.value.rel)).key);
      props.onSelect(result.value.rel);
    },
    [props, refresh, setCreating, setOpenKey],
  );
}

function useSelectedGroup(
  selectedRel: string | undefined,
  openKey: string | undefined,
  collections: readonly Collection[],
  setOpenKey: React.Dispatch<React.SetStateAction<string | undefined>>,
): void {
  useEffect(() => {
    if (selectedRel === undefined || openKey !== undefined) {
      return;
    }
    const selected = collections.find((collection) => collection.rel === selectedRel);
    if (!selected) {
      return;
    }
    const key = groupIdentity(selected.rel, selected.dir).key;
    // A group with this one collection is not opened: its row already opened it.
    const siblings = collections.filter(
      (collection) => groupIdentity(collection.rel, collection.dir).key === key,
    );
    if (siblings.length > 1) {
      setOpenKey(key);
    }
  }, [collections, openKey, selectedRel, setOpenKey]);
}

function visibleCollections(
  files: readonly CmsPanelFile[],
  content: CmsPanelContent,
): readonly Collection[] {
  return files
    .filter((file) => !ownedByContent(file.rel.split('#')[0] ?? '', content.covered))
    .map(collectionOf)
    .filter(collectionHasContent);
}

function ownedByContent(rel: string, covered: CmsPanelContent['covered']): boolean {
  if (covered.files.includes(`src/${rel}`)) {
    return true;
  }
  return covered.dirs.some((directory) => `src/${rel}`.startsWith(`${directory}/`));
}

function collectionGroups(
  collections: readonly Collection[],
  currentFile: string | undefined,
): readonly CollectionGroup[] {
  const mutableGroups = new Map<
    string,
    { readonly identity: GroupIdentity; items: Collection[] }
  >();
  for (const collection of collections) {
    const identity = groupIdentity(collection.rel, collection.dir);
    if (identity.key.toLowerCase().endsWith('.astro') && identity.key !== currentFile) {
      continue;
    }
    const existing = mutableGroups.get(identity.key);
    if (existing) {
      existing.items.push(collection);
    } else {
      mutableGroups.set(identity.key, { identity, items: [collection] });
    }
  }
  return Array.from(mutableGroups.values(), ({ identity, items }) => {
    const current = currentFile !== undefined && identity.key === currentFile;
    const badge: CollectionGroup['badge'] = current
      ? identity.key.startsWith('pages/')
        ? 'this page'
        : 'open'
      : undefined;
    return {
      ...identity,
      items,
      current,
      badge,
    };
  }).sort((left, right) => Number(right.current) - Number(left.current));
}

interface GroupIdentity {
  readonly key: string;
  readonly kind: 'file' | 'folder';
  readonly label: string;
  readonly path: string;
}

function groupIdentity(rel: string, directory: string): GroupIdentity {
  if (rel.includes('#')) {
    const base = directory.split('/').at(-1) ?? directory;
    return {
      key: directory,
      kind: 'file',
      label: base.charAt(0).toUpperCase() + base.slice(1),
      path: `src/${directory}`,
    };
  }
  return {
    key: directory,
    kind: 'folder',
    label: directory ? (directory.split('/').at(-1) ?? directory) : 'src',
    path: directory ? `src/${directory}` : 'src',
  };
}

function directoryOf(rel: string): string {
  return rel.split('/').slice(0, -1).join('/');
}

// A file or folder with one collection has nothing to choose between: its row
// opens that collection, and the panel stays on the list of groups.
function openGroup(
  groups: readonly CollectionGroup[],
  key: string,
  to: {
    readonly select: (rel: string | undefined) => void;
    readonly open: (key: string) => void;
  },
): void {
  const group = groups.find((entry) => entry.key === key);
  const only = group?.items.length === 1 ? group.items[0] : undefined;
  if (only) {
    to.select(only.rel);
  } else {
    to.open(key);
  }
}

function closeGroup(
  props: Pick<CmsPanelProps, 'onSelect' | 'onSelectContent'>,
  setOpenKey: React.Dispatch<React.SetStateAction<string | undefined>>,
): void {
  setOpenKey(undefined);
  props.onSelect(undefined);
  props.onSelectContent(undefined);
}

// The project's connected CMSs (Settings → CMS connections), read with the panel.
// A failure leaves them out rather than hiding the project's own collections.
// The last list read shows at once on the next open, and each Sanity connection's
// collections and their items are read ahead, so opening one shows them at once.
const KEPT_CONNECTIONS = createPanelCache<readonly CmsConnection[]>();

function useCmsConnections(projectPath: string, refreshKey: string | number) {
  const [connections, setConnections] = useState<readonly CmsConnection[]>(() => {
    const kept = KEPT_CONNECTIONS.get(projectPath);
    return kept?.kind === 'ready' ? kept.value : [];
  });
  useEffect(() => {
    let active = true;
    // Read ahead now, and again when the network returns after being offline.
    let sanity: readonly CmsConnection[] = [];
    const readAhead = () => {
      for (const connection of sanity) {
        prefetchConnection(projectPath, connection.id);
      }
    };
    window.addEventListener('online', readAhead);
    listCmsConnections(projectPath).then(
      (list) => {
        KEPT_CONNECTIONS.set(projectPath, list.connections);
        sanity = list.connections.filter((connection) => connection.kind === 'sanity');
        readAhead();
        if (active) {
          setConnections(list.connections);
        }
      },
      () => active && setConnections([]),
    );
    return () => {
      active = false;
      window.removeEventListener('online', readAhead);
    };
  }, [projectPath, refreshKey]);
  return connections;
}

function ConnectionRows(props: {
  readonly connections: readonly CmsConnection[];
  readonly onOpen: (connection: CmsConnection) => void;
  readonly onConnect: (() => void) | undefined;
}) {
  return (
    <>
      {props.connections.map((connection) => (
        <GroupRow
          key={connection.id}
          label={connection.label}
          count={CONNECTION_KINDS[connection.kind]}
          onClick={() => props.onOpen(connection)}
          icon={<ConnectionLogo kind={connection.kind} />}
        />
      ))}
      {props.onConnect && (
        <GroupRow
          label="Connect a CMS"
          count=""
          onClick={props.onConnect}
          icon={<CmsIcon size={14} />}
        />
      )}
    </>
  );
}

const CONNECTION_KINDS: Readonly<Record<CmsConnection['kind'], string>> = {
  sanity: 'Sanity',
  payload: 'Payload',
  custom: 'Custom CMS',
};

function PanelHeader({
  open,
  openKey,
  onBack,
  onCreate,
}: {
  readonly open: CollectionGroup | undefined;
  readonly openKey: string | undefined;
  readonly onBack: () => void;
  readonly onCreate: () => void;
}) {
  const title =
    openKey === CONTENT_KEY ? 'Content collections' : (open?.label ?? 'CMS Collections');
  return (
    <div className="panel-header">
      <div className="cms-crumb">
        {(open || openKey === CONTENT_KEY) && (
          <button className="ghost" title="All collections" onClick={onBack}>
            <ChevronLeftIcon size={14} />
          </button>
        )}
        <h2 title={open?.path}>{title}</h2>
      </div>
      <button className="ghost" title="New collection" onClick={onCreate}>
        <PlusIcon size={14} />
      </button>
    </div>
  );
}

function CreateRow({ onCreate }: { readonly onCreate: (name: string) => Promise<void> }) {
  return (
    <div className="cms-collection">
      <CmsIcon size={14} />
      <input
        autoFocus
        placeholder="Collection name"
        onBlur={(event) => void onCreate(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setInputText(event.currentTarget, '');
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

// An uncontrolled input's text is the element's own state, set in place.
function setInputText(inputElement: HTMLInputElement, text: string): void {
  inputElement.value = text;
}

function GroupList({
  content,
  groups,
  selectedRel,
  onOpen,
}: {
  readonly content: CmsPanelContent;
  readonly groups: readonly CollectionGroup[];
  readonly selectedRel: string | undefined;
  readonly onOpen: (key: string) => void;
}) {
  return (
    <>
      {content.collections.length > 0 && (
        <GroupRow
          label="Content collections"
          count={collectionCount(content.collections.length)}
          title={content.configPath ? `Declared in ${content.configPath}` : undefined}
          onClick={() => onOpen(CONTENT_KEY)}
          icon={<CollectionIcon size={14} />}
        />
      )}
      {groups.map((group) => (
        <GroupRow
          key={group.key}
          label={group.label}
          count={collectionCount(group.items.length)}
          title={group.path}
          badge={group.badge}
          selected={group.items.some((item) => item.rel === selectedRel)}
          onClick={() => onOpen(group.key)}
          icon={group.kind === 'file' ? <FileIcon size={14} /> : <FolderDefaultIcon size={14} />}
        />
      ))}
    </>
  );
}

function GroupRow({
  label,
  count: countLabel,
  title,
  badge,
  selected,
  onClick,
  icon,
}: {
  readonly label: string;
  readonly count: string;
  readonly title?: string | undefined;
  readonly badge?: CollectionGroup['badge'];
  /** Its collection is the one open: the row reads as the current place. */
  readonly selected?: boolean | undefined;
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
}) {
  return (
    <div className={`cms-collection ${selected ? 'on' : ''}`} onClick={onClick} title={title}>
      {icon}
      <span className="cms-collection-name">{label}</span>
      {badge && <span className="badge">{badge}</span>}
      <span className="cms-collection-count">{countLabel}</span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  );
}

function ContentCollectionList({
  collections,
  selected,
  onSelect,
}: {
  readonly collections: readonly CmsPanelContentCollection[];
  readonly selected: string | undefined;
  readonly onSelect: (name: string | undefined) => void;
}) {
  return collections.map((collection) => (
    <div
      key={collection.name}
      className={collectionClass({
        selected: collection.name === selected,
        broken: collection.error !== undefined,
      })}
      onClick={() => onSelect(collection.name)}
      title={contentCollectionTitle(collection)}
    >
      {collection.editable ? <CmsIcon size={14} /> : <HideIcon size={14} />}
      <span className="cms-collection-name">{labelize(collection.name)}</span>
      <span className="cms-collection-count">{contentEntryCount(collection)}</span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  ));
}

function JsonCollectionList({
  collections,
  selected,
  onSelect,
  onOpenSettings,
}: {
  readonly collections: readonly Collection[];
  readonly selected: string | undefined;
  readonly onSelect: (rel: string | undefined) => void;
  readonly onOpenSettings: (rel: string) => void;
}) {
  return collections.map((collection) => (
    <div
      key={collection.rel}
      className={collectionClass({
        selected: collection.rel === selected,
        broken: collection.error !== undefined,
      })}
      onClick={() => onSelect(collection.rel)}
      title={`src/${collection.rel}`}
    >
      <CmsIcon size={14} />
      <span className="cms-collection-name">{collection.label}</span>
      <span className="cms-collection-count">{jsonItemCount(collection)}</span>
      <button
        className="ghost row-action"
        title="Collection settings"
        onClick={(event) => {
          event.stopPropagation();
          if (collection.error === undefined) {
            onOpenSettings(collection.rel);
          }
        }}
        disabled={collection.error !== undefined}
      >
        <GearIcon size={13} />
      </button>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  ));
}

function EmptyPanel({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="props-empty">
      <div className="cms-empty-icon" aria-hidden="true">
        <CmsIcon size={24} />
      </div>
      <h3 className="cms-empty-title">No collections to show.</h3>
      <p>Create a collection to manage reusable content.</p>
      <div className="cms-empty-action">
        <button className="primary" onClick={onCreate}>
          New collection
        </button>
      </div>
    </div>
  );
}

function collectionClass(state: { readonly selected: boolean; readonly broken: boolean }): string {
  return `cms-collection ${state.selected ? 'on' : ''} ${state.broken ? 'broken' : ''}`;
}

function collectionCount(countValue: number): string {
  return countValue === 1 ? '1 collection' : `${countValue} collections`;
}

function contentEntryCount(collection: CmsPanelContentCollection): string {
  if (collection.error !== undefined) {
    return 'unreadable';
  }
  return collection.count === 1 ? '1 entry' : `${collection.count} entries`;
}

function jsonItemCount(collection: Collection): string {
  if (collection.error !== undefined) {
    return 'unreadable';
  }
  return collection.single || collection.items.length === 1
    ? '1 item'
    : `${collection.items.length} items`;
}

function contentCollectionTitle(collection: CmsPanelContentCollection): string {
  if (!collection.editable) {
    return 'Built by a loader in this project: read-only';
  }
  const source =
    collection.loader?.kind === 'file' ? collection.loader.file : collection.loader?.base;
  return `${source ?? 'Unknown source'} — ${collection.loader?.kind ?? 'unknown'} loader`;
}
