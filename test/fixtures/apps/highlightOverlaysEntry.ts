// One bundle for canvasHighlight.test.js: the canvas outlines and the highlight store they read,
// sharing one module instance so a highlight set here is the one the outlines draw.
export { PreviewOverlays } from '../../../src/features/preview/PreviewOverlays';
export { setCanvasHighlight } from '../../../src/ui/canvasOutlineMode';
// React from the same bundle, so the outlines' hooks and the renderer share one copy.
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';
