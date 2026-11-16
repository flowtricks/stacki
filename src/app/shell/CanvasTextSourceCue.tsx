// The chip over a text being edited on the canvas that is printed from data: it
// says which source the typed words are written to, so a data edit is never a
// surprise. Portals into the body like the format bar (the canvas layer clips),
// never takes the pointer, and draws no border: a purple background, as chips are.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveValue } from '../../ui/liveValue';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { canvasSourceCue, canvasSourceHover, type CanvasSourceCueState } from '../../ui/canvasTextSourceCue';
import { sourceCuePath } from './sourceCueText';

const GAP = 6;
const MARGIN = 8;

export function CanvasTextSourceCue() {
  const cue = useLiveValue(canvasSourceCue);
  const hover = useLiveValue(canvasSourceHover);
  if (cue) {
    return createPortal(<SourceCueChip key={cue.session} cue={cue} hint={false} />, document.body);
  }
  if (hover) {
    return createPortal(<SourceCueChip key={`${hover.session}:${hover.expression}`} cue={hover} hint />, document.body);
  }
  return undefined;
}

function SourceCueChip({ cue, hint }: { readonly cue: CanvasSourceCueState; readonly hint: boolean }) {
  const translate = useTranslate();
  const element = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const chip = element.current;
    if (!chip) {
      return;
    }
    const { width, height } = chip.getBoundingClientRect();
    const above = cue.box.y - height - GAP;
    const top = above >= MARGIN ? above : cue.box.y + cue.box.h + GAP;
    const left = Math.max(MARGIN, Math.min(cue.box.x, window.innerWidth - width - MARGIN));
    setPlace({ left, top });
  }, [cue]);
  const where = cue.file === '' ? translate('preview.text.source.pageFile') : undefined;
  return (
    <div
      ref={element}
      className="canvas-source-cue"
      role="status"
      style={{ left: place?.left ?? cue.box.x, top: place?.top ?? cue.box.y, visibility: place ? 'visible' : 'hidden' }}
    >
      {hint ? (
        <span className="canvas-source-cue-label">{translate('preview.text.source.hover', { path: cue.expression })}</span>
      ) : (
        <>
          <span className="canvas-source-cue-label">{translate('preview.text.source.label')}</span>
          <CodeInline text={sourceCuePath(cue.file, cue.expression)} language="typescript" className="canvas-source-cue-path" />
        </>
      )}
      {!hint && where !== undefined && <span className="canvas-source-cue-uses">{where}</span>}
      {!hint && cue.uses > 1 && <span className="canvas-source-cue-uses">{translate('preview.text.source.uses', { count: cue.uses })}</span>}
    </div>
  );
}
