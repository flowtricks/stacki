// The formatting bar over words selected on the canvas: the Settings Content
// field's own buttons, link field and bubble, placed over the selection.
//
// It renders into the document body rather than the canvas overlay layer: the
// layer is transformed and clips its contents, and the bubble is fixed, so
// inside the layer it would be cut off at the canvas edge.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveValue } from '../../ui/liveValue';
import {
  RichFormatButtons,
  RichLinkField,
  richBubblePlace,
  type BubblePosition,
} from '../../features/props/RichFormatButtons';
import {
  canvasTextSelection,
  type CanvasTextSelectionState,
} from '../../features/preview/canvasTextSelection';

type BubbleStyle = React.CSSProperties & { readonly '--arrow-x': string };

export function CanvasTextFormatBar() {
  const selection = useLiveValue(canvasTextSelection);
  if (!selection) {
    return undefined;
  }
  return createPortal(
    <CanvasTextBubble key={selection.session} selection={selection} />,
    document.body,
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
  const style: BubbleStyle = {
    left: position ? position.left : bubble.x,
    top: position ? position.top : bubble.top - 10,
    visibility: position ? 'visible' : 'hidden',
    '--arrow-x': position ? `${position.arrowX}px` : '50%',
  };
  const endLink = (value: string | undefined) => {
    setLinking(false);
    setURL('');
    selection.endLink(value);
  };
  return (
    <div
      ref={element}
      className={`rich-bubble ${position?.below ? 'below' : ''}`}
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {linking ? (
        <RichLinkField
          value={url}
          onChange={setURL}
          onApply={() => endLink(url)}
          onCancel={() => endLink(undefined)}
          onBlur={() => endLink(undefined)}
        />
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
