import React, { useEffect, useMemo, useState } from 'react';
import { ElementImageIcon } from './Icons';
import { listAssetEntries, onAssetEntriesChanged } from '../ipc/assetBridge';
import type { WireAssetEntry } from '../../shared/ipc/ipcResults';
import type { AssetRequest } from './assetPick';
import type { AssetDimensions } from './AssetThumb';
import AssetThumb from './AssetThumb';
import { requestAsset } from './assetPick';
import { assetRelCandidates, assetValueFor, isExternalAsset } from './assetPath';
import { classifyRemoteMedia, remotePosterSource, type RemoteMediaHint } from './remoteMedia';

const kindLabel = { image: 'Image', video: 'Video', audio: 'Audio', asset: 'Asset' };
// Refreshes one read may chain while watcher events keep arriving. Each is a
// real read, so a burst that outlasts this many is a watcher loop, not a user.
const ASSET_REFRESH_CHAIN_MAX = 256;

const fmtSize = (bytes: number | undefined) => {
  if (bytes === undefined) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

// "https://cdn.site.com/a/hero.png?w=8" → "hero.png" / "cdn.site.com", so a
// hosted image reads like the file it is rather than as a wall of URL.
const remoteName = (url: string) => {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.split('/').filter(Boolean).pop() || path;
};
const remoteHost = (url: string) => {
  if (/^data:/i.test(url)) {
    return 'data URI';
  }
  try {
    return new URL(/^\/\//.test(url) ? `https:${url}` : url).hostname;
  } catch {
    return 'external';
  }
};

// Media the project doesn't hold, shown from wherever it is hosted — the card
// is the same one a local file gets, so pointing a field at a CDN still shows
// what it points at. classifyRemoteMedia decides what may load: an image as
// an <img>, a video as a paused, muted <video> that fetches only its metadata
// and one frame (or shows its poster), and anything else nothing at all. A
// failed load drops back to the generic icon rather than a broken glyph.
export function RemoteThumb({
  url,
  hint,
  poster,
  onLoad,
}: {
  readonly url: string;
  readonly hint: RemoteMediaHint;
  readonly poster?: string | undefined;
  readonly onLoad?: ((dimensions: AssetDimensions) => void) | undefined;
}) {
  const media = useMemo(() => classifyRemoteMedia(url, hint), [url, hint]);
  const posterSource = useMemo(() => remotePosterSource(poster), [poster]);
  const [failedSource, setFailedSource] = useState<string | undefined>(undefined);
  if (media.kind === 'unknown') {
    return <ElementImageIcon size={18} />;
  }
  if (failedSource === media.source) {
    return <ElementImageIcon size={18} />;
  }
  if (media.kind === 'image') {
    return (
      <img
        key={media.source}
        src={media.source}
        alt=""
        draggable={false}
        onLoad={(event) => onLoad?.({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
        onError={() => setFailedSource(media.source)}
      />
    );
  }
  return (
    <video
      key={media.source}
      src={media.source}
      {...(posterSource === undefined ? {} : { poster: posterSource })}
      // Never autoplays and never loops: the card is a still. "metadata" keeps
      // the download to the headers and the frame the #t fragment seeks to.
      muted
      playsInline
      preload="metadata"
      autoPlay={false}
      draggable={false}
      onLoadedMetadata={(event) => onLoad?.({ w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight })}
      onError={() => setFailedSource(media.source)}
    />
  );
}

// src/poster editor: shows the chosen asset (thumb, name, dimensions, size)
// with a picker, or a plain URL field for external assets.
// showModeToggle=false hides the Asset/URL switch for hosts that provide
// their own type control (the href link editor), where it would both
// duplicate that control and overlap it — the toggle is positioned to sit
// beside a field label, which those hosts don't have directly above.
export interface PickedAsset {
  readonly rel: string;
  readonly root: string;
}
// How a picked src/ asset is written into a prop: `hero.src`, the built URL,
// or `hero`, the imported ImageMetadata object.
export type AssetReference = 'url' | 'module';
export interface AssetFieldProps {
  readonly value?: string | undefined;
  readonly fallbackValue?: string | undefined;
  readonly onChange: (value: string, immediate?: boolean) => void;
  readonly mediaKind?: AssetRequest['mediaKind'];
  readonly projectPath: string;
  readonly showModeToggle?: boolean;
  readonly initialMode?: 'asset' | 'url';
  readonly plainLabel?: string;
  readonly onDimensions?: ((dimensions: AssetDimensions) => void) | undefined;
  readonly onPickEntry?: ((entry: PickedAsset) => void) | false | undefined;
  readonly srcRel?: string | undefined;
  readonly baseDir?: string | undefined;
  readonly onCurrentDimensions?: ((dimensions: AssetDimensions) => void) | undefined;
  /** A video's poster attribute, which an external video's card shows when it is an allowed image URL. */
  readonly posterValue?: string | undefined;
  /** Where the Assets panel opens to choose (assetPick.ts); the side panel by default. */
  readonly pickPresentation?: AssetRequest['presentation'];
}

export default function AssetField(props: AssetFieldProps) {
  const { showModeToggle = true, plainLabel = 'URL', mediaKind = 'asset', onChange } = props;
  const state = useAssetField(props);
  const toggle = showModeToggle && <AssetMode mode={state.mode} onMode={state.setMode} plainLabel={plainLabel} />;
  const remoteCard = state.external && <RemoteCard state={state} mediaKind={mediaKind} posterValue={props.posterValue} />;
  if (state.mode === 'url') {
    return (
      <div className="asset-field">
        {toggle}
        {remoteCard}
        <input
          value={props.value ?? ''}
          placeholder={state.isFallback ? state.current : 'https://…'}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  return (
    <div className="asset-field">
      {toggle}
      {remoteCard || <LocalCard state={state} srcRel={props.srcRel} />}
      <button className="af-choose" onClick={state.choose}>
        Choose {kindLabel[mediaKind]}…
      </button>
    </div>
  );
}

function useAssetField({
  value,
  fallbackValue,
  onChange,
  mediaKind = 'asset',
  projectPath,
  showModeToggle = true,
  initialMode,
  onDimensions,
  onPickEntry,
  srcRel: sourceRel,
  baseDir: baseDirectory,
  onCurrentDimensions,
  pickPresentation,
}: AssetFieldProps) {
  // Preview the effective asset without writing the component's fallback into the page.
  // An explicit empty string still overrides the fallback, just as it does in Astro.
  const current = value ?? fallbackValue ?? '';
  const isFallback = value === undefined && Boolean(fallbackValue);
  const external = isExternalAsset(current);
  const [mode, setMode] = useState(() => initialMode || (showModeToggle && external ? 'url' : 'asset'));
  const entries = useAssetEntries(projectPath);
  const [dims, setDims] = useState<AssetDimensions | undefined>(undefined);
  const justPicked = React.useRef(false);

  // A value that turns out to be external — the host moved to another item,
  // say — opens in the mode that can edit it. Only in that direction: a local
  // path being typed into the URL field is usually half-written, and pulling
  // the field out from under it would be worse than leaving it there.
  useEffect(() => {
    if (showModeToggle && isExternalAsset(current)) {
      setMode('url');
    }
  }, [current, showModeToggle]);

  // Which project file the value names. A src/ asset reached through an import
  // is never spelled out in the value — the host resolves that one (srcRel).
  const candidates = useMemo(() => (sourceRel ? [sourceRel] : assetRelCandidates(current, baseDirectory)), [sourceRel, current, baseDirectory]);
  const byRel = useMemo(() => {
    const map = new Map<string, Extract<WireAssetEntry, { readonly isDir: false }>>();
    for (const entry of entries) {
      if (!entry.isDir) {
        map.set(entry.rel, entry);
      }
    }
    return map;
  }, [entries]);
  const entry = useMemo(() => candidates.map((candidate) => byRel.get(candidate)).find(Boolean) || undefined, [candidates, byRel]);
  // Where it should have been, for the picker's starting folder and for
  // saying which tree came up empty.
  const target = candidates[0] || undefined;

  useEffect(() => setDims(undefined), [current]);

  const noteDims = (dimensions: AssetDimensions) => {
    setDims(dimensions);
    onCurrentDimensions?.(dimensions);
    if (justPicked.current) {
      justPicked.current = false;
      onDimensions?.(dimensions);
    }
  };

  const choose = (): void =>
    requestAsset({
      mediaKind,
      ...(pickPresentation === undefined ? {} : { presentation: pickPresentation }),
      current: entry?.rel || target || '',
      onPick: (pickedRel, picked) => {
        justPicked.current = true;
        answerPick({ pickedRel, picked, onPickEntry, onChange, baseDirectory });
      },
      // A hosted file is written as its public URL, whatever the host's own pick handler does with project files.
      onPickURL: (url) => {
        justPicked.current = true;
        onChange(url, true);
      },
    });
  return { current, isFallback, external, mode, setMode, dims, entry, target, noteDims, choose };
}

// A pick goes to the host's own handler when it has one, else into the value.
function answerPick(answer: {
  readonly pickedRel: string;
  readonly picked: WireAssetEntry | undefined;
  readonly onPickEntry: AssetFieldProps['onPickEntry'];
  readonly onChange: AssetFieldProps['onChange'];
  readonly baseDirectory: string | undefined;
}): void {
  const { pickedRel, picked, onPickEntry } = answer;
  if (onPickEntry) {
    onPickEntry(picked || { rel: pickedRel, root: pickedRel.split('/')[0] ?? '' });
    return;
  }
  answer.onChange(assetValueFor(pickedRel, answer.baseDirectory), true);
}

type AssetFieldState = ReturnType<typeof useAssetField>;
function AssetMode({
  mode,
  onMode,
  plainLabel,
}: {
  readonly mode: 'asset' | 'url';
  readonly onMode: (mode: 'asset' | 'url') => void;
  readonly plainLabel: string;
}) {
  return (
    <div className="af-mode">
      <button className={`af-mode-btn ${mode === 'asset' ? 'on' : ''}`} title="Choose a file from this project" onClick={() => onMode('asset')}>
        Asset
      </button>
      <button
        className={`af-mode-btn ${mode === 'url' ? 'on' : ''}`}
        title="Enter a plain value (external URL, expression, anything)"
        onClick={() => onMode('url')}
      >
        {plainLabel}
      </button>
    </div>
  );
}
function RemoteCard({
  state,
  mediaKind,
  posterValue,
}: {
  readonly state: AssetFieldState;
  readonly mediaKind: RemoteMediaHint;
  readonly posterValue: string | undefined;
}) {
  const { current, noteDims, dims } = state;
  return (
    <div className="af-card">
      <div className="af-thumb">
        <RemoteThumb url={current} hint={mediaKind} poster={posterValue} onLoad={noteDims} />
      </div>
      <div className="af-meta">
        <div className="af-name" title={current}>
          {remoteName(current)}
        </div>
        <div className="af-sub">{remoteHost(current)}</div>
        {state.isFallback && <div className="af-sub">Component fallback</div>}
        {dims && (
          <div className="af-sub">
            {dims.w} x {dims.h}px
          </div>
        )}
      </div>
    </div>
  );
}
function LocalCard({ state, srcRel: sourceRel }: { readonly state: AssetFieldState; readonly srcRel: string | undefined }) {
  const { entry, noteDims, current, dims, target } = state;
  return (
    <div className="af-card">
      <div className="af-thumb">{entry ? <AssetThumb file={entry} onImageLoad={noteDims} /> : <ElementImageIcon size={18} />}</div>
      <div className="af-meta">
        <div className="af-name" title={sourceRel || current}>
          {entry ? entry.name : sourceRel || current || 'No asset selected'}
        </div>
        {state.isFallback && <div className="af-sub">Component fallback</div>}
        {dims && (
          <div className="af-sub">
            {dims.w} x {dims.h}px
          </div>
        )}
        {entry && <div className="af-sub">{fmtSize(entry.size)}</div>}
        {!entry && (sourceRel || current) && (
          <div className="af-sub">{target ? `not found in ${target.startsWith('src/') ? 'src/' : 'public/'}` : 'file not found'}</div>
        )}
      </div>
    </div>
  );
}

/** The project's asset files, kept current as they change on disk. */
export function useAssetEntries(projectPath: string): readonly WireAssetEntry[] {
  const [entries, setEntries] = useState<readonly WireAssetEntry[]>([]);
  useEffect(() => {
    let active = true;
    let reading = false;
    let requested = false;
    const refresh = async (): Promise<void> => {
      requested = true;
      if (reading) {
        return;
      }
      reading = true;
      try {
        // Coalesce watcher bursts into one read and one pending refresh.
        for (let attempt = 0; requested && active; attempt++) {
          if (attempt >= ASSET_REFRESH_CHAIN_MAX) {
            throw new Error('AssetField: refresh chain limit exceeded');
          }
          requested = false;
          const result = await listAssetEntries(projectPath);
          if (!active) {
            return;
          }
          if (result.ok) {
            setEntries(result.value);
          } else {
            console.warn('Could not read project assets:', result.error);
          }
        }
      } finally {
        reading = false;
      }
    };
    void refresh();
    const off = onAssetEntriesChanged(() => {
      void refresh();
    });
    return () => {
      active = false;
      off();
    };
  }, [projectPath]);
  return entries;
}
