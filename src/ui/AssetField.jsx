import React, { useEffect, useMemo, useState } from 'react';
import { ElementImageIcon } from './Icons.jsx';
import AssetThumb from './AssetThumb.jsx';
import { requestAsset } from '../assetPick.js';
import { assetRelCandidates, assetValueFor, isExternalAsset } from '../assetPath.js';

const kindLabel = { image: 'Image', video: 'Video', audio: 'Audio', asset: 'Asset' };

const fmtSize = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

// "https://cdn.site.com/a/hero.png?w=8" → "hero.png" / "cdn.site.com", so a
// hosted image reads like the file it is rather than as a wall of URL.
const remoteName = (url) => {
  const path = String(url).split(/[?#]/)[0];
  return path.split('/').filter(Boolean).pop() || path;
};
const remoteHost = (url) => {
  if (/^data:/i.test(url)) return 'data URI';
  try {
    return new URL(/^\/\//.test(url) ? `https:${url}` : url).hostname;
  } catch {
    return 'external';
  }
};

// An image the project doesn't hold, shown from wherever it is hosted — the
// card is the same one a local file gets, so pointing a field at a CDN still
// shows what it points at.
function RemoteThumb({ url, onLoad }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed) return <ElementImageIcon size={18} />;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      onLoad={(e) => onLoad?.({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
      onError={() => setFailed(true)}
    />
  );
}

// src/poster editor: shows the chosen asset (thumb, name, dimensions, size)
// with a picker, or a plain URL field for external assets.
// showModeToggle=false hides the Asset/URL switch for hosts that provide
// their own type control (the href link editor), where it would both
// duplicate that control and overlap it — the toggle is positioned to sit
// beside a field label, which those hosts don't have directly above.
export default function AssetField({
  value,
  onChange,
  mediaKind = 'asset',
  projectPath,
  showModeToggle = true,
  // 'asset' | 'url' — overrides the value-sniffing default. Used where the
  // host already decided the value names a project file.
  initialMode,
  // Label for the free-text mode; "URL" reads wrong for data-* attributes.
  plainLabel = 'URL',
  // Called with {w, h} once a NEWLY PICKED image has loaded, so the host can
  // fill in width/height. Only after a pick — firing on every load would
  // rewrite those props just for selecting the node.
  onDimensions,
  // Called with the picked entry when the host wants to decide how the value
  // is written — a public/ asset is a URL, a src/ one is an ESM import. When
  // absent the field falls back to writing the path itself.
  onPickEntry,
  // The project-relative file a src/ import currently resolves to
  // (`src/assets/hero.png`), so the card can show the image behind an
  // `src={hero}` binding rather than the identifier.
  srcRel,
  // The project-relative directory of the file this value lives in
  // ("src/data"). Values there are written relative to it — which is how a
  // data file points at src/assets — so without it a relative path can only
  // be read as public/.
  baseDir,
  // Called with {w, h} whenever the shown image's size is known — not only
  // after a pick. Lets sibling width/height fields show what the source is,
  // which is exactly what they fall back to when left blank.
  onCurrentDimensions,
}) {
  const current = value || '';
  const external = isExternalAsset(current);
  const [mode, setMode] = useState(
    () => initialMode || (showModeToggle && external ? 'url' : 'asset')
  );
  const [entries, setEntries] = useState([]);
  const [dims, setDims] = useState(null);
  const justPicked = React.useRef(false);

  const refresh = React.useCallback(async () => {
    const { entries: list } = await window.avb.listAssets(projectPath);
    setEntries(list || []);
  }, [projectPath]);

  useEffect(() => {
    refresh();
    const off = window.avb.onAssetsChanged(refresh);
    return off;
  }, [refresh]);

  // A value that turns out to be external — the host moved to another item,
  // say — opens in the mode that can edit it. Only in that direction: a local
  // path being typed into the URL field is usually half-written, and pulling
  // the field out from under it would be worse than leaving it there.
  useEffect(() => {
    if (showModeToggle && isExternalAsset(current)) setMode('url');
  }, [current, showModeToggle]);

  // Which project file the value names. A src/ asset reached through an import
  // is never spelled out in the value — the host resolves that one (srcRel).
  const candidates = useMemo(
    () => (srcRel ? [srcRel] : assetRelCandidates(current, baseDir)),
    [srcRel, current, baseDir]
  );
  const byRel = useMemo(() => {
    const map = new Map();
    for (const e of entries) if (!e.isDir) map.set(e.rel, e);
    return map;
  }, [entries]);
  const entry = useMemo(
    () => candidates.map((r) => byRel.get(r)).find(Boolean) || null,
    [candidates, byRel]
  );
  // Where it should have been, for the picker's starting folder and for
  // saying which tree came up empty.
  const target = candidates[0] || null;

  useEffect(() => setDims(null), [current]);

  const label = kindLabel[mediaKind] || 'Asset';

  const noteDims = (d) => {
    setDims(d);
    onCurrentDimensions?.(d);
    if (justPicked.current) {
      justPicked.current = false;
      onDimensions?.(d);
    }
  };

  const toggle = showModeToggle && (
    <div className="af-mode">
      <button
        className={`af-mode-btn ${mode === 'asset' ? 'on' : ''}`}
        title="Choose a file from this project"
        onClick={() => setMode('asset')}
      >
        Asset
      </button>
      <button
        className={`af-mode-btn ${mode === 'url' ? 'on' : ''}`}
        title="Enter a plain value (external URL, expression, anything)"
        onClick={() => setMode('url')}
      >
        {plainLabel}
      </button>
    </div>
  );

  const remoteCard = external && (
    <div className="af-card">
      <div className="af-thumb">
        <RemoteThumb url={current} onLoad={noteDims} />
      </div>
      <div className="af-meta">
        <div className="af-name" title={current}>
          {remoteName(current)}
        </div>
        <div className="af-sub">{remoteHost(current)}</div>
        {dims && (
          <div className="af-sub">
            {dims.w} x {dims.h}px
          </div>
        )}
      </div>
    </div>
  );

  if (mode === 'url') {
    return (
      <div className="asset-field">
        {toggle}
        {remoteCard}
        <input
          value={current}
          placeholder="https://…"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="asset-field">
      {toggle}
      {remoteCard || (
        <div className="af-card">
          <div className="af-thumb">
            {entry ? <AssetThumb file={entry} onImageLoad={noteDims} /> : <ElementImageIcon size={18} />}
          </div>
          <div className="af-meta">
            <div className="af-name" title={srcRel || current}>
              {entry ? entry.name : srcRel || current || 'No asset selected'}
            </div>
            {dims && (
              <div className="af-sub">
                {dims.w} x {dims.h}px
              </div>
            )}
            {entry && <div className="af-sub">{fmtSize(entry.size)}</div>}
            {!entry && (srcRel || current) && (
              <div className="af-sub">
                {target ? `not found in ${target.startsWith('src/') ? 'src/' : 'public/'}` : 'file not found'}
              </div>
            )}
          </div>
        </div>
      )}
      <button
        className="af-choose"
        onClick={() =>
          requestAsset({
            mediaKind,
            current: entry?.rel || target || '',
            onPick: (pickedRel, picked) => {
              justPicked.current = true;
              if (onPickEntry) {
                onPickEntry(picked || { rel: pickedRel, root: pickedRel.split('/')[0] });
                return;
              }
              onChange(assetValueFor(pickedRel, baseDir), true);
            },
          })
        }
      >
        Choose {label}…
      </button>
    </div>
  );
}
