// Goal: the pure core of the palette's preview snapshots behaves: keys are stable and change with every
// part, the name-only detector separates a failed render from content, the snapshot message parser refuses
// malformed input, and the fit arithmetic never enlarges.
// Method: known-good values, then each part changed alone, then each bad shape alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fitSnapshot,
  hashText,
  isSnapshotKey,
  parsePreviewSnapshotMessage,
  parsePreviewUnchangedMessage,
  previewRendersOnlyName,
  snapshotKey,
  SNAPSHOT_TILE_PADDING,
  PREVIEW_SNAPSHOT_LIMITS,
} from '#dist/shared/properties/previewSnapshot.js';

const parts = { source: 'a', dependencies: ['b', 'c'], styles: 's', inputs: 'i', theme: 't' };

test('a key is stable and every part moves it', () => {
  const key = snapshotKey(parts);
  assert.equal(key, snapshotKey({ ...parts }));
  assert.ok(isSnapshotKey(key));
  for (const changed of [
    { source: 'a2' },
    { dependencies: ['b', 'c2'] },
    { dependencies: ['c', 'b'] },
    { dependencies: ['bc'] },
    { styles: 's2' },
    { inputs: 'i2' },
    { theme: 't2' },
  ]) {
    assert.notEqual(snapshotKey({ ...parts, ...changed }), key, JSON.stringify(changed));
  }
  assert.equal(hashText('').length, PREVIEW_SNAPSHOT_LIMITS.keyChars);
  assert.throws(() => Reflect.apply(hashText, undefined, [7]), /expected a string/);
});

test('isSnapshotKey refuses what is not a key', () => {
  for (const value of ['', 'abc', 'G'.repeat(28), 'a'.repeat(27), 'a'.repeat(29), undefined, 7]) {
    assert.equal(isSnapshotKey(value), false);
  }
});

test('only markup that is just the name is a failed render', () => {
  assert.equal(previewRendersOnlyName('<div>LogoGrid</div>', 'LogoGrid'), true);
  assert.equal(previewRendersOnlyName('<p>Logo Grid</p>', 'LogoGrid'), true);
  assert.equal(previewRendersOnlyName('<div>Logo Grid and more</div>', 'LogoGrid'), false);
  assert.equal(previewRendersOnlyName('<div><img src="x">LogoGrid</div>', 'LogoGrid'), false);
  assert.equal(previewRendersOnlyName('<div></div>', 'LogoGrid'), false);
  assert.equal(previewRendersOnlyName('<style>.a{}</style><script>1</script><i>LogoGrid</i><!-- c -->', 'LogoGrid'), true);
  assert.throws(() => Reflect.apply(previewRendersOnlyName, undefined, [1, 'x']), /expected strings/);
});

const message = {
  type: 'avb:component-preview-snapshot',
  key: 'a'.repeat(28),
  html: '<p>x</p>',
  box: { left: 0, top: 0, width: 10, height: 10 },
  attempt: 'sample',
};

test('a snapshot message is parsed, and each bad shape is refused', () => {
  assert.deepEqual(parsePreviewSnapshotMessage(message), { key: message.key, html: message.html, box: message.box, attempt: 'sample' });
  const bad: unknown[] = [
    undefined,
    JSON.parse('null'),
    { ...message, type: 'x' },
    { ...message, key: 'nope' },
    { ...message, html: '' },
    { ...message, html: 5 },
    { ...message, html: 'x'.repeat(PREVIEW_SNAPSHOT_LIMITS.htmlCharsMax + 1) },
    { ...message, attempt: 'other' },
    { ...message, box: { ...message.box, width: 0 } },
    { ...message, box: { ...message.box, height: Number.NaN } },
    { ...message, box: { ...message.box, left: PREVIEW_SNAPSHOT_LIMITS.boxPixelsMax + 1 } },
    { ...message, box: 'x' },
  ];
  for (const input of bad) {
    assert.equal(parsePreviewSnapshotMessage(input), undefined, JSON.stringify(input)?.slice(0, 60));
  }
  assert.deepEqual(parsePreviewUnchangedMessage({ type: 'avb:component-preview-unchanged', key: message.key }), { key: message.key });
  assert.equal(parsePreviewUnchangedMessage({ type: 'avb:component-preview-unchanged', key: 'x' }), undefined);
});

test('fit shrinks, never enlarges, and centres', () => {
  const small = fitSnapshot({ left: 0, top: 0, width: 50, height: 20 }, { width: 200, height: 120 });
  assert.equal(small.scale, 1);
  assert.equal(small.x, SNAPSHOT_TILE_PADDING + (176 - 50) / 2);
  const wide = fitSnapshot({ left: 0, top: 0, width: 1200, height: 100 }, { width: 224, height: 140 });
  assert.equal(wide.scale, 200 / 1200);
  assert.throws(() => fitSnapshot({ left: 0, top: 0, width: 0, height: 5 }, { width: 10, height: 10 }), /has width/);
});
