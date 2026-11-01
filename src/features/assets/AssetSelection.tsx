import { useEffect, useRef } from 'react';
import { IMAGE_BATCH_MAX } from '../../../shared/ipc/assetConversion';
import { canConvertAssets } from '../../ipc/editorEnvironment';
import AssetThumb from '../../ui/AssetThumb';
import { TrashIcon } from '../../ui/Icons';
import { selectableAsset, type AssetBatch } from './AssetBatchTools';
import type { AssetFile } from './assetPaths';

export function AssetSelectionToolbar({ batch, files }: { readonly batch: AssetBatch; readonly files: readonly AssetFile[] }) {
  const eligible = files.filter(selectableAsset);
  const selected = eligible.filter((file) => batch.selected.has(file.rel));
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
            title="Compress selected assets"
            aria-label="Compress selected assets"
            disabled={busy || selected.length === 0}
            onClick={() => batch.setCompression(selected)}
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
      aria-label="Select all eligible assets"
      checked={count > 0 && count === files.length}
      disabled={batch.progress !== undefined || files.length === 0 || files.length > IMAGE_BATCH_MAX}
      title={files.length > IMAGE_BATCH_MAX ? 'Select up to 100 images at a time' : 'Select all'}
      onChange={() => batch.setSelected(new Set(count === files.length ? [] : files.map((file) => file.rel)))}
    />
  );
}

export function SelectableAssetTile({ file, batch }: { readonly file: AssetFile; readonly batch: AssetBatch }) {
  const eligible = selectableAsset(file);
  const checked = batch.selected.has(file.rel);
  const disabled = !eligible || batch.progress !== undefined;
  return (
    <label
      className={`asset-tile asset-selectable ${checked ? 'selected' : ''} ${disabled ? 'is-disabled' : ''}`}
      title={eligible ? file.name : 'This asset type cannot be compressed'}
    >
      <input
        type="checkbox"
        className="asset-select"
        aria-label={`Select ${file.name}`}
        checked={checked}
        disabled={disabled}
        onChange={() => batch.toggle(file.rel)}
      />
      <AssetThumb file={file} />
      <div className="asset-name">{file.name}</div>
    </label>
  );
}

// The supplied compression glyph points inward toward the reduced dimension.
function CompressIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M15 8H2V7h13v1Z" fill="currentColor" />
      <path d="m8 10.707-2.146 2.147-.708-.708L8.5 8.793l3.354 3.353-.708.708L9 10.707V15H8v-4.293Z" fill="currentColor" />
      <path d="M8 4.293 5.854 2.146l-.708.708L8.5 6.207l3.354-3.353-.708-.708L9 4.293V0H8v4.293Z" fill="currentColor" />
    </svg>
  );
}
