// The link bubble under the text. With the caret in a link it shows where the
// link goes, with buttons to edit, open or remove it; editing (or ⌘K) turns it
// into an address field. A bare domain or an email is accepted as typed and
// written as the link it means (richTextModel.linkAddress).
import { useState } from 'react';
import { ExternalIcon, PencilIcon } from './Icons';
import { UnlinkIcon } from './richTextIcons';
import { linkAddress } from './richTextModel';

/** Where the bubble sits, in the editor's own coordinates. */
export interface LinkBubblePlace {
  readonly top: number;
  readonly left: number;
}

export type LinkBubble =
  | { readonly kind: 'view'; readonly href: string; readonly place: LinkBubblePlace }
  | { readonly kind: 'edit'; readonly href: string; readonly place: LinkBubblePlace };

export function HtmlLinkEditor(props: {
  readonly bubble: LinkBubble;
  readonly onEdit: () => void;
  readonly onApply: (href: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}) {
  const { bubble } = props;
  const style = { top: bubble.place.top, left: bubble.place.left };
  if (bubble.kind === 'edit') {
    return (
      <LinkForm
        href={bubble.href}
        style={style}
        onApply={props.onApply}
        onRemove={props.onRemove}
        onClose={props.onClose}
      />
    );
  }
  return (
    <div className="html-link-bubble" style={style} onMouseDown={(event) => event.preventDefault()}>
      <span className="html-link-href" title={bubble.href}>
        {bubble.href}
      </span>
      <button type="button" className="html-tool" title="Edit link" onClick={props.onEdit}>
        <PencilIcon size={13} />
      </button>
      <button
        type="button"
        className="html-tool"
        title="Open link"
        disabled={!/^(?:https?:|mailto:|tel:)/i.test(bubble.href)}
        onClick={() => window.open(bubble.href, '_blank', 'noopener,noreferrer')}
      >
        <ExternalIcon size={13} />
      </button>
      <button type="button" className="html-tool" title="Remove link" onClick={props.onRemove}>
        <UnlinkIcon size={13} />
      </button>
    </div>
  );
}

function LinkForm(props: {
  readonly href: string;
  readonly style: LinkBubblePlace;
  readonly onApply: (href: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState(props.href);
  const address = linkAddress(typed);
  return (
    <form
      className="html-link-bubble is-editing"
      style={props.style}
      onSubmit={(event) => {
        event.preventDefault();
        if (address !== undefined) {
          props.onApply(address);
        }
      }}
    >
      <input
        aria-label="Link address"
        placeholder="Paste or type a link…"
        value={typed}
        autoFocus
        spellCheck={false}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <button type="submit" className="html-link-apply" disabled={address === undefined}>
        Apply
      </button>
      {props.href !== '' && (
        <button type="button" className="html-tool" title="Remove link" onClick={props.onRemove}>
          <UnlinkIcon size={13} />
        </button>
      )}
    </form>
  );
}
