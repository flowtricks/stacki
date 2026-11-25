// Goal: a Design mode page copy keeps the page's look from the app's origin: stylesheet URLs become absolute
// against their sheet, viewport-height units are bound to the frame's chosen screen (never to the frame's own,
// page-tall height), and web fonts are inlined within a count and character budget; a font that fails, or would
// pass the budget, keeps its address.
//
// Method: the pure functions of electron/preload/designMode/designSnapshotCss.ts over CSS text, with a stand-in
// font fetcher that records what it was asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FontInliner, freezeViewportUnits, rebaseCssURLs } from '../../../../electron/preload/designMode/designSnapshotCss.ts';

test('relative URLs are made absolute against their stylesheet; data, blob and fragment URLs are kept', () => {
  const css = `a{background:url(../img/a.png)} b{background:url("/b.svg")} c{background:url('data:image/png;base64,AA')} d{filter:url(#f)}`;
  const rebased = rebaseCssURLs(css, 'http://127.0.0.1:4321/assets/styles/site.css');
  assert.match(rebased, /url\(http:\/\/127\.0\.0\.1:4321\/assets\/img\/a\.png\)/);
  assert.match(rebased, /url\("http:\/\/127\.0\.0\.1:4321\/b\.svg"\)/);
  assert.match(rebased, /url\('data:image\/png;base64,AA'\)/);
  assert.match(rebased, /url\(#f\)/);
});

test('vh, svh, lvh and dvh lengths are bound to --design-vh; other units and words are left alone', () => {
  assert.equal(freezeViewportUnits('min-height:100vh'), 'min-height:calc(100 * var(--design-vh, 1vh))');
  assert.equal(freezeViewportUnits('height: 50svh; top: -2.5dvh'), 'height: calc(50 * var(--design-vh, 1vh)); top: calc(-2.5 * var(--design-vh, 1vh))');
  assert.equal(freezeViewportUnits('width:100vw; --x: 1vhx; .vh{}'), 'width:100vw; --x: 1vhx; .vh{}');
  assert.equal(freezeViewportUnits('no units here'), 'no units here');
});

test('fonts are inlined once each, within the count and character budget', async () => {
  const asked: string[] = [];
  const fonts = new FontInliner(30, 3, (url) => {
    asked.push(url);
    if (url.endsWith('broken.woff2')) {
      return Promise.reject(new Error('network'));
    }
    return Promise.resolve(url.endsWith('big.woff2') ? 'data:font/woff2;base64,' + 'A'.repeat(40) : 'data:font/woff2;base64,AA');
  });
  const css = `@font-face{font-family:A;src:url(http://h/a.woff2) format("woff2")}
@font-face{font-family:B;src:url("http://h/big.woff2")}
@font-face{font-family:C;src:url(http://h/broken.woff2)}
@font-face{font-family:D;src:url(http://h/d.woff2)}
p{background:url(http://h/a.woff2)}`;
  const inlined = await fonts.inline(css);
  assert.match(inlined, /font-family:A;src:url\(data:font\/woff2;base64,AA\)/);
  assert.match(inlined, /url\("http:\/\/h\/big\.woff2"\)/, 'past the character budget: kept');
  assert.match(inlined, /url\(http:\/\/h\/broken\.woff2\)/, 'a failed fetch: kept');
  assert.match(inlined, /url\(http:\/\/h\/d\.woff2\)/, 'past the count budget: never asked');
  assert.match(inlined, /p\{background:url\(http:\/\/h\/a\.woff2\)\}/, 'only @font-face URLs are fonts');
  assert.deepEqual(asked, ['http://h/a.woff2', 'http://h/big.woff2', 'http://h/broken.woff2']);
  await fonts.inline(css);
  assert.equal(asked.length, 3, 'a second sheet asks for nothing already fetched or out of budget');
  assert.throws(() => new FontInliner(-1, 1, () => Promise.resolve(undefined)), /never negative/);
});
