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
import { installCanvasImage } from './frameImage';
import { canvasSelects } from './frameInteraction';
import { exposeBridge } from './preloadBridge';
import { listenForDesign, markFrameMode } from './frameDesign';
import { listenForQueries, startWhenReady } from './frameQueries';
import { rememberScrollAcrossRecovery } from './frameScrollMemory';
import { reportErrorOverlay } from './frameErrorOverlay';
import { installPageScrollReport } from './frameScrollbar';
import { isDesignFrameDocument, listenForDesignSnapshots } from './designMode/designSnapshotFrame'; // Design mode (experimental)

// A Stacki app's frame (stacki-app:) is the app's own sandboxed document: it
// gets neither half. It talks to Stacki only through postMessage and the RPC.
if (location.protocol === 'stacki-app:') {
  // Nothing to install.
} else if (!process.isMainFrame && isDesignFrameDocument()) {
  // Design mode (experimental): a frame on its canvas is a still copy of a page, so it gets neither half.
} else if (!process.isMainFrame) {
  const post = (message: unknown) => window.parent.postMessage(message, '*');
  // Registered first, so a double click on an image is heard before text editing (which takes the nearest words of a
  // stretched link) and before the one that opens a component.
  installCanvasImage(post, canvasSelects);
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
  rememberScrollAcrossRecovery();
  reportErrorOverlay(post);
  listenForDesign();
  listenForQueries();
  startWhenReady();
  listenForDesignSnapshots(); // Design mode (experimental)
  // The canvas draws the page's scrollbar beside the frame from these reports (frameScrollbar.ts). Last, so the
  // canvas's own listeners are in place whatever happens here.
  installPageScrollReport(post);
} else {
  exposeBridge();
}
