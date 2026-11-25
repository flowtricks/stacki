// Goal: refreshes avoid duplicate baseline encoding without affecting first loads.
// Method: concurrently request a real prerendered Astro route in both modes,
// compare exact HTML, and verify request-local state never leaks into the next load.
import assert from 'node:assert/strict';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({
  page: '<main><h1>Preview response</h1>{Array.from({length: 1500}, (_, i) => <p>Row {i}</p>)}</main>',
});
try {
  const url = new URL('/', fixture.url);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [initial, patch] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(10_000) }),
      fetch(url, {
        headers: { 'x-studio-render': 'patch' },
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    assert.equal(initial.status, 200);
    assert.equal(patch.status, 200);
    const first = await initial.text();
    const refresh = await patch.text();
    const offset = first.lastIndexOf('<script id="studio-render-baseline"');
    assert.ok(offset > 0, 'Initial loads retain their exact server baseline');
    assert.equal(refresh, first.slice(0, offset), 'Refreshes contain the same complete HTML once');
    assert.ok(refresh.length < first.length / 2, 'Refreshes avoid the escaped duplicate');
    console.log(JSON.stringify({ attempt, initialBytes: first.length, refreshBytes: refresh.length }));
  }
} finally {
  await fixture.stop();
}
