import { centralIcon } from '../../ui/central/CentralIcon';
import { collapse as centralCollapse } from '../../ui/central/centralGeometry';
import { useEffect, useRef } from 'react';
import { IMAGE_BATCH_MAX } from '../../../shared/ipc/assetConversion';
import { canConvertAssets } from '../../ipc/editorEnvironment';
import AssetThumb from '../../ui/AssetThumb';
import { TrashIcon } from '../../ui/Icons';
import { convertible, selectableAsset, type AssetBatch } from './AssetBatchTools';
import type { AssetFile } from './assetPaths';

export function AssetSelectionToolbar({ batch, files }: { readonly batch: AssetBatch; readonly files: readonly AssetFile[] }) {
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
      <strong>All assets</strong>
      <span className="asset-selection-count">
        {selected.length} of {files.length}
      </span>
      <div className="asset-batch-actions">
        {canConvertAssets && (
          <button
            className="ghost"
            title={compressTitle(selected.length, compressible.length, skipped)}
            aria-label="Compress selected assets"
            disabled={busy || compressible.length === 0}
            onClick={() => batch.setCompression(compressible)}
          >
            <CompressIcon />
          </button>
        )}
        <button
          className="ghost"
          title="Delete selected assets"
          aria-label="Delete selected assets"
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
          Cancel
        </button>
      </div>
    </div>
  );
}

function SelectAllAssets({ batch, files, count }: { readonly batch: AssetBatch; readonly files: readonly AssetFile[]; readonly count: number }) {
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
      aria-label="Select all assets"
      checked={count > 0 && count === files.length}
      disabled={batch.progress !== undefined || files.length === 0 || files.length > IMAGE_BATCH_MAX}
      title={files.length > IMAGE_BATCH_MAX ? `Select up to ${IMAGE_BATCH_MAX} files at a time` : 'Select all'}
      onChange={() => batch.setSelected(new Set(count === files.length ? [] : files.map((file) => file.rel)))}
    />
  );
}

// Why Compress is off, or what it will skip: only PNG, JPEG, WebP, AVIF and TIFF are re-encoded.
function compressTitle(selected: number, compressible: number, skipped: number): string {
  if (selected === 0) {
    return 'Compress selected images';
  }
  if (compressible === 0) {
    return 'None of the selected files can be compressed: only PNG, JPEG, WebP, AVIF and TIFF images can.';
  }
  if (skipped > 0) {
    return `Compress ${compressible} ${compressible === 1 ? 'image' : 'images'}; ${skipped} other ${skipped === 1 ? 'file is' : 'files are'} skipped (only PNG, JPEG, WebP, AVIF and TIFF can be compressed)`;
  }
  return 'Compress selected images';
}

export function SelectableAssetTile({ file, batch }: { readonly file: AssetFile; readonly batch: AssetBatch }) {
  const checked = batch.selected.has(file.rel);
  // Only a batch in progress makes a tile unavailable, and the tile says so.
  const busy = batch.progress !== undefined;
  return (
    <label
      className={`asset-tile asset-selectable ${checked ? 'selected' : ''} ${busy ? 'is-disabled' : ''}`}
      title={busy ? 'Wait for the current batch to finish' : file.name}
    >
      <input
        type="checkbox"
        className="asset-select"
        aria-label={`Select ${file.name}`}
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
