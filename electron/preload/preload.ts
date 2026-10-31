import { occurrenceOf } from './frameReports';
import { renderToken } from './frameRegions';
// The preload, in two halves on one flag. In the app's own window it exposes
// window.avb, the API the renderer calls main through (preloadBridge.ts). In
// preview iframes — nodeIntegrationInSubFrames runs it there too — it exposes
// nothing to the previewed site: it reports the page's height, marks and
// measures what the editor tracks, and answers the canvas (the frame*.ts
// modules).
//
// The sandbox's require reaches only electron, so these modules ship as one
// bundle (scripts/build/bundleClients.ts). Their top levels only declare:
// everything a frame does starts from the calls below, so the app's window
// runs none of the frame half and a preview frame none of the bridge.
import { installCanvasText } from './frameText';
import { canvasSelects } from './frameInteraction';
import { exposeBridge } from './preloadBridge';
import { listenForDesign, markFrameMode } from './frameDesign';
import { listenForQueries, startWhenReady } from './frameQueries';

if (!process.isMainFrame) {
  const post = (message: unknown) => window.parent.postMessage(message, '*');
  // Opening text selects what holds it. Prop text is already selected by the
  // two clicks before the double click: its element lives in the component's
  // file, where a page path would name some other node on the page.
  installCanvasText(post, canvasSelects, (target, element) => {
    if (target.from === 'prop') {
      return;
    }
    post({
      type: 'avb:click-node',
      path: target.parent,
      outside: false,
      occurrence: occurrenceOf(target.parent, element),
      token: renderToken,
    });
  });
  markFrameMode();
  listenForDesign();
  listenForQueries();
  startWhenReady();
} else {
  exposeBridge();
}
