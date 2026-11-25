// One bundle for overlayDrag.test.js: the canvas point query and the canvas frame
// it asks through, sharing one module instance so the test can install a frame.
export { setCanvasFrame } from '../../../src/editor/canvasQuery';
export { queryCanvasPoint, receiveCanvasPoint } from '../../../src/ui/canvasPointQuery';
