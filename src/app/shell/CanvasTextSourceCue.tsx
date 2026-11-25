// The chip under a text being edited on the canvas that is printed from data: it
// says which source the typed words are written to, so a data edit is never a
// surprise. It shows only while the text is open for typing (canvasSourceCue): a
// pointer on the text, or a selection of it, draws nothing, so hovering never
// flashes it. Portals into the body like the format bar (the canvas layer clips),
// never takes the pointer, and draws no border: a purple background, as chips are.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveValue } from '../../ui/liveValue';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { canvasSourceCue, type CanvasSourceCueState } from '../../ui/canvasTextSourceCue';
import { sourceCuePath, sourceCuePlace } from './sourceCueText';

export function CanvasTextSourceCue() {
  const cue = useLiveValue(canvasSourceCue);
  if (cue) {
    return createPortal(<SourceCueChip key={cue.session} cue={cue} />, document.body);
  }
  return undefined;
}

function SourceCueChip({ cue }: { readonly cue: CanvasSourceCueState }) {
  const translate = useTranslate();
  const element = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | undefined>(undefined);
  // Measured before the first paint, so the chip is never seen anywhere but its place.
  useLayoutEffect(() => {
    const chip = element.current;
    if (!chip) {
      return;
    }
    const { width, height } = chip.getBoundingClientRect();
    setPlace(sourceCuePlace(cue.box, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [cue]);
  const where = cue.file === '' ? translate('preview.text.source.pageFile') : undefined;
  return (
    <div
      ref={element}
      className="canvas-source-cue"
      role="status"
      style={{ left: place?.left ?? cue.box.x, top: place?.top ?? cue.box.y, visibility: place ? 'visible' : 'hidden' }}
    >
      <span className="canvas-source-cue-label">{translate('preview.text.source.label')}</span>
      <CodeInline text={sourceCuePath(cue.file, cue.expression)} language="typescript" className="canvas-source-cue-path" />
      {where !== undefined && <span className="canvas-source-cue-uses">{where}</span>}
      {cue.uses > 1 && <span className="canvas-source-cue-uses">{translate('preview.text.source.uses', { count: cue.uses })}</span>}
    </div>
  );
}
