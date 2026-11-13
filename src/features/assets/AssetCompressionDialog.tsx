import Popup from '../../ui/Popup';
import { useId, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
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
  const translate = useTranslate();
  const [format, setFormat] = useState<ImageFormat>('avif');
  const titleId = useId();
  const targets = files.filter((file) => !file.name.toLowerCase().endsWith('.' + format));
  const skipped = files.length - targets.length;
  return (
    <Popup className="modal asset-compression-dialog" labelledBy={titleId} onClose={onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">
            <h2 id={titleId}>{translate('assets.compress.title', { count: files.length })}</h2>
            <button className="ghost" aria-label={translate('assets.compress.close')} onClick={close}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="modal-body">
            <p>{translate('assets.compress.description')}</p>
            <CompressionFormats format={format} setFormat={setFormat} />
            {skipped > 0 && <p className="hint-text">{translate('assets.compress.skipped', { count: skipped })}</p>}
          </div>
          <div className="modal-footer">
            <button autoFocus onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button className="primary" disabled={targets.length === 0} onClick={() => onCompress(targets, format)}>
              {translate('assets.compress.action')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function CompressionFormats({ format, setFormat }: { readonly format: ImageFormat; readonly setFormat: (format: ImageFormat) => void }) {
  const translate = useTranslate();
  const radioName = useId();
  return (
    <fieldset>
      <legend>{translate('assets.compress.format')}</legend>
      {(['avif', 'webp'] as const).map((value) => (
        <label key={value}>
          <input type="radio" name={radioName} value={value} checked={format === value} onChange={() => setFormat(value)} />
          {/* i18n-ignore: image format names. */}
          {value === 'avif' ? 'AVIF' : 'WebP'}
        </label>
      ))}
    </fieldset>
  );
}
