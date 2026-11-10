// One connected media host in the Assets panel: its folders as the project's
// folders are shown, its files as tiles that preview images, video and audio
// from their public URLs (any other file is a tile with its extension), and
// the same gestures — upload by button or by dropping files, new folder,
// rename on double-click, delete, and dragging a file to reorder its folder.
// While a field asks for an asset, a click picks the file's public URL.
// Every call goes through the main process, which holds the keys
// (src/ipc/mediaHostingBridge.ts).
import React, { useCallback, useEffect, useState } from 'react';
import type { AssetRequest } from '../../ui/assetPick';
import type { MediaConnection, MediaFile, MediaListing, MediaResult } from '../../../shared/properties/mediaHosting';
import {
  createHostedFolder,
  deleteHostedMedia,
  listHostedMedia,
  pickUploadHostedMedia,
  renameHostedMedia,
  reorderHostedMedia,
  replaceHostedMedia,
  uploadHostedMedia,
  type HostedFolder,
} from '../../ipc/mediaHostingBridge';
import {
  AudioFileIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  RefreshIcon,
  TrashIcon,
  UploadCloudIcon,
  UploadIcon,
} from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import { FONT_PREVIEW_EXTENSIONS, useFontPreview } from '../../ui/fontPreview';
import Popup from '../../ui/Popup';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { pickPrompt } from './assetPaths';
import type { SourceNavigation } from './AssetSources';
import { formatBytes, hostedCrumbs, hostedKindMatches, movedOrder } from './hostedMediaModel';
import { copyLink, openLink } from './assetLinks';
import './hostedMedia.css';

export type HostedToast = (message: string, kind: 'error' | 'success') => void;

type ListingState =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly listing: MediaListing };

type Renaming = { readonly entry: 'file' | 'folder'; readonly name: string };

const HOSTED_DRAG = 'avb/hosted-media';
// Files one drop may upload; the main process holds the same bound per request.
const DROP_FILES_MAX = 100;

interface BrowserProps {
  readonly projectPath: string;
  readonly connection: MediaConnection;
  /** The source switcher that is the panel's heading. */
  readonly navigation: SourceNavigation;
  readonly onEdit: () => void;
  readonly pick: AssetRequest | undefined;
  readonly onPickCancel: (() => void) | undefined;
  readonly showToast: HostedToast;
  readonly onRemove: () => void;
}

