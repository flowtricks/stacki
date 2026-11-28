// The draft's attachments as chips above the input: an image shows its thumbnail and opens larger in the
// image viewer when clicked; every chip has a remove button. The thumbnail and the viewer read the
// draft's in-memory data URL, so showing an image larger writes nothing anywhere.
import { useState } from 'react';
import { CloseIcon } from '../../../ui/Icons';
import { ImageViewer } from '../../../ui/ImageViewer';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { DraftAttachment } from '../aiStore';
import { FileTypeIcon } from '../../../ui/ElementIcons';

export function AttachmentChips({ attachments, onRemove }: { readonly attachments: readonly DraftAttachment[]; readonly onRemove: (id: string) => void }) {
  const translate = useTranslate();
  const [enlarged, setEnlarged] = useState<DraftAttachment | undefined>(undefined);
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
                onClick={() => setEnlarged(entry)}
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
        <ImageViewer
          name={enlarged.attachment.kind === 'image' ? enlarged.attachment.name : ''}
          source={enlarged.preview}
          onClose={() => setEnlarged(undefined)}
        />
      )}
    </div>
  );
}
