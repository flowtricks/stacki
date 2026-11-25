// The editor's half of a navigator selection, small enough for a test page: the real message parser
// (previewMessages.ts) and the real overlay (PreviewOverlays.tsx) over one preview iframe. The test that
// bundles it (test/electron/preload/collapsedSelection.test.js) runs the real preload in the iframe, so
// the frame's measuring, the postMessage, the parser and the drawn outline are all the shipped code.
//
// The page reads `window.collapsedHost`: what the frame reported for the selected path and what is drawn.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewOverlays, type OverlayInfo, type RectMap } from '../../src/features/preview/PreviewOverlays';
import { parsePreviewMessage } from '../../src/features/preview/previewMessages';

interface HostState {
  reported: number;
  /** The box the frame measured for the selected path, as the overlay received it. */
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined;
}

const state: HostState = { reported: 0, box: undefined };
Reflect.set(window, 'collapsedHost', state);

const params = new URLSearchParams(location.search);
const selectedPath = params.get('path') ?? '0';
const frameElement = document.querySelector('iframe');
const overlayElement = document.querySelector('#overlay');
if (!(frameElement instanceof HTMLIFrameElement)) {
  throw new Error('Assertion failed: the host page holds the canvas iframe');
}
if (!(overlayElement instanceof HTMLElement)) {
  throw new Error('Assertion failed: the host page holds the overlay layer');
}
const canvas = frameElement;
const root = createRoot(overlayElement);

const info: OverlayInfo = {
  label: 'div',
  kind: 'element',
  tag: 'div',
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'element',
  childCount: 0,
  isLayout: false,
  bound: false,
};

// What the app sends when a node is selected in the navigator: the path is tracked, and no hover is involved.
// The app sends it again whenever the frame announces a rendering (previewRuntime.ts), because a frame that has
// not walked its markers yet cannot answer; so does this, on each announcement and on load.
const sendTrack = (): void => {
  canvas.contentWindow?.postMessage({ type: 'avb:track', paths: [selectedPath], scope: '', focus: '', focusOcc: 0 }, '*');
};
canvas.addEventListener('load', sendTrack);
// A track the frame could not yet answer is asked again, a bounded number of times, until it reports.
const RETRY_MS = 100;
const RETRIES_MAX = 100;
let retries = 0;
const retry = window.setInterval(() => {
  retries += 1;
  if (state.reported > 0 || retries > RETRIES_MAX) {
    window.clearInterval(retry);
    return;
  }
  sendTrack();
}, RETRY_MS);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== canvas.contentWindow) {
    return;
  }
  const message = parsePreviewMessage(event.data);
  if (message?.kind === 'render') {
    sendTrack();
    return;
  }
  if (message === undefined || message.kind !== 'rects') {
    return;
  }
  const rects: RectMap = message.rects;
  state.reported += 1;
  state.box = rects[selectedPath]?.[0];
  root.render(
    <PreviewOverlays
      rects={rects}
      spacing={message.spacing}
      scale={1}
      selPath={selectedPath}
      selOcc={0}
      hoverPath={undefined}
      hoverOcc={undefined}
      focusPath={undefined}
      focusWhole={true}
      overlayInfo={() => info}
    />,
  );
});
