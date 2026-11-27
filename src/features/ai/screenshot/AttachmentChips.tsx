// The draft's attachments as chips above the input: an image shows its thumbnail and opens larger in a
// lightbox when clicked; every chip has a remove button. The thumbnail and the lightbox read the
// draft's in-memory data URL, so showing an image larger writes nothing anywhere.
import { useState } from 'react';
import { CloseIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { DraftAttachment } from '../aiStore';
import { fitContain } from './FramePicker';
import { FileTypeIcon } from '../../../ui/ElementIcons';

export function AttachmentChips({ attachments, onRemove }: { readonly attachments: readonly DraftAttachment[]; readonly onRemove: (id: string) => void }) {
  const translate = useTranslate();
  const [enlarged, setEnlarged] = useState<DraftAttachment | undefined>(undefined);
  // The enlarged image's own pixel size, read when it loads; until then it is laid out hidden, never at a guessed size.
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | undefined>(undefined);
  if (attachments.length === 0) {
    return undefined;
  }
  return (
    <div className="ai-attachments">
      {attachments.map((entry) => {
        const name = entry.attachment.kind === 'image' ? entry.attachment.name : entry.attachment.path;
        return (
          <span className={`ai-attachment${entry.preview === undefined ? '' : ' is-image'}`} key={entry.id}>
            {entry.preview === undefined ? (
              <>
                <FileTypeIcon name={name} size={12} />
                <span>{name}</span>
              </>
            ) : (
              <button
                type="button"
                className="ghost ai-attachment-open"
                aria-label={translate('ai.screenshot.enlarge', { name })}
                onClick={() => {
                  setNatural(undefined);
                  setEnlarged(entry);
                }}
              >
                <img src={entry.preview} alt="" />
                <span>{name}</span>
              </button>
            )}
            <button type="button" className="ghost" aria-label={translate('ai.composer.attach.remove')} onClick={() => onRemove(entry.id)}>
              <CloseIcon size={10} />
            </button>
          </span>
        );
      })}
      {enlarged?.preview !== undefined && (
        <Popup
          className="modal ai-lightbox"
          label={enlarged.attachment.kind === 'image' ? enlarged.attachment.name : undefined}
          onClose={() => setEnlarged(undefined)}
        >
          {({ close }) => (
            <>
              <img
                className="ai-lightbox-image"
                src={enlarged.preview}
                alt={enlarged.attachment.kind === 'image' ? enlarged.attachment.name : ''}
                style={natural === undefined ? { visibility: 'hidden' } : lightboxSize(natural)}
                onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              />
              <button type="button" className="ghost ai-lightbox-close" aria-label={translate('ai.screenshot.close')} onClick={close}>
                <CloseIcon size={12} />
              </button>
            </>
          )}
        </Popup>
      )}
    </div>
  );
}

/** The lightbox's share of the window, less its padding. */
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
