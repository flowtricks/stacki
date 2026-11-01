import Popup from '../../ui/Popup';
import { useId, useState } from 'react';
import type { ImageFormat } from '../../../shared/ipc/assetConversion';
import { CloseIcon } from '../../ui/Icons';
import type { AssetFile } from './assetPaths';

export default function AssetCompressionDialog({
  files,
  onClose,
  onCompress,
}: {
  readonly files: readonly AssetFile[];
  readonly onClose: () => void;
  readonly onCompress: (files: readonly AssetFile[], format: ImageFormat) => void;
}) {
  const [format, setFormat] = useState<ImageFormat>('avif');
  const titleId = useId();
  const targets = files.filter((file) => !file.name.toLowerCase().endsWith('.' + format));
  const skipped = files.length - targets.length;
  return (
    <Popup className="modal asset-compression-dialog" labelledBy={titleId} onClose={onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">
            <h2 id={titleId}>
              Compress {files.length} {files.length === 1 ? 'image' : 'images'}
            </h2>
            <button className="ghost" aria-label="Close compression dialog" onClick={close}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="modal-body">
            <p>Resize to 95% and convert at 95% quality. Site references update automatically, and originals move to Trash after success.</p>
            <CompressionFormats format={format} setFormat={setFormat} />
            {skipped > 0 && <p className="hint-text">{skipped} already in this format will be skipped.</p>}
          </div>
          <div className="modal-footer">
            <button autoFocus onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={targets.length === 0} onClick={() => onCompress(targets, format)}>
              Compress
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function CompressionFormats({ format, setFormat }: { readonly format: ImageFormat; readonly setFormat: (format: ImageFormat) => void }) {
  const radioName = useId();
  return (
    <fieldset>
      <legend>Select a file format</legend>
      {(['avif', 'webp'] as const).map((value) => (
        <label key={value}>
          <input type="radio" name={radioName} value={value} checked={format === value} onChange={() => setFormat(value)} />
          {value === 'avif' ? 'AVIF' : 'WebP'}
        </label>
      ))}
    </fieldset>
  );
}
