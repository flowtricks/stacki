// The formatting bar over words selected on the canvas: the Settings Content
// field's own buttons, link field and bubble, placed over the selection.
//
// It renders into the document body rather than the canvas overlay layer: the
// layer is transformed and clips its contents, and the bubble is fixed, so
// inside the layer it would be cut off at the canvas edge.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveValue } from '../../ui/liveValue';
import { RichFormatButtons, RichLinkField, richBubblePlace, type BubblePosition } from '../../features/props/RichFormatButtons';
import { canvasRichPlus, canvasTextSelection, type CanvasRichPlusState, type CanvasTextSelectionState } from '../../features/preview/canvasTextSelection';
import { BlockInsertButton, pickMedia } from '../../ui/HtmlField';
import { HtmlLinkEditor } from '../../ui/HtmlLinkEditor';

export function CanvasTextFormatBar() {
  const selection = useLiveValue(canvasTextSelection);
  const plus = useLiveValue(canvasRichPlus);
  return (
    <>
      {selection && createPortal(<CanvasTextBubble key={selection.session} selection={selection} />, document.body)}
      {plus && createPortal(<CanvasRichPlus plus={plus} />, document.body)}
    </>
  );
}

// The `+` beside an empty block of rich text being typed on the canvas: the rich text dialog's menu, in its order. An
// image or a video comes from the asset picker, or an address typed in the field it opens beside the block.
function CanvasRichPlus({ plus }: { readonly plus: CanvasRichPlusState }) {
  const [address, setAddress] = useState<'link' | 'image' | 'video'>();
  const place = { left: Math.max(4, plus.box.x - 28), top: plus.box.y + Math.max(0, Math.floor((plus.box.h - 20) / 2)) };
  const insert = (kind: 'link' | 'image' | 'video', value: string) => {
    setAddress(undefined);
    plus.choose(kind === 'link' ? { kind: 'link', href: value } : { kind: 'media', media: kind, address: value });
  };
  return (
    <div className="canvas-rich-plus" style={{ position: 'fixed', left: place.left, top: place.top, zIndex: 40 }} onPointerDownCapture={plus.hold}>
      <BlockInsertButton
        onChoose={(choice) => {
          if (choice.kind === 'media') {
            setAddress(choice.media);
            pickMedia(choice.media, (value) => insert(choice.media, value));
          } else if (choice.kind === 'link') {
            setAddress('link');
          } else {
            plus.choose(choice);
          }
        }}
      />
      {address && (
        <HtmlLinkEditor
          bubble={{ kind: 'edit', href: '', place: { top: 26, left: 0 } }}
          onEdit={() => {}}
          onApply={(value) => insert(address, value)}
          onRemove={() => setAddress(undefined)}
          onClose={() => setAddress(undefined)}
        />
      )}
    </div>
  );
}

function CanvasTextBubble({ selection }: { readonly selection: CanvasTextSelectionState }) {
  const { bubble } = selection;
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<BubblePosition | undefined>(undefined);
  const [linking, setLinking] = useState(false);
  const [url, setURL] = useState('');
  useLayoutEffect(() => {
    setPosition(element.current ? richBubblePlace(bubble, element.current) : undefined);
  }, [bubble, linking]);
  const style: React.CSSProperties = {
    left: position ? position.left : bubble.x,
    top: position ? position.top : bubble.top - 10,
    visibility: position ? 'visible' : 'hidden',
  };
  const endLink = (value: string | undefined) => {
    setLinking(false);
    setURL('');
    selection.endLink(value);
  };
  return (
    <div ref={element} className={`rich-bubble ${position?.below ? 'below' : ''}`} style={style} onMouseDown={(event) => event.stopPropagation()}>
      {linking ? (
        <RichLinkField value={url} onChange={setURL} onApply={() => endLink(url)} onCancel={() => endLink(undefined)} onBlur={() => endLink(undefined)} />
      ) : (
        <RichFormatButtons
          states={selection.states}
          onExec={(command) => selection.press({ kind: 'exec', command })}
          onWrap={(tag) => selection.press({ kind: 'wrap', tag })}
          onLink={() => {
            selection.beginLink();
            setLinking(true);
          }}
        />
      )}
    </div>
  );
}