export function HostedMediaBrowser(props: BrowserProps) {
  const browser = useHostedBrowser(props);
  const { state } = browser;
  const files =
    state.kind === 'ready' ? state.listing.files.filter((file) => props.pick === undefined || hostedKindMatches(props.pick.mediaKind, file.kind)) : [];
  return (
    <div className="panel-section grow" role="region" aria-label="Assets">
      <HostedHeader {...props} browser={browser} />
      {props.pick && (
        <div className="asset-picking">
          <span>{pickPrompt(props.pick.mediaKind)}</span>
          <button className="ghost" onClick={props.onPickCancel}>
            Cancel
          </button>
        </div>
      )}
      <HostedCrumbs folder={browser.folder} onOpen={browser.setFolder} />
      <div
        className={`panel-body asset-body ${browser.dropping ? 'drop' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            browser.setDropping(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget) {
            browser.setDropping(false);
          }
        }}
        onDrop={(event) => {
          browser.setDropping(false);
          if (event.dataTransfer.files.length > 0) {
            event.preventDefault();
            browser.uploadDropped([...event.dataTransfer.files]);
          }
        }}
      >
        <HostedContents {...props} browser={browser} files={files} />
      </div>
      {browser.preview && <HostedPreview file={browser.preview} onClose={() => browser.setPreview(undefined)} />}
    </div>
  );
}

type Browser = ReturnType<typeof useHostedBrowser>;

function useHostedBrowser(props: BrowserProps) {
  const { projectPath, connection, showToast } = props;
  const [folder, setFolder] = useState('');
  const [state, setState] = useState<ListingState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<Renaming | undefined>(undefined);
  const [newFolder, setNewFolder] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [preview, setPreview] = useState<MediaFile | undefined>(undefined);
  const target: HostedFolder = { projectPath, connectionId: connection.id, folder };
  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const result = await listHostedMedia({ projectPath, connectionId: connection.id, folder });
    setState(result.ok ? { kind: 'ready', listing: result.value } : { kind: 'error', message: result.message });
  }, [projectPath, connection.id, folder]);
  useEffect(() => {
    void load();
  }, [load]);
  // Every change answers with the folder's new listing; a failure keeps the old one and says why.
  const run = async (done: string | undefined, action: () => Promise<MediaResult<MediaListing | undefined>>): Promise<void> => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      showToast(result.message, 'error');
      return;
    }
    if (result.value !== undefined) {
      setState({ kind: 'ready', listing: result.value });
      if (done !== undefined) {
        showToast(done, 'success');
      }
    }
  };
  const names = state.kind === 'ready' ? state.listing.files.map((file) => file.name) : [];
  return {
    folder,
    setFolder: (next: string) => {
      setRenaming(undefined);
      setNewFolder(false);
      setFolder(next);
    },
    state,
    busy,
    renaming,
    setRenaming,
    newFolder,
    setNewFolder,
    dropping,
    setDropping,
    preview,
    setPreview,
    refresh: () => void load(),
    upload: () => void run(undefined, () => pickUploadHostedMedia(target)),
    uploadDropped: (dropped: readonly File[]) => {
      if (dropped.length > DROP_FILES_MAX) {
        showToast(`Drop at most ${DROP_FILES_MAX} files at once.`, 'error');
        return;
      }
      void run(undefined, () => uploadHostedMedia(target, dropped));
    },
    createFolder: (name: string) => void run(undefined, () => createHostedFolder(target, name)),
    rename: (entry: Renaming, to: string) => {
      setRenaming(undefined);
      const clean = to.trim();
      if (clean !== '' && clean !== entry.name) {
        void run(undefined, () => renameHostedMedia(target, { entry: entry.entry, from: entry.name, to: clean }));
      }
    },
    remove: (entry: Renaming) => void removeEntry(entry, (confirmed) => run(undefined, () => deleteHostedMedia(target, confirmed))),
    replace: (file: MediaFile) => void run(`Replaced ${file.name}.`, () => replaceHostedMedia(target, file.name)),
    move: (moved: string, before: string | undefined) => {
      const order = movedOrder(names, { moved, before });
      if (order !== names) {
        void run(undefined, () => reorderHostedMedia(target, order));
      }
    },
  };
}

async function removeEntry(entry: Renaming, remove: (entry: Renaming) => Promise<void>): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Delete ${entry.name}?`,
    body:
      entry.entry === 'folder'
        ? 'The folder and everything in it are deleted from the host. Hosts keep no bin, so this cannot be undone.'
        : 'The file is deleted from the host, and anything linking to it stops finding it. Hosts keep no bin, so this cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (confirmed) {
    await remove(entry);
  }
}

function HostedHeader(props: BrowserProps & { readonly browser: Browser }) {
  const { browser } = props;
  return (
    <div className="panel-header">
      {props.navigation.picker}
      <div style={{ display: 'flex', gap: 2 }}>
        <button className="ghost" title="New folder" aria-label="New folder" disabled={browser.busy} onClick={() => browser.setNewFolder(true)}>
          <FolderPlusIcon size={14} />
        </button>
        <button className="ghost" title="Upload media" aria-label="Upload media" disabled={browser.busy} onClick={browser.upload}>
          <UploadCloudIcon size={14} />
        </button>
        <MoreMenu
          title={`Options for ${props.connection.label}`}
          width={170}
          items={[
            { label: 'Refresh', icon: <RefreshIcon size={13} />, onSelect: browser.refresh },
            { label: 'Edit connection…', icon: <PencilIcon size={13} />, onSelect: props.onEdit },
            { label: 'Remove connection', icon: <TrashIcon size={13} />, danger: true, onSelect: props.onRemove },
          ]}
        />
      </div>
    </div>
  );
}

function HostedCrumbs({ folder, onOpen }: { readonly folder: string; readonly onOpen: (folder: string) => void }) {
  // The trail starts at "Assets", the bucket or zone's top: Assets › images, or just Assets there.
  const crumbs = hostedCrumbs('Assets', folder);
  return (
    <div className="asset-crumbs">
      {crumbs.map((crumb, index) => (
        <React.Fragment key={crumb.folder}>
          {index > 0 && (
            <span className="crumb-sep">
              <ChevronRightIcon size={9} />
            </span>
          )}
          <span className={`crumb ${index === crumbs.length - 1 ? 'last' : ''}`} onClick={() => onOpen(crumb.folder)}>
            {crumb.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function HostedContents(props: BrowserProps & { readonly browser: Browser; readonly files: readonly MediaFile[] }) {
  const { browser, files } = props;
  const { state } = browser;
  if (state.kind === 'loading') {
    return <div className="props-empty">Loading…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty">
        {state.message}
        <div style={{ marginTop: 10 }}>
          <button onClick={browser.refresh}>Try again</button>
        </div>
      </div>
    );
  }
  const { folders } = state.listing;
  return (
    <>
      {browser.newFolder && <NewHostedFolder browser={browser} />}
      {folders.map((folder) => (
        <HostedFolderRow key={folder.path} name={folder.name} browser={browser} onOpen={() => browser.setFolder(folder.path)} />
      ))}
      <div
        className="asset-grid"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(HOSTED_DRAG)) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          const moved = event.dataTransfer.getData(HOSTED_DRAG);
          if (moved !== '' && event.target === event.currentTarget) {
            event.preventDefault();
            browser.move(moved, undefined);
          }
        }}
      >
        {files.map((file) => (
          <HostedTile key={file.key} file={file} props={props} browser={browser} />
        ))}
      </div>
      {state.listing.truncated && <div className="props-empty">This folder holds more files than the panel lists.</div>}
      {folders.length === 0 && files.length === 0 && !browser.newFolder && (
        <div className="props-empty">Empty folder. Drop files here or use the upload button.</div>
      )}
    </>
  );
}

function NewHostedFolder({ browser }: { readonly browser: Browser }) {
  return (
    <div className="asset-folder">
      <FolderIcon size={14} />
      <input
        autoFocus
        placeholder="Folder name"
        onBlur={(event) => {
          browser.setNewFolder(false);
          const name = event.currentTarget.value.trim();
          if (name) {
            browser.createFolder(name);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            clearInput(event.currentTarget);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function HostedFolderRow({ name, browser, onOpen }: { readonly name: string; readonly browser: Browser; readonly onOpen: () => void }) {
  const entry: Renaming = { entry: 'folder', name };
  const renaming = browser.renaming?.entry === 'folder' && browser.renaming.name === name;
  return (
    <div className="asset-folder hosted-folder" onClick={renaming ? undefined : onOpen} onDoubleClick={() => browser.setRenaming(entry)}>
      <FolderIcon size={14} />
      {renaming ? <NameInput name={name} onCommit={(value) => browser.rename(entry, value)} /> : <span className="asset-folder-name">{name}</span>}
      <MoreMenu
        className="hosted-row-menu"
        title={`Options for ${name}`}
        items={[
          { label: 'Rename', icon: <PencilIcon size={13} />, onSelect: () => browser.setRenaming(entry) },
          { label: 'Delete', icon: <TrashIcon size={13} />, danger: true, onSelect: () => browser.remove(entry) },
        ]}
      />
      <span className="crumb-sep">
        <ChevronRightIcon size={9} />
      </span>
    </div>
  );
}

function HostedTile({ file, props, browser }: { readonly file: MediaFile; readonly props: BrowserProps; readonly browser: Browser }) {
  const entry: Renaming = { entry: 'file', name: file.name };
  const renaming = browser.renaming?.entry === 'file' && browser.renaming.name === file.name;
  const { pick } = props;
  const [over, setOver] = useState(false);
  return (
    <div
      className={`asset-tile hosted-tile ${pick ? 'pickable' : ''} ${pick?.current === file.url ? 'selected' : ''} ${over ? 'drop-before' : ''}`}
      draggable={!renaming && pick === undefined}
      title={pick ? `Use ${file.name}` : `${file.name}${file.sizeBytes === undefined ? '' : ` · ${formatBytes(file.sizeBytes)}`}`}
      onDragStart={(event) => event.dataTransfer.setData(HOSTED_DRAG, file.name)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(HOSTED_DRAG)) {
          event.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const moved = event.dataTransfer.getData(HOSTED_DRAG);
        if (moved !== '') {
          event.preventDefault();
          event.stopPropagation();
          browser.move(moved, file.name);
        }
      }}
      onClick={() => (pick?.onPickURL ? pick.onPickURL(file.url) : browser.setPreview(file))}
    >
      <HostedThumb file={file} />
      {renaming ? (
        <NameInput name={file.name} onCommit={(value) => browser.rename(entry, value)} />
      ) : (
        <div className="asset-name" onDoubleClick={() => browser.setRenaming(entry)}>
          {file.name}
        </div>
      )}
      {!pick && (
        <MoreMenu
          className="asset-tile-menu"
          title={`Options for ${file.name}`}
          items={[
            { label: 'Copy link', icon: <CopyIcon size={13} />, onSelect: () => void copyLink(file.url, props.showToast) },
            { label: 'Open link', icon: <ExternalIcon size={13} />, onSelect: () => void openLink(file.url) },
            { label: 'Replace…', icon: <UploadIcon size={13} />, onSelect: () => browser.replace(file) },
            { label: 'Rename', icon: <PencilIcon size={13} />, onSelect: () => browser.setRenaming(entry) },
            { label: 'Delete', icon: <TrashIcon size={13} />, danger: true, onSelect: () => browser.remove(entry) },
          ]}
        />
      )}
    </div>
  );
}

/** A hosted file's tile: the picture, a video's first frame, or a glyph and its extension. */
export function HostedThumb({ file }: { readonly file: MediaFile }) {
  const [failed, setFailed] = useState(false);
  // A font draws "Aa" in itself from its public URL; the host must allow the
  // editor's origin (CORS) for that, and a refusal shows the file tile instead.
  const isFont = file.kind === 'file' && FONT_PREVIEW_EXTENSIONS.test(file.name);
  const fontSources = React.useMemo(() => [file.url], [file.url]);
  const fontFamily = useFontPreview(isFont ? file.url : undefined, fontSources);
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toUpperCase() : '';
  if (!failed && file.kind === 'image') {
    return (
      <div className="asset-thumb">
        <img src={file.url} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      </div>
    );
  }
  if (!failed && file.kind === 'video') {
    return (
      <div className="asset-thumb">
        {/* Never autoplays: metadata and one frame, the fragment seeks to. */}
        <video src={`${file.url}#t=0.1`} muted playsInline preload="metadata" draggable={false} onError={() => setFailed(true)} />
        <span className="asset-badge">▶</span>
      </div>
    );
  }
  if (fontFamily !== undefined) {
    return (
      <div className="asset-thumb is-font">
        <span className="asset-font" style={{ fontFamily: `"${fontFamily}"` }}>
          Aa
        </span>
      </div>
    );
  }
  return (
    <div className="asset-thumb">
      <div className="asset-ext">
        {file.kind === 'audio' ? <AudioFileIcon size={22} /> : <FileIcon size={22} />}
        {extension.slice(0, 6)}
      </div>
    </div>
  );
}

function HostedPreview({ file, onClose }: { readonly file: MediaFile; readonly onClose: () => void }) {
  return (
    <Popup className="modal hosted-preview" label={file.name} onClose={onClose} dismissible>
      {() => (
        <>
          <div className="modal-header">{file.name}</div>
          <div className="modal-body hosted-preview-body">
            <PreviewMedia file={file} />
            <div className="hosted-preview-meta">
              {[formatBytes(file.sizeBytes), file.modified === undefined ? '' : new Date(file.modified).toLocaleString()].filter(Boolean).join(' · ')}
            </div>
          </div>
        </>
      )}
    </Popup>
  );
}

function PreviewMedia({ file }: { readonly file: MediaFile }) {
  switch (file.kind) {
    case 'image':
      return <img className="hosted-preview-media" src={file.url} alt={file.name} />;
    case 'video':
      return <video className="hosted-preview-media" src={file.url} controls playsInline preload="metadata" />;
    case 'audio':
      return <audio className="hosted-preview-audio" src={file.url} controls preload="metadata" />;
    case 'file':
      return (
        <div className="hosted-preview-file">
          <FileIcon size={32} />
        </div>
      );
    default: {
      const exhaustive: never = file.kind;
      return exhaustive;
    }
  }
}

function NameInput({ name, onCommit }: { readonly name: string; readonly onCommit: (value: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <input
      autoFocus
      value={value}
      spellCheck={false}
      onFocus={(event) => {
        const dot = name.lastIndexOf('.');
        event.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
      }}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setValue(name);
          onCommit(name);
        }
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

// An uncontrolled input's text is the element's own state, cleared in place.
function clearInput(inputElement: HTMLInputElement): void {
  inputElement.value = '';
}
