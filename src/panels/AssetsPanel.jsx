import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderIcon,
  FolderPlusIcon,
  UploadCloudIcon,
  ChevronRightIcon,
  FileIcon,
  CodeIcon,
} from '../ui/Icons.jsx';

import AssetThumb, { TEXT_EXT } from '../ui/AssetThumb.jsx';

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|oga)$/i;
const kindMatches = (kind, name) => {
  if (kind === 'image') return IMAGE_EXT.test(name);
  if (kind === 'video') return VIDEO_EXT.test(name);
  if (kind === 'audio') return AUDIO_EXT.test(name);
  return true;
};
const pickPrompt = {
  image: 'Choose an image',
  video: 'Choose a video',
  audio: 'Choose an audio file',
  asset: 'Choose a file',
};

// Assets panel: browses public/, uploads, drag-in/out of folders, renames.
// External changes to public/ refresh the listing via the fs watcher.
// `pick` is set while a field is waiting for an asset (see assetPick.js):
// the panel filters to the kind that was asked for, starts in the folder the
// current value lives in, and a click assigns instead of opening the file.
export default function AssetsPanel({ project, showToast, onOpenFile, pick, onPickCancel, onRecordUndo }) {
  const [entries, setEntries] = useState([]);
  const [missing, setMissing] = useState(false);
  const [cwd, setCwd] = useState('');
  const [renaming, setRenaming] = useState(null); // rel of entry being renamed
  const [newFolder, setNewFolder] = useState(false);
  const [dragTarget, setDragTarget] = useState(null); // folder rel or '' (cwd)
  const cwdRef = useRef('');
  cwdRef.current = cwd;

  const refresh = useCallback(async () => {
    const { entries: list, missing: none } = await window.avb.listAssets(project.path);
    setEntries(list || []);
    setMissing(!!none);
    // If the folder we're in vanished, walk up to the nearest survivor.
    if (cwdRef.current && !(list || []).some((e) => e.isDir && e.rel === cwdRef.current)) {
      setCwd('');
    }
  }, [project.path]);

  useEffect(() => {
    refresh();
    const off = window.avb.onAssetsChanged(refresh);
    return off;
  }, [refresh]);

  // Open a pick in the folder the current value lives in, so replacing an
  // asset doesn't start over at the root. Keyed on the request itself: while
  // one is open the user is free to browse elsewhere.
  const pickKey = pick ? `${pick.mediaKind}:${pick.current || ''}` : null;
  useEffect(() => {
    if (!pick) return;
    setCwd(pick.current?.includes('/') ? parentOf(pick.current) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKey]);

  const folders = entries.filter((e) => e.isDir && e.parent === cwd);
  const files = entries
    .filter((e) => !e.isDir && e.parent === cwd)
    .filter((e) => !pick || kindMatches(pick.mediaKind, e.name));

  const act = async (fn) => {
    try {
      await fn();
    } catch (err) {
      showToast(String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''), 'error');
    }
  };

  // --- Drag handling ---------------------------------------------------

  const dropPayload = (e) => {
    const rel = e.dataTransfer.getData('avb/asset');
    if (rel) return { kind: 'asset', rel };
    if (e.dataTransfer.files?.length) {
      const paths = [...e.dataTransfer.files]
        .map((f) => window.avb.getFilePath(f))
        .filter(Boolean);
      if (paths.length) return { kind: 'os', paths };
    }
    return null;
  };

  const acceptsDrop = (e) =>
    e.dataTransfer.types.includes('avb/asset') || e.dataTransfer.types.includes('Files');

  const dropInto = (destRel) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragTarget(null);
    const payload = dropPayload(e);
    if (!payload) return;
    if (payload.kind === 'asset') {
      if (payload.rel === destRel || parentOf(payload.rel) === destRel) return;
      const fromDir = parentOf(payload.rel);
      const name = payload.rel.slice(payload.rel.lastIndexOf('/') + 1);
      const landedRel = destRel ? `${destRel}/${name}` : name;
      const move = (fromRel, toDirRel) =>
        window.avb.moveAsset({ projectPath: project.path, fromRel, toDirRel });
      act(async () => {
        await move(payload.rel, destRel);
        onRecordUndo?.({
          label: `move ${name}`,
          undo: () => move(landedRel, fromDir),
          redo: () => move(payload.rel, destRel),
        });
      });
    } else {
      act(() =>
        window.avb.uploadAssets({ projectPath: project.path, destRel, filePaths: payload.paths })
      );
    }
  };

  const dragOverInto = (destRel) => (e) => {
    if (acceptsDrop(e)) {
      e.preventDefault();
      e.stopPropagation();
      setDragTarget(destRel);
    }
  };

  // --- Rename ----------------------------------------------------------

  const commitRename = (entry, value) => {
    setRenaming(null);
    const clean = value.trim();
    if (!clean || clean === entry.name) return;
    const dir = parentOf(entry.rel);
    const toRel = dir ? `${dir}/${clean}` : clean;
    const rename = (rel, newName) => window.avb.renameAsset({ projectPath: project.path, rel, newName });
    act(async () => {
      await rename(entry.rel, clean);
      onRecordUndo?.({
        label: `rename to ${clean}`,
        undo: () => rename(toRel, entry.name),
        redo: () => rename(entry.rel, clean),
      });
    });
  };

  // --- Breadcrumb ------------------------------------------------------

  const crumbs = [{ rel: '', label: 'public' }];
  if (cwd) {
    const parts = cwd.split('/');
    parts.forEach((part, i) => {
      crumbs.push({ rel: parts.slice(0, i + 1).join('/'), label: part });
    });
  }

  if (missing) {
    return (
      <div className="panel-section grow">
        <div className="panel-header">
          <h2>Assets</h2>
        </div>
        <div className="props-empty">
          This project has no <code>public/</code> folder yet.
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() =>
                act(() =>
                  window.avb.mkdirAssets({ projectPath: project.path, parentRel: '', name: '' })
                )
              }
              style={{ display: 'none' }}
            />
            <button
              className="primary"
              onClick={() =>
                act(async () => {
                  await window.avb.pickUploadAssets({ projectPath: project.path, destRel: '' });
                })
              }
            >
              Upload an asset
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Assets</h2>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="ghost" title="New folder" onClick={() => setNewFolder(true)}>
            <FolderPlusIcon size={14} />
          </button>
          <button
            className="ghost"
            title="Upload assets"
            onClick={() =>
              act(() => window.avb.pickUploadAssets({ projectPath: project.path, destRel: cwd }))
            }
          >
            <UploadCloudIcon size={14} />
          </button>
        </div>
      </div>

      {pick && (
        <div className="asset-picking">
          <span>{pickPrompt[pick.mediaKind] || pickPrompt.asset}</span>
          <button className="ghost" onClick={onPickCancel}>
            Cancel
          </button>
        </div>
      )}

      <div className="asset-crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.rel}>
            {i > 0 && (
              <span className="crumb-sep">
                <ChevronRightIcon size={9} />
              </span>
            )}
            <span
              className={`crumb ${i === crumbs.length - 1 ? 'last' : ''} ${dragTarget === c.rel && cwd !== c.rel ? 'drop' : ''}`}
              onClick={() => setCwd(c.rel)}
              onDragOver={dragOverInto(c.rel)}
              onDragLeave={() => setDragTarget(null)}
              onDrop={dropInto(c.rel)}
            >
              {c.label}
            </span>
          </React.Fragment>
        ))}
      </div>

      <div
        className={`panel-body asset-body ${dragTarget === cwd ? 'drop' : ''}`}
        onDragOver={dragOverInto(cwd)}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setDragTarget(null);
        }}
        onDrop={dropInto(cwd)}
      >
        {newFolder && (
          <div className="asset-folder">
            <FolderIcon size={14} />
            <input
              autoFocus
              placeholder="Folder name"
              onBlur={(e) => {
                setNewFolder(false);
                const name = e.target.value.trim();
                if (name) {
                  act(() =>
                    window.avb.mkdirAssets({ projectPath: project.path, parentRel: cwd, name })
                  );
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = '';
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}

        {folders.map((folder) => (
          <div
            key={folder.rel}
            className={`asset-folder ${dragTarget === folder.rel ? 'drop' : ''}`}
            draggable={renaming !== folder.rel}
            onDragStart={(e) => {
              e.dataTransfer.setData('avb/asset', folder.rel);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={dragOverInto(folder.rel)}
            onDragLeave={() => setDragTarget(null)}
            onDrop={dropInto(folder.rel)}
            onClick={() => renaming !== folder.rel && setCwd(folder.rel)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(folder.rel);
            }}
          >
            <FolderIcon size={14} />
            {renaming === folder.rel ? (
              <RenameInput entry={folder} onCommit={commitRename} />
            ) : (
              <span className="asset-folder-name">{folder.name}</span>
            )}
            <span className="crumb-sep">
              <ChevronRightIcon size={9} />
            </span>
          </div>
        ))}

        <div className="asset-grid">
          {files.map((file) => {
            const editable = TEXT_EXT.test(file.name);
            return (
            <div
              key={file.rel}
              className={`asset-tile ${pick ? 'pickable' : ''} ${
                pick && pick.current === file.rel ? 'selected' : ''
              }`}
              draggable={renaming !== file.rel}
              onDragStart={(e) => {
                e.dataTransfer.setData('avb/asset', file.rel);
                e.dataTransfer.effectAllowed = 'move';
              }}
              title={
                pick
                  ? `Use /${file.rel}`
                  : editable
                    ? `/${file.rel} — click to edit`
                    : `/${file.rel}`
              }
              // While picking, the whole tile assigns — including for text
              // files, whose thumb would otherwise open the code editor.
              onClick={pick ? () => pick.onPick(file.rel) : undefined}
            >
              <AssetThumb
                file={file}
                className={editable && !pick ? 'editable' : ''}
                onClick={() =>
                  !pick && editable && onOpenFile?.({ rel: file.rel, name: file.name })
                }
              />
              {renaming === file.rel ? (
                <RenameInput entry={file} onCommit={commitRename} />
              ) : (
                <div className="asset-name" onDoubleClick={() => setRenaming(file.rel)}>
                  {file.name}
                </div>
              )}
            </div>
            );
          })}
        </div>

        {folders.length === 0 && files.length === 0 && !newFolder && (
          <div className="props-empty">
            Empty folder. Drop files here or use the upload button.
          </div>
        )}
      </div>
    </div>
  );
}

function RenameInput({ entry, onCommit }) {
  const [value, setValue] = useState(entry.name);
  return (
    <input
      autoFocus
      value={value}
      spellCheck={false}
      onFocus={(e) => {
        // Select the basename, keep the extension.
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
        e.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(entry, value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setValue(entry.name);
          onCommit(entry, entry.name);
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
