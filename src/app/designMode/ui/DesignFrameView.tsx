// One frame on the design canvas: the page copy in a sandboxed iframe (no scripts run in it; the renderer edits
// its document directly, being of the same origin), as tall as its page, and while its "Original" button is
// held, the page as it was copied drawn over it.
import { useEffect, useRef, useState } from 'react';
import { DESIGN_LIMITS, type DesignFrameRecord } from '../model/designTypes';
import { SANDBOX_FRAME_NAME, attachFrameDocument, bump, detachFrameDocument, frameBaseline, frameInitialHTML } from '../runtime/designSession';

const heights = new Map<string, number>();

/** A frame's measured page height, or its viewport height before it has measured. */
export function frameHeightPx(frame: DesignFrameRecord): number {
  return heights.get(frame.id) ?? frame.viewportHeightPx;
}

/** Styles Design mode adds to every frame document: the page cannot scroll inside a frame as tall as itself. */
const FRAME_STYLE = 'html,body{scrollbar-width:none!important}html::-webkit-scrollbar{display:none}[contenteditable]{outline:none;cursor:text}';

function measure(document: Document, minimumPx: number): number {
  const body = document.body;
  if (body === null) {
    return minimumPx;
  }
  const margin = Number.parseFloat(document.defaultView?.getComputedStyle(body).marginBottom ?? '0') || 0;
  // The body's own height, not the document's: a frame stretched to the page would never report a smaller one.
  const content = Math.ceil(body.offsetTop + body.scrollHeight + margin);
  return Math.min(DESIGN_LIMITS.frameHeightPxMax, Math.max(minimumPx, content));
}

export function prepareFrameDocument(document: Document, viewportHeightPx: number): void {
  document.documentElement.style.setProperty('--design-vh', String(viewportHeightPx / 100) + 'px');
  if (document.getElementById('design-mode-frame-style') === null) {
    const style = document.createElement('style');
    style.id = 'design-mode-frame-style';
    style.textContent = FRAME_STYLE;
    document.head?.append(style);
  }
}

export function DesignFrameView({ frame, editing, peeking }: { readonly frame: DesignFrameRecord; readonly editing: boolean; readonly peeking: boolean }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [heightPx, setHeightPx] = useState(() => frameHeightPx(frame));
  const [html] = useState(() => frameInitialHTML(frame.id) ?? '');
  const remeasureRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const element = iframe.current;
    if (element === null) {
      return undefined;
    }
    let document: Document | undefined;
    let mutations: MutationObserver | undefined;
    let pending = 0;
    const remeasure = () => {
      if (pending !== 0 || document === undefined) {
        return;
      }
      pending = requestAnimationFrame(() => {
        pending = 0;
        if (document === undefined) {
          return;
        }
        const next = measure(document, frame.viewportHeightPx);
        if (heights.get(frame.id) !== next) {
          heights.set(frame.id, next);
          setHeightPx(next);
        }
        bump();
      });
    };
    const onLoad = () => {
      const loaded = element.contentDocument;
      if (loaded === null) {
        return;
      }
      document = loaded;
      prepareFrameDocument(loaded, frame.viewportHeightPx);
      attachFrameDocument(frame.id, loaded);
      // This window's observers and listeners: the frame runs no script of its own (sandboxed), so nothing
      // of its realm is called. Images and fonts arriving late change the page's height too.
      if (loaded.body !== null) {
        mutations = new MutationObserver(remeasure);
        mutations.observe(loaded.body, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      loaded.addEventListener('load', remeasure, true);
      void loaded.fonts.ready.then(remeasure);
      remeasureRef.current = remeasure;
      remeasure();
    };
    element.addEventListener('load', onLoad);
    return () => {
      element.removeEventListener('load', onLoad);
      mutations?.disconnect();
      cancelAnimationFrame(pending);
      if (document !== undefined) {
        detachFrameDocument(frame.id, document);
      }
    };
  }, [frame.id, frame.viewportHeightPx]);

  useEffect(() => {
    // A new width lays the page out again; the observer hears the body change size.
    const document = iframe.current?.contentDocument;
    if (document !== null && document !== undefined) {
      prepareFrameDocument(document, frame.viewportHeightPx);
      remeasureRef.current();
    }
  }, [frame.widthPx, frame.viewportHeightPx]);

  const baselineHTML = peeking ? frameBaseline(frame.id)?.html : undefined;
  return (
    <div className="dm-frame-page" style={{ width: frame.widthPx, height: heightPx }}>
      <iframe
        ref={iframe}
        name={SANDBOX_FRAME_NAME}
        title={frame.name}
        sandbox="allow-same-origin"
        srcDoc={html}
        className="dm-frame-iframe"
        style={{ width: frame.widthPx, height: heightPx, pointerEvents: editing ? 'auto' : 'none' }}
        tabIndex={-1}
      />
      {baselineHTML !== undefined && <PeekFrame html={baselineHTML} frame={frame} heightPx={heightPx} />}
    </div>
  );
}

function PeekFrame({ html, frame, heightPx }: { readonly html: string; readonly frame: DesignFrameRecord; readonly heightPx: number }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  return (
    <iframe
      ref={iframe}
      name={SANDBOX_FRAME_NAME}
      title={frame.name}
      sandbox="allow-same-origin"
      srcDoc={html}
      className="dm-frame-iframe dm-frame-peek"
      style={{ width: frame.widthPx, height: heightPx }}
      tabIndex={-1}
      onLoad={() => {
        const document = iframe.current?.contentDocument;
        if (document !== null && document !== undefined) {
          prepareFrameDocument(document, frame.viewportHeightPx);
        }
      }}
    />
  );
}
