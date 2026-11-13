import React, { useEffect, useMemo, useState } from 'react';
import { ElementImageIcon } from './Icons';
import { listAssetEntries, onAssetEntriesChanged } from '../ipc/assetBridge';
import type { WireAssetEntry } from '../../shared/ipc/ipcResults';
import type { AssetAltPick, AssetPickTarget, AssetRequest } from './assetPick';
import type { AssetDimensions } from './AssetThumb';
import AssetThumb from './AssetThumb';
import { chooseAsset } from './assetPick';
import { useAppOverrideOwner } from './appOverrideSlot';
import { OverrideNote, overrideTitle } from './OverrideNote';
import { assetRelCandidates, assetValueFor, isExternalAsset } from './assetPath';
import { classifyRemoteMedia, remotePosterSource, type RemoteMediaHint } from './remoteMedia';
import type { MessageKey, Translator } from '../lib/i18n/localeContext';
import { useFormat, useTranslate } from '../lib/i18n/useTranslate';

const CHOOSE_KEYS = {
  image: 'ui.assetField.chooseImage',
  video: 'ui.assetField.chooseVideo',
  audio: 'ui.assetField.chooseAudio',
  asset: 'ui.assetField.chooseAsset',
} as const satisfies Record<'image' | 'video' | 'audio' | 'asset', MessageKey>;
// Refreshes one read may chain while watcher events keep arriving. Each is a
// real read, so a burst that outlasts this many is a watcher loop, not a user.
const ASSET_REFRESH_CHAIN_MAX = 256;

// "https://cdn.site.com/a/hero.png?w=8" → "hero.png" / "cdn.site.com", so a
// hosted image reads like the file it is rather than as a wall of URL.
const remoteName = (url: string) => {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.split('/').filter(Boolean).pop() || path;
};
const remoteHost = (url: string, translate: Translator) => {
  if (/^data:/i.test(url)) {
    return 'data URI'; // i18n-ignore: the technical name of the scheme, the same in every language
  }
  try {
    return new URL(/^\/\//.test(url) ? `https:${url}` : url).hostname;
  } catch {
    return translate('ui.assetField.external');
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
/** An app's pick as the field writes it with alt text: a value for the field, or a project file for its host's own pick handler. */
export type AltPick = { readonly kind: 'value'; readonly value: string } | { readonly kind: 'entry'; readonly entry: PickedAsset };
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
  /** The element field this edits, which an app answering the pick is told (docs/apps.md, "Overrides"). */
  readonly pickTarget?: AssetPickTarget | undefined;
  /** Writes a pick and an image's alt text as one edit, when an app's picker answers with alt text. */
  readonly onPickWithAlt?: ((pick: AltPick, alt: string) => void) | undefined;
}

export default function AssetField(props: AssetFieldProps) {
  const translate = useTranslate();
  const { showModeToggle = true, plainLabel = 'URL', mediaKind = 'asset', onChange } = props;
  const state = useAssetField(props);
  const toggle = showModeToggle && <AssetMode mode={state.mode} onMode={state.setMode} plainLabel={plainLabel} />;
  const remoteCard = state.external && <RemoteCard state={state} mediaKind={mediaKind} posterValue={props.posterValue} />;
  const owner = useAppOverrideOwner('assets.pick');
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
      <button className="af-choose" onClick={state.choose} title={owner === undefined ? undefined : overrideTitle(translate, owner)}>
        {translate(CHOOSE_KEYS[mediaKind])}
      </button>
      <OverrideNote point="assets.pick" />
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
  pickTarget,
  onPickWithAlt,
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

  // Alt-click skips any app that answers picks: Stacki's own picker opens.
  const choose = (event: React.MouseEvent): void => {
    void chooseAsset(pickRequest(), { bypass: event.altKey, target: pickTarget });
  };
  const pickRequest = (): AssetRequest => ({
    mediaKind,
    ...(pickPresentation === undefined ? {} : { presentation: pickPresentation }),
    onPickWithAlt:
      onPickWithAlt === undefined
        ? undefined
        : (pick: AssetAltPick, alt: string) => {
            justPicked.current = true;
            onPickWithAlt(altPickFor({ pick, onPickEntry, baseDirectory }), alt);
          },
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

// An app's pick with alt text, in the form answerPick would write it: the host's own
// handler takes a project file when it has one, else the field takes a value.
function altPickFor(answer: {
  readonly pick: AssetAltPick;
  readonly onPickEntry: AssetFieldProps['onPickEntry'];
  readonly baseDirectory: string | undefined;
}): AltPick {
  const { pick } = answer;
  switch (pick.kind) {
    case 'url':
      return { kind: 'value', value: pick.url };
    case 'file':
      if (answer.onPickEntry) {
        return { kind: 'entry', entry: { rel: pick.rel, root: pick.rel.split('/')[0] ?? '' } };
      }
      return { kind: 'value', value: assetValueFor(pick.rel, answer.baseDirectory) };
    default: {
      const exhaustive: never = pick;
      return exhaustive;
    }
  }
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
  const translate = useTranslate();
  return (
    <div className="af-mode">
      <button className={`af-mode-btn ${mode === 'asset' ? 'on' : ''}`} title={translate('ui.assetField.modeAssetTitle')} onClick={() => onMode('asset')}>
        {translate('ui.assetField.modeAsset')}
      </button>
      <button className={`af-mode-btn ${mode === 'url' ? 'on' : ''}`} title={translate('ui.assetField.modePlainTitle')} onClick={() => onMode('url')}>
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
  const translate = useTranslate();
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
        <div className="af-sub">{remoteHost(current, translate)}</div>
        {state.isFallback && <div className="af-sub">{translate('ui.assetField.componentFallback')}</div>}
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
  const translate = useTranslate();
  const { formatBytes } = useFormat();
  const { entry, noteDims, current, dims, target } = state;
  return (
    <div className="af-card">
      <div className="af-thumb">{entry ? <AssetThumb file={entry} onImageLoad={noteDims} /> : <ElementImageIcon size={18} />}</div>
      <div className="af-meta">
        <div className="af-name" title={sourceRel || current}>
          {entry ? entry.name : sourceRel || current || translate('ui.assetField.noneSelected')}
        </div>
        {state.isFallback && <div className="af-sub">{translate('ui.assetField.componentFallback')}</div>}
        {dims && (
          <div className="af-sub">
            {dims.w} x {dims.h}px
          </div>
        )}
        {entry && entry.size !== undefined && <div className="af-sub">{formatBytes(entry.size)}</div>}
        {!entry && (sourceRel || current) && (
          <div className="af-sub">
            {target
              ? translate('ui.assetField.notFoundIn', { folder: target.startsWith('src/') ? 'src/' : 'public/' })
              : translate('ui.assetField.fileNotFound')}
          </div>
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
