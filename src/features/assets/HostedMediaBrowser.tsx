// One connected media host in the Assets panel: its folders as the project's
// folders are shown, its files as tiles that preview images, video and audio
// from their public URLs (any other file is a tile with its extension), and
// the same gestures — upload by button or by dropping files, new folder,
// rename on double-click, delete, and dragging a file to reorder its folder.
// While a field asks for an asset, a click picks the file's public URL.
// Every call goes through the main process, which holds the keys
// (src/ipc/mediaHostingBridge.ts).
import React, { useCallback, useEffect, useState } from 'react';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
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
import type { Translator } from '../../lib/i18n/localeContext';
import type { SourceNavigation } from './AssetSources';
import { hostedCrumbs, hostedKindMatches, movedOrder } from './hostedMediaModel';
import { copyLink, openLink } from './assetLinks';
import './hostedMedia.css';

export type HostedToast = (message: string, kind: 'error' | 'success') => void;

type ListingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly messageRef?: MessageRef | undefined }
  | { readonly kind: 'ready'; readonly listing: MediaListing };

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
  const translate = useTranslate();
  const browser = useHostedBrowser(props);
  const { state } = browser;
  const files =
    state.kind === 'ready' ? state.listing.files.filter((file) => props.pick === undefined || hostedKindMatches(props.pick.mediaKind, file.kind)) : [];
  return (
    <div className="panel-section grow" role="region" aria-label={translate('assets.title')}>
      <HostedHeader {...props} browser={browser} />
      {props.pick && (
        <div className="asset-picking">
          <span>{pickPrompt(props.pick.mediaKind, translate)}</span>
          <button className="ghost" onClick={props.onPickCancel}>
            {translate('ui.cancel')}
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
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
    setState(result.ok ? { kind: 'ready', listing: result.value } : { kind: 'error', message: result.message, messageRef: result.messageRef });
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
      showToast(translateDescribed(result), 'error');
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
        showToast(translate('assets.drop.limit', { count: DROP_FILES_MAX }), 'error');
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
    remove: (entry: Renaming) => void removeEntry(entry, translate, (confirmed) => run(undefined, () => deleteHostedMedia(target, confirmed))),
    replace: (file: MediaFile) => void run(translate('assets.toast.replaced', { name: file.name }), () => replaceHostedMedia(target, file.name)),
    move: (moved: string, before: string | undefined) => {
      const order = movedOrder(names, { moved, before });
      if (order !== names) {
        void run(undefined, () => reorderHostedMedia(target, order));
      }
    },
  };
}

async function removeEntry(entry: Renaming, translate: Translator, remove: (entry: Renaming) => Promise<void>): Promise<void> {
  const confirmed = await confirmDialog({
    title: translate('assets.delete.title', { name: entry.name }),
    body: entry.entry === 'folder' ? translate('assets.hosted.deleteFolderBody') : translate('assets.hosted.deleteFileBody'),
    confirmLabel: translate('assets.delete.action'),
    danger: true,
  });
  if (confirmed) {
    await remove(entry);
  }
}

function HostedHeader(props: BrowserProps & { readonly browser: Browser }) {
  const { browser } = props;
  const translate = useTranslate();
  return (
    <div className="panel-header">
      {props.navigation.picker}
      <div style={{ display: 'flex', gap: 2 }}>
        <button
          className="ghost"
          title={translate('assets.header.newFolder')}
          aria-label={translate('assets.header.newFolder')}
          disabled={browser.busy}
          onClick={() => browser.setNewFolder(true)}
        >
          <FolderPlusIcon size={14} />
        </button>
        <button
          className="ghost"
          title={translate('assets.hosted.upload')}
          aria-label={translate('assets.hosted.upload')}
          disabled={browser.busy}
          onClick={browser.upload}
        >
          <UploadCloudIcon size={14} />
        </button>
        <MoreMenu
          title={translate('assets.tile.options', { name: props.connection.label })}
          width={170}
          items={[
            { label: translate('assets.hosted.refresh'), icon: <RefreshIcon size={13} />, onSelect: browser.refresh },
            { label: translate('assets.hosted.edit'), icon: <PencilIcon size={13} />, onSelect: props.onEdit },
            { label: translate('assets.hosted.remove'), icon: <TrashIcon size={13} />, danger: true, onSelect: props.onRemove },
          ]}
        />
      </div>
    </div>
  );
}

function HostedCrumbs({ folder, onOpen }: { readonly folder: string; readonly onOpen: (folder: string) => void }) {
  const translate = useTranslate();
  // The trail starts at "Assets", the bucket or zone's top: Assets › images, or just Assets there.
  const crumbs = hostedCrumbs(translate('assets.title'), folder);
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  if (state.kind === 'loading') {
    return <div className="props-empty">{translate('assets.hosted.loading')}</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty">
        {translateDescribed(state)}
        <div style={{ marginTop: 10 }}>
          <button onClick={browser.refresh}>{translate('assets.hosted.tryAgain')}</button>
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
      {state.listing.truncated && <div className="props-empty">{translate('assets.hosted.truncated')}</div>}
      {folders.length === 0 && files.length === 0 && !browser.newFolder && <div className="props-empty">{translate('assets.empty')}</div>}
    </>
  );
}

function NewHostedFolder({ browser }: { readonly browser: Browser }) {
  const translate = useTranslate();
  return (
    <div className="asset-folder">
      <FolderIcon size={14} />
      <input
        autoFocus
        placeholder={translate('assets.folderName')}
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
  const translate = useTranslate();
  const entry: Renaming = { entry: 'folder', name };
  const renaming = browser.renaming?.entry === 'folder' && browser.renaming.name === name;
  return (
    <div className="asset-folder hosted-folder" onClick={renaming ? undefined : onOpen} onDoubleClick={() => browser.setRenaming(entry)}>
      <FolderIcon size={14} />
      {renaming ? <NameInput name={name} onCommit={(value) => browser.rename(entry, value)} /> : <span className="asset-folder-name">{name}</span>}
      <MoreMenu
        className="hosted-row-menu"
        title={translate('assets.tile.options', { name })}
        items={[
          { label: translate('assets.hosted.rename'), icon: <PencilIcon size={13} />, onSelect: () => browser.setRenaming(entry) },
          { label: translate('assets.delete.action'), icon: <TrashIcon size={13} />, danger: true, onSelect: () => browser.remove(entry) },
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
  const translate = useTranslate();
  const { formatBytes } = useFormat();
  const [over, setOver] = useState(false);
  return (
    <div
      className={`asset-tile hosted-tile ${pick ? 'pickable' : ''} ${pick?.current === file.url ? 'selected' : ''} ${over ? 'drop-before' : ''}`}
      draggable={!renaming && pick === undefined}
      title={
        pick ? translate('assets.tile.use', { path: file.name }) : `${file.name}${file.sizeBytes === undefined ? '' : ` · ${formatBytes(file.sizeBytes)}`}`
      }
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
          title={translate('assets.tile.options', { name: file.name })}
          items={[
            { label: translate('assets.tile.copyLink'), icon: <CopyIcon size={13} />, onSelect: () => void copyLink(file.url, translate, props.showToast) },
            { label: translate('assets.hosted.openLink'), icon: <ExternalIcon size={13} />, onSelect: () => void openLink(file.url) },
            { label: translate('assets.tile.replace'), icon: <UploadIcon size={13} />, onSelect: () => browser.replace(file) },
            { label: translate('assets.hosted.rename'), icon: <PencilIcon size={13} />, onSelect: () => browser.setRenaming(entry) },
            { label: translate('assets.delete.action'), icon: <TrashIcon size={13} />, danger: true, onSelect: () => browser.remove(entry) },
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
          {/* i18n-ignore: the font specimen draws the font's own glyphs. */}
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
  const { formatBytes, formatDate } = useFormat();
  return (
    <Popup className="modal hosted-preview" label={file.name} onClose={onClose} dismissible>
      {() => (
        <>
          <div className="modal-header">{file.name}</div>
          <div className="modal-body hosted-preview-body">
            <PreviewMedia file={file} />
            <div className="hosted-preview-meta">
              {[file.sizeBytes === undefined ? '' : formatBytes(file.sizeBytes), file.modified === undefined ? '' : modifiedText(file.modified, formatDate)]
                .filter(Boolean)
                .join(' · ')}
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

// A host's modified time is an ISO string; one it cannot read shows nothing rather than "Invalid Date".
function modifiedText(iso: string, formatDate: (value: Date | number, options: Intl.DateTimeFormatOptions) => string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : formatDate(time, { dateStyle: 'medium', timeStyle: 'short' });
}
