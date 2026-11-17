// The editor's half of a navigator selection plus a canvas hover, small enough for a test page: the real
// message parser (previewMessages.ts) and the real overlay (PreviewOverlays.tsx) over one preview iframe. The
// test that bundles it (test/electron/preload/fragmentOutline.test.js) runs the real preload in the iframe, so
// the frame's measuring, the postMessage, the parser and the drawn outlines are all the shipped code.
//
// The selected path comes in the query (`path`), as the navigator would pick it, with occurrence zero as the
// navigator sends. A hover the frame reports (`avb:hover-node`, from a real pointer over the canvas) becomes the
// hover path, as previewRuntime.ts does. Labels per path come in the query too (`labels`, a JSON object).
// The page reads `window.fragmentHost`: what the frame reported and which path is hovered.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewOverlays, type OverlayInfo, type RectMap, type SpacingMap } from '../../src/features/preview/PreviewOverlays';
import { parsePreviewMessage } from '../../src/features/preview/previewMessages';

interface HostState {
  reported: number;
  hoverPath: string | undefined;
  rects: RectMap;
}

const state: HostState = { reported: 0, hoverPath: undefined, rects: {} };
Reflect.set(window, 'fragmentHost', state);

const params = new URLSearchParams(location.search);
const selectedPath = params.get('path') ?? '0';
const labelsInput: unknown = JSON.parse(params.get('labels') ?? '{}');
const labels = new Map<string, string>();
if (typeof labelsInput === 'object' && labelsInput !== null) {
  for (const [key, value] of Object.entries(labelsInput)) {
    if (typeof value === 'string') {
      labels.set(key, value);
    }
  }
}
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

// A Fragment is labelled as the editor labels it: element styling, a component node (outlineIcon).
const infoOf = (path: string): OverlayInfo => {
  const label = labels.get(path) ?? 'div';
  return {
    label,
    kind: 'element',
    tag: label === 'Fragment' ? undefined : 'div',
    astroAsset: false,
    dynamicTag: false,
    nodeKind: label === 'Fragment' ? 'component' : 'element',
    childCount: 0,
    isLayout: false,
    bound: false,
  };
};

const sendTrack = (): void => {
  const paths = state.hoverPath === undefined ? [selectedPath] : [selectedPath, state.hoverPath];
  canvas.contentWindow?.postMessage({ type: 'avb:track', paths, scope: '', focus: '', focusOcc: 0 }, '*');
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

const draw = (rects: RectMap, spacing: SpacingMap): void => {
  root.render(
    <PreviewOverlays
      rects={rects}
      spacing={spacing}
      scale={1}
      selPath={selectedPath}
      selOcc={0}
      hoverPath={state.hoverPath}
      hoverOcc={0}
      focusPath={undefined}
      focusWhole={true}
      overlayInfo={infoOf}
    />,
  );
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== canvas.contentWindow) {
    return;
  }
  const message = parsePreviewMessage(event.data);
  if (message === undefined) {
    return;
  }
  if (message.kind === 'render') {
    sendTrack();
    return;
  }
  if (message.kind === 'hover-node') {
    state.hoverPath = message.path;
    sendTrack();
    return;
  }
  if (message.kind !== 'rects') {
    return;
  }
  state.reported += 1;
  state.rects = message.rects;
  draw(message.rects, message.spacing);
});
