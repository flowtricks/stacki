// The attachments under a sent message, each a chip: its label (a screenshot's "Screenshot 1 (1600×933)", a
// recording's frame, a file's path) and, for an image, a tiny thumbnail of the picture before it. The thumbnail is
// the small preview stored with the message (chatModel's `thumbnail`), so it shows after a restart too; a message
// stored before thumbnails, a file, or an image that could not be previewed shows the label alone, never an empty box.
//
// The box has a fixed size, so nothing moves when the picture decodes: a skeleton fills it until then. Resting the
// pointer on the chip, or reaching it with the keyboard, shows its value in the app's own tooltip (the same layer
// and delay as every other tip): the larger preview for a picture, the whole label otherwise. The label is the
// picture's alt text. A chip with a picture is a button that opens it large (SentImageViewer); one without does
// nothing when pressed, as there is nothing to show.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ChatAttachmentName } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { SentImageViewer, type LoadSentImage } from './SentImageViewer';
import FittedTooltip from '../../../ui/FittedTooltip';
import { Skeleton } from '../../../ui/Skeleton';
import { tooltipAnchor, tooltipHost, useDelayedPlacement } from '../../../ui/delayedTooltip';

export function SentAttachments({
  attachments,
  loadImage,
}: {
  readonly attachments: readonly ChatAttachmentName[];
  readonly loadImage?: LoadSentImage | undefined;
}) {
  if (attachments.length === 0) {
    return undefined;
  }
  return (
    <div className="ai-message-attachments">
      {attachments.map((attachment, index) => (
        <SentAttachment key={index} attachment={attachment} loadImage={loadImage} />
      ))}
    </div>
  );
}

type Decode = 'pending' | 'ready' | 'failed';

function SentAttachment({ attachment, loadImage }: { readonly attachment: ChatAttachmentName; readonly loadImage: LoadSentImage | undefined }) {
  const translate = useTranslate();
  const [decode, setDecode] = useState<Decode>('pending');
  const [viewing, setViewing] = useState(false);
  // Closing the viewer hands focus back to the chip; that focus is not a request for its tooltip.
  const returning = useRef(false);
  const placement = useDelayedPlacement((element: HTMLElement) => ({ anchor: tooltipAnchor(element.getBoundingClientRect()), host: tooltipHost(element) }));
  const picture = attachment.thumbnail !== undefined && decode !== 'failed' ? attachment.thumbnail : undefined;
  const shown = placement.value;
  const hover = {
    onMouseEnter: (event: { readonly currentTarget: HTMLElement }) => placement.show(event.currentTarget),
    onMouseLeave: placement.hide,
    onFocus: (event: { readonly currentTarget: HTMLElement }) => {
      if (!returning.current) {
        placement.showNow(event.currentTarget);
      }
      returning.current = false;
    },
    onBlur: placement.hide,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape' && shown !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        placement.hide();
      }
    },
  };
  const content = (
    <>
      {picture !== undefined && <SentThumbnail label={attachment.name} source={picture} decode={decode} onDecode={setDecode} />}
      <span className="ai-message-attachment-label">{attachment.name}</span>
    </>
  );
  return (
    <>
      {picture === undefined ? (
        <span className="ai-message-attachment" tabIndex={0} {...hover}>
          {content}
        </span>
      ) : (
        <button
          type="button"
          className="ai-message-attachment is-openable"
          aria-label={translate('ai.screenshot.enlarge', { name: attachment.name })}
          aria-haspopup="dialog"
          {...hover}
          onClick={() => {
            returning.current = true;
            placement.hide();
            setViewing(true);
          }}
        >
          {content}
        </button>
      )}
      {viewing && picture !== undefined && (
        <SentImageViewer name={attachment.name} thumbnail={picture} original={attachment.original} load={loadImage} onClose={() => setViewing(false)} />
      )}
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
    </>
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
