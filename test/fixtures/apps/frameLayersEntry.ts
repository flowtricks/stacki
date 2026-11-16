// One bundle for nodeRefs.test.js: the frame's layer queries and the marker
// collection they read, sharing one module instance so the test can collect a page.
export { collectRegions, setTracking, resetFocusCache } from '../../../electron/preload/frameRegions';
export { layersAt, resolveChain, parseFrameChain } from '../../../electron/preload/frameLayers';
export { receivePointQuery } from '../../../electron/preload/framePointQuery';
export { receiveOutlineMode, deepHoverAt, outlineMode } from '../../../electron/preload/frameOutlineMode';
