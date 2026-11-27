// The attachments under a sent message, each a chip: its label (a screenshot's "Screenshot 1 (1600×933)", a
// recording's frame, a file's path) and, for an image, a tiny thumbnail of the picture before it. The thumbnail is
// the small preview stored with the message (chatModel's `thumbnail`), so it shows after a restart too; a message
// stored before thumbnails, a file, or an image that could not be previewed shows the label alone, never an empty box.
//
// The box has a fixed size, so nothing moves when the picture decodes: a skeleton fills it until then. Resting the
// pointer on the chip, or reaching it with the keyboard, shows its value in the app's own tooltip (the same layer
// and delay as every other tip): the larger preview for a picture, the whole label otherwise. The label is the
// picture's alt text; the chip does nothing when pressed.
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
        <SentAttachment key={index} attachment={attachment} />
      ))}
    </div>
  );
}

type Decode = 'pending' | 'ready' | 'failed';

function SentAttachment({ attachment }: { readonly attachment: ChatAttachmentName }) {
  const [decode, setDecode] = useState<Decode>('pending');
  const placement = useDelayedPlacement((element: HTMLElement) => ({ anchor: tooltipAnchor(element.getBoundingClientRect()), host: tooltipHost(element) }));
  const picture = attachment.thumbnail !== undefined && decode !== 'failed' ? attachment.thumbnail : undefined;
  const shown = placement.value;
  return (
    <span
      className="ai-message-attachment"
      tabIndex={0}
      onMouseEnter={(event) => placement.show(event.currentTarget)}
      onMouseLeave={placement.hide}
      onFocus={(event) => placement.showNow(event.currentTarget)}
      onBlur={placement.hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && shown !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          placement.hide();
        }
      }}
    >
      {picture !== undefined && <SentThumbnail label={attachment.name} source={picture} decode={decode} onDecode={setDecode} />}
      <span className="ai-message-attachment-label">{attachment.name}</span>
      {shown !== undefined &&
        createPortal(
          picture === undefined ? (
            <FittedTooltip className="ai-message-attachment-tip" role="tooltip" anchor={shown.anchor}>
              {attachment.name}
            </FittedTooltip>
          ) : (
            <FittedTooltip className="ai-message-thumb-preview" role="tooltip" hidden anchor={shown.anchor}>
              <img src={picture} alt="" />
            </FittedTooltip>
          ),
          shown.host,
        )}
    </span>
  );
}

function SentThumbnail({
  label,
  source,
  decode,
  onDecode,
}: {
  readonly label: string;
  readonly source: string;
  readonly decode: Decode;
  readonly onDecode: (decode: Decode) => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  // A data URL is often decoded before React attaches `onLoad`; reading `complete` once settles that case without a flash.
  useLayoutEffect(() => {
    const node = image.current;
    if (node !== null && node.complete) {
      onDecode(node.naturalWidth > 0 ? 'ready' : 'failed');
    }
  }, [source, onDecode]);
  return (
    <span className="ai-message-thumb" data-decode={decode}>
      {decode === 'pending' && <Skeleton width="100%" height="100%" radius="inherit" />}
      <img ref={image} src={source} alt={label} onLoad={() => onDecode('ready')} onError={() => onDecode('failed')} />
    </span>
  );
}
