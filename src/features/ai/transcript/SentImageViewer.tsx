// A sent image, large. A message keeps a small preview in its transcript and the full copy beside the chat
// (`original`), read only when the viewer opens, with a skeleton meanwhile. A chat from before full copies were
// kept, or a copy since removed to stay within its bound, shows the preview, and its tooltip says why it is small.
import { useEffect, useState } from 'react';
import type { ChatAttachmentName, ChatImageId } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { ImageViewer } from '../../../ui/ImageViewer';

/** Reads a kept image as a data URL; undefined when it is gone. */
export type LoadSentImage = (image: ChatImageId) => Promise<string | undefined>;

export interface SentImageViewerProps {
  readonly name: string;
  readonly thumbnail: string;
  readonly original: ChatAttachmentName['original'];
  readonly load: LoadSentImage | undefined;
  readonly onClose: () => void;
}

type Full = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly source: string } | { readonly kind: 'gone' };

export function SentImageViewer({ name, thumbnail, original, load, onClose }: SentImageViewerProps) {
  const translate = useTranslate();
  const [full, setFull] = useState<Full>(original === undefined || load === undefined ? { kind: 'gone' } : { kind: 'loading' });
  // Read once for each opening: `load` is a fresh function on every render of the row, so it is not a reason to read again.
  const [read] = useState(() => load);
  useEffect(() => {
    if (original === undefined || read === undefined) {
      return undefined;
    }
    let open = true;
    void read(original).then((source) => {
      if (open) {
        setFull(source === undefined ? { kind: 'gone' } : { kind: 'ready', source });
      }
    });
    return () => {
      open = false;
    };
  }, [original, read]);
  switch (full.kind) {
    case 'loading':
      return <ImageViewer name={name} source={undefined} onClose={onClose} />;
    case 'ready':
      return <ImageViewer name={name} source={full.source} onError={() => setFull({ kind: 'gone' })} onClose={onClose} />;
    case 'gone':
      return <ImageViewer name={name} source={thumbnail} note={translate('ai.images.smallOnly')} onClose={onClose} />;
    default: {
      const exhaustive: never = full;
      return exhaustive;
    }
  }
}
