// A preview frame says it is still there (docs/canvas-recovery.md, "A canvas that goes blank").
//
// A frame whose renderer process died is painted as a flat grey box, and a frame whose address refused the connection
// holds an empty, see-through error document. Electron raises no event for the first, and neither sends a message, so
// the app asks: `avb:alive` with a number, answered with the same number. Only a page served over http answers, so
// Chromium's own error document, should this script run in it, stays silent too.
export function answerAliveChecks(): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) {
      return;
    }
    const data = event.data;
    if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'avb:alive') {
      return;
    }
    if (!('id' in data) || !Number.isSafeInteger(data.id)) {
      return;
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      window.parent.postMessage({ type: 'avb:alive-reply', id: data.id }, '*');
    }
  });
}
