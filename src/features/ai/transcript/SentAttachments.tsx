// The line under a sent message that names its attachments: each label (a screenshot's "Screenshot 1 (1600×933)", a file's
// path) in order, and before an image's label a tiny thumbnail of the picture. The thumbnail is the small preview stored
// with the message (chatModel's `thumbnail`), so it shows after a restart too; a message stored before thumbnails, a file,
// or an image that could not be previewed shows the label alone, never an empty box.
//
// The box has a fixed size, so nothing moves when the picture decodes: a skeleton fills it until then. Resting the pointer on
// it shows the larger preview in the app's own tooltip (the same layer and delay as every other tip). The label is the
// picture's alt text, and the box is not interactive: the label has never been, and a thumbnail does not change that.
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatAttachmentName } from '../../../../shared/properties/ai/chatModel';
import FittedTooltip from '../../../ui/FittedTooltip';
import { Skeleton } from '../../../ui/Skeleton';
import { tooltipAnchor, tooltipHost, useDelayedPlacement } from '../../../ui/delayedTooltip';

export function SentAttachments({ attachments }: { readonly attachments: readonly ChatAttachmentName[] }) {
  if (attachments.length === 0) {
    return undefined;
  }
  return (
    <div className="ai-message-attachments">
      {attachments.map((attachment, index) => (
        <span className="ai-message-attachment" key={index}>
          {attachment.thumbnail === undefined ? undefined : <SentThumbnail label={attachment.name} source={attachment.thumbnail} />}
          <span className="ai-message-attachment-label">{attachment.name}</span>
        </span>
      ))}
    </div>
  );
}

type Decode = 'pending' | 'ready' | 'failed';

function SentThumbnail({ label, source }: { readonly label: string; readonly source: string }) {
  const [decode, setDecode] = useState<Decode>('pending');
  const image = useRef<HTMLImageElement>(null);
  const placement = useDelayedPlacement((element: HTMLElement) => ({ anchor: tooltipAnchor(element.getBoundingClientRect()), host: tooltipHost(element) }));
  // A data URL is often decoded before React attaches `onLoad`; reading `complete` once settles that case without a flash.
  useLayoutEffect(() => {
    const node = image.current;
    if (node !== null && node.complete) {
      setDecode(node.naturalWidth > 0 ? 'ready' : 'failed');
    }
  }, [source]);
  if (decode === 'failed') {
    return undefined;
  }
  const shown = placement.value;
  return (
    <span className="ai-message-thumb" data-decode={decode} onMouseEnter={(event) => placement.show(event.currentTarget)} onMouseLeave={placement.hide}>
      {decode === 'pending' && <Skeleton width="100%" height="100%" radius="inherit" />}
      <img ref={image} src={source} alt={label} onLoad={() => setDecode('ready')} onError={() => setDecode('failed')} />
      {shown !== undefined &&
        createPortal(
          <FittedTooltip className="ai-message-thumb-preview" role="tooltip" hidden anchor={shown.anchor}>
            <img src={source} alt="" />
          </FittedTooltip>,
          shown.host,
        )}
    </span>
  );
}
