import { centralIcon } from '../../ui/central/CentralIcon';
import { collapse as centralCollapse } from '../../ui/central/centralGeometry';
import { useEffect, useRef } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { IMAGE_BATCH_MAX } from '../../../shared/ipc/assetConversion';
import { canConvertAssets } from '../../ipc/editorEnvironment';
import AssetThumb from '../../ui/AssetThumb';
import { TrashIcon } from '../../ui/Icons';
import { convertible, selectableAsset, type AssetBatch } from './AssetBatchTools';
import type { AssetFile } from './assetPaths';

export function AssetSelectionToolbar({ batch, files }: { readonly batch: AssetBatch; readonly files: readonly AssetFile[] }) {
  const translate = useTranslate();
  const eligible = files.filter(selectableAsset);
  const selected = eligible.filter((file) => batch.selected.has(file.rel));
  const compressible = selected.filter(convertible);
  const skipped = selected.length - compressible.length;
  const busy = batch.progress !== undefined;
  if (!batch.selecting) {
    return undefined;
  }
  return (
    <div className="asset-batch-tools selecting">
      <SelectAllAssets batch={batch} files={eligible} count={selected.length} />
      <strong>{translate('assets.selection.all')}</strong>
      <span className="asset-selection-count">{translate('assets.selection.count', { selected: selected.length, total: files.length })}</span>
      <div className="asset-batch-actions">
        {canConvertAssets && (
          <button
            className="ghost"
            title={compressTitle(selected.length, compressible.length, skipped, translate)}
            aria-label={translate('assets.selection.compressAria')}
            disabled={busy || compressible.length === 0}
            onClick={() => batch.setCompression(compressible)}
          >
            <CompressIcon />
          </button>
        )}
        <button
          className="ghost"
          title={translate('assets.selection.delete')}
          aria-label={translate('assets.selection.delete')}
          disabled={busy || selected.length === 0}
          onClick={() => void batch.run(selected, 'delete')}
        >
          <TrashIcon size={16} />
        </button>
        <button
          disabled={busy}
          onClick={() => {
            batch.setSelecting(false);
            batch.setSelected(new Set());
          }}
        >
          {translate('ui.cancel')}
        </button>
      </div>
    </div>
  );
}

function SelectAllAssets({ batch, files, count }: { readonly batch: AssetBatch; readonly files: readonly AssetFile[]; readonly count: number }) {
  const translate = useTranslate();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = count > 0 && count < files.length;
    }
  }, [count, files.length]);
  return (
    <input
      ref={inputRef}
      type="checkbox"
      className="asset-select-all"
      aria-label={translate('assets.selection.selectAll')}
      checked={count > 0 && count === files.length}
      disabled={batch.progress !== undefined || files.length === 0 || files.length > IMAGE_BATCH_MAX}
      title={files.length > IMAGE_BATCH_MAX ? translate('assets.selection.limit', { count: IMAGE_BATCH_MAX }) : translate('assets.selection.selectAllTitle')}
      onChange={() => batch.setSelected(new Set(count === files.length ? [] : files.map((file) => file.rel)))}
    />
  );
}

// Why Compress is off, or what it will skip: only PNG, JPEG, WebP, AVIF and TIFF are re-encoded.
function compressTitle(selected: number, compressible: number, skipped: number, translate: Translator): string {
  if (selected === 0) {
    return translate('assets.selection.compress');
  }
  if (compressible === 0) {
    return translate('assets.selection.compressNone');
  }
  if (skipped > 0) {
    return translate('assets.selection.compressSome', { images: translate('assets.selection.compressImages', { count: compressible }), count: skipped });
  }
  return translate('assets.selection.compress');
}

export function SelectableAssetTile({ file, batch }: { readonly file: AssetFile; readonly batch: AssetBatch }) {
  const translate = useTranslate();
  const checked = batch.selected.has(file.rel);
  // Only a batch in progress makes a tile unavailable, and the tile says so.
  const busy = batch.progress !== undefined;
  return (
    <label
      className={`asset-tile asset-selectable ${checked ? 'selected' : ''} ${busy ? 'is-disabled' : ''}`}
      title={busy ? translate('assets.selection.wait') : file.name}
    >
      <input
        type="checkbox"
        className="asset-select"
        aria-label={translate('assets.selection.select', { name: file.name })}
        checked={checked}
        disabled={busy}
        onChange={() => batch.toggle(file.rel)}
      />
      <AssetThumb file={file} />
      <div className="asset-name">{file.name}</div>
    </label>
  );
}

// The supplied compression glyph points inward toward the reduced dimension.
const CompressIcon = centralIcon(centralCollapse);
