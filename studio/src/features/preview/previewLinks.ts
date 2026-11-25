import { installPreviewLinks } from '../../../vendor/stacki/electron/preload/frameInteraction';

// Imported first by the frame client, so the preview's link listeners are on the
// window before any other module's: the static demo's runtime (staticHot.ts) stands
// in for Vite's client and holds root links in capture, and a download route must
// reach a new tab before that guard keeps it as a page the bake does not have.
// A frame on its own (no parent) is a visitor's tab, where the browser needs no help.
if (window.parent !== window) {
  installPreviewLinks();
}
