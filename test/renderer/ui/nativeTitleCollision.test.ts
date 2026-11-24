// Goal: no element in the app shows the browser's native tooltip on the same pointer rest as one of the app's own tips. The
// Audits settings rows had `title={name}` on the whole label, and Chromium titles every descendant of a titled element, so
// hovering the (i) mark drew the native "Unlabelled icon button" box over the app's explanation tip.
// Method: test/helpers/nativeTitleScan.ts parses every .tsx file under src and studio/src and reports a DOM element with a
// non-empty `title` that contains a custom-tip component (InfoHint, InfoLabel, TipAnchor, TipButton, Tooltip) in its JSX, or
// sits directly inside a TipAnchor. There is no allowlist: a collision is always a bug, because two tips at once is never the
// intent. Negative space: the scanner itself is run on known-bad and known-good snippets, including `title=""` (the blank that
// stops inheritance) and a component's `title` prop (a heading, not a native title). The runtime half, the tip components
// blanking an inherited title, is held by tipTriggerTitle.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanRepository, scanText } from '../../helpers/nativeTitleScan.ts';

// The runner starts every suite at the repository root.
const REPOSITORY = process.cwd();

test('no native title collides with a custom tooltip in src or studio/src', () => {
  const collisions = scanRepository(REPOSITORY, ['src', 'studio/src']);
  const lines = collisions.map((collision) => `${collision.file}:${collision.line} <${collision.tag}> ${collision.reason}`);
  assert.deepEqual(lines, [], 'move the title onto the text alone, or drop it: the custom tip already explains the control');
});

test('the scanner reports a titled element that contains an InfoHint', () => {
  const found = scanText('a.tsx', 'const a = <span title={name}>{name}<InfoHint text="why" /></span>;');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.tag, 'span');
  assert.equal(found[0]?.reason, 'contains-custom-tip');
  assert.equal(found[0]?.line, 1);
});

test('the scanner reports a custom tip nested deeper inside the titled element', () => {
  const found = scanText('a.tsx', 'const a = <div title="Row"><span><TipButton label="x" onClick={f}>i</TipButton></span></div>;');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.tag, 'div');
});

test('the scanner reports a titled control directly inside a TipAnchor', () => {
  const found = scanText('a.tsx', 'const a = <TipAnchor text="Off because"><button title="Save">Save</button></TipAnchor>;');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.tag, 'button');
  assert.equal(found[0]?.reason, 'inside-tip-anchor');
});

test('the scanner accepts a title on the text beside the tip, an empty title, and a heading prop', () => {
  assert.deepEqual(scanText('a.tsx', 'const a = <span><span title={name}>{name}</span><InfoHint text="why" /></span>;'), []);
  assert.deepEqual(scanText('a.tsx', 'const a = <span title="">{name}<InfoHint text="why" /></span>;'), []);
  assert.deepEqual(scanText('a.tsx', 'const a = <Section title="Checks"><InfoHint text="why" /></Section>;'), []);
  assert.deepEqual(scanText('a.tsx', 'const a = <button title="Close">x</button>;'), []);
});
