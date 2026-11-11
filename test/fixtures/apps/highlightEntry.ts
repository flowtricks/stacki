// One bundle for canvasHighlight.test.js: the apps runtime, its dispatcher and the canvas's
// outline store, sharing one module instance so a highlight set through one is read in the other.
export { appHighlights, clearAppHighlight, launchApp, noteLeftPanel, outlineModeOwner, stopApp } from '../../../src/features/apps/appsRuntime';
export { answerAppMessage, inFlightCounter } from '../../../src/features/apps/appRpcHost';
export { canvasHighlight, deepHoverNode } from '../../../src/ui/canvasOutlineMode';
export { resolveHighlight } from '../../../src/features/apps/nodeRefs';
