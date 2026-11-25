// Goal: delayed renders cannot retire or overwrite a newer literal text preview.
// Method: exercise the real client with authoritative snapshots and fresh DOM nodes,
// including stripped slot comments and ambiguous/nested content that must stay intact.
import { receiveLiveText, applyLiveText } from '../src/features/preview/liveTextClient';
import { collectRegions } from '../vendor/stacki/electron/preload/frameRegions';

export function checkLiveText() {
  const render = (text: string) => `<h1 data-avb-p="0">${text}</h1>`;
  const change = (before: string, text: string) =>
    receiveLiveText({
      type: 'studio:live-text',
      changes: [{ path: '0.0', parent: '0', before, text }],
    });
  document.body.innerHTML = render('original');
  collectRegions();
  change('original', 'newer');
  check('newer', 'Literal slot content updates immediately');
  // A server render can leave an optimistic node intact. That is not confirmation.
  reconcile(render('original'));
  document.body.innerHTML = render('original');
  collectRegions();
  reconcile(render('original'));
  check('newer', 'An older render must not retire a newer pending change');
  document.body.innerHTML = render('newer');
  reconcile(render('newer'));
  document.body.innerHTML = render('outside edit');
  reconcile(render('outside edit'));
  check('outside edit', 'A confirmed edit stops overriding later server content');
  document.body.innerHTML = render('before');
  change('before', 'first');
  change('first', 'latest');
  document.body.innerHTML = render('before');
  reconcile(render('before'));
  check('latest', 'Rapid edits retain the original mapping while a render is delayed');
  receiveLiveText({ type: 'studio:live-text', reset: true, changes: [] });
  document.body.innerHTML = render('before <strong>nested</strong> before');
  change('before', 'replacement');
  check('before nested before', 'An ambiguous match never replaces nested markup');
  receiveLiveText({ type: 'studio:live-text', reset: true, changes: [] });
}

function reconcile(html: string) {
  const rendered = new DOMParser().parseFromString(html, 'text/html');
  Reflect.apply(applyLiveText, undefined, [rendered]);
}
function check(expected: string, message: string) {
  if (document.querySelector('h1')?.textContent !== expected) {
    throw new Error(message);
  }
}
