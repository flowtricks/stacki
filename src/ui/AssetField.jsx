import React, { useEffect, useMemo, useState } from 'react';
import { ElementImageIcon } from './Icons.jsx';
import AssetThumb from './AssetThumb.jsx';
import { requestAsset } from '../assetPick.js';

const kindLabel = { image: 'Image', video: 'Video', audio: 'Audio', asset: 'Asset' };

const fmtSize = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const isExternal = (v) => /^(https?:)?\/\//.test(v) || v.startsWith('data:');

// src/poster editor: shows the chosen public/ asset (thumb, name, dimensions,
// size) with a picker, or a plain URL field for external assets.
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
  // absent the field falls back to writing a URL itself.
  onPickEntry,
  // The project-relative file a src/ import currently resolves to
  // (`src/assets/hero.png`), so the card can show the image behind an
  // `src={hero}` binding rather than the identifier.
  srcRel,
  // Called with {w, h} whenever the shown image's size is known — not only
  // after a pick. Lets sibling width/height fields show what the source is,
  // which is exactly what they fall back to when left blank.
  onCurrentDimensions,
}) {
  const current = value || '';
  const [mode, setMode] = useState(
    () => initialMode || (showModeToggle && current && isExternal(current) ? 'url' : 'asset')
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

  // A URL value names a file under public/, so that's the rooted rel it maps
  // to. A src/ asset is never a URL — it arrives as an import expression, and
  // the host resolves which file that is (see srcEntry).
  const rel = srcRel || current.replace(/^\//, '');
  const entry = useMemo(
    () =>
      entries.find((e) => !e.isDir && e.rel === (srcRel || `public/${rel}`)) || null,
    [entries, rel, srcRel]
  );

  useEffect(() => setDims(null), [current]);

  const label = kindLabel[mediaKind] || 'Asset';

  const toggle = showModeToggle && (
    <div className="af-mode">
      <button
        className={`af-mode-btn ${mode === 'asset' ? 'on' : ''}`}
        title={`Choose from public/`}
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

  if (mode === 'url') {
    return (
      <div className="asset-field">
        {toggle}
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
      <div className="af-card">
        <div className="af-thumb">
          {entry ? (
            <AssetThumb
              file={entry}
              onImageLoad={(d) => {
                setDims(d);
                onCurrentDimensions?.(d);
                if (justPicked.current) {
                  justPicked.current = false;
                  onDimensions?.(d);
                }
              }}
            />
          ) : (
            <ElementImageIcon size={18} />
          )}
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
            <div className="af-sub">not found in {srcRel ? 'src/' : 'public/'}</div>
          )}
        </div>
      </div>
      <button
        className="af-choose"
        onClick={() =>
          requestAsset({
            mediaKind,
            current: rel,
            onPick: (pickedRel, picked) => {
              justPicked.current = true;
              if (onPickEntry) {
                onPickEntry(picked || { rel: pickedRel, root: pickedRel.split('/')[0] });
                return;
              }
              onChange('/' + pickedRel.replace(/^public\//, ''), true);
            },
          })
        }
      >
        Choose {label}…
      </button>
    </div>
  );
}
