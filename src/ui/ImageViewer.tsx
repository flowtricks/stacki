// The app's one large view of a picture, over everything: as large as the window allows at its own aspect,
// never larger than its own pixels. Escape, a press outside it and its close button close it (Popup), and
// focus returns to what opened it. Shared by Desktop's chat (drafts, sent and queued images) and Studio's.
// A picture still on its way is a skeleton, never words.
import { useState } from 'react';
import { useTranslate } from '../lib/i18n/useTranslate';
import { fitContain } from './fitContain';
import { CloseIcon } from './Icons';
import Popup from './Popup';
import { Skeleton } from './Skeleton';
import './imageViewer.css';

export interface ImageViewerProps {
  /** The picture's name: the dialog's label and the image's alt text. */
  readonly name: string;
  /** The picture; undefined while it is being read. */
  readonly source: string | undefined;
  /** What to say about the picture in its tooltip; absent: nothing. */
  readonly note?: string | undefined;
  /** The picture could not be decoded. */
  readonly onError?: (() => void) | undefined;
  readonly onClose: () => void;
}

interface Measured {
  readonly source: string;
  readonly width: number;
  readonly height: number;
}

export function ImageViewer({ name, source, note, onError, onClose }: ImageViewerProps) {
  const translate = useTranslate();
  // The picture's own pixel size, read when it loads; until then it is laid out hidden, never at a guessed size.
  const [measured, setMeasured] = useState<Measured | undefined>(undefined);
  const natural = measured !== undefined && measured.source === source ? measured : undefined;
  return (
    <Popup className="modal ai-lightbox" label={name} onClose={onClose}>
      {({ close }) => (
        <>
          {natural === undefined && (
            <span className="ai-lightbox-loading" role="status" aria-busy="true" aria-label={translate('ui.loading')}>
              <Skeleton width="100%" height="100%" radius="inherit" />
            </span>
          )}
          {source !== undefined && (
            <img
              key={source}
              className="ai-lightbox-image"
              src={source}
              alt={name}
              title={note}
              style={natural === undefined ? { position: 'absolute', visibility: 'hidden', width: 1, height: 1 } : lightboxSize(natural)}
              onLoad={(event) => setMeasured({ source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={onError}
            />
          )}
          <button type="button" className="ghost ai-lightbox-close" aria-label={translate('ai.screenshot.close')} onClick={close}>
            <CloseIcon size={12} />
          </button>
        </>
      )}
    </Popup>
  );
}

/** The viewer's share of the window, less its padding. */
const LIGHTBOX_WINDOW_SHARE = 0.92;
const LIGHTBOX_PADDING_PX = 16;

/** The whole image at its own aspect, as large as the window allows but never larger than its own pixels. */
export function lightboxSize(
  natural: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number } = { width: globalThis.innerWidth, height: globalThis.innerHeight },
): { readonly width: number; readonly height: number } {
  const box = {
    width: Math.min(natural.width, Math.floor(view.width * LIGHTBOX_WINDOW_SHARE) - LIGHTBOX_PADDING_PX),
    height: Math.min(natural.height, Math.floor(view.height * LIGHTBOX_WINDOW_SHARE) - LIGHTBOX_PADDING_PX),
  };
  return fitContain(
    { width: Math.max(1, natural.width), height: Math.max(1, natural.height) },
    { width: Math.max(1, box.width), height: Math.max(1, box.height) },
  );
}
