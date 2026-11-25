// What switching the canvas device does to the style panel's context.
//
//   node test/renderer/style/deviceContext.test.js
//
// Goal: switching the canvas to desktop takes an `@media` context, top-level or
// nested inside a rule, back to Base; a container query, `@supports`, Base and
// the interaction state stay as they are; the other devices change nothing.
//
// Method: contextAfterDevice on contexts shaped like the panel's StyleContext,
// one per case, plus the parsing helpers it rests on and the assertion on an
// at-context that names no query.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { contextAfterDevice, contextQueryOf, deviceTargetOf } = load('src/features/style/model/deviceContext.ts');

const context = (key, extra = {}) => ({ key, breakpoint: undefined, embedAtContext: key, ...extra });
const DESKTOP = deviceTargetOf('desktop');
const KEEP = { kind: 'keep' };
const BASE = { kind: 'base' };

assert.deepEqual(DESKTOP, { kind: 'desktop' }, 'desktop parses as desktop');
assert.deepEqual(deviceTargetOf('phone'), { kind: 'other', device: 'phone' }, 'any other device is other');

// Desktop.
assert.deepEqual(contextAfterDevice(context('@media (width < 42rem)'), DESKTOP), BASE, '@media goes back to Base');
// A query nested inside `.developer_layout` has the same key as a top-level one:
// the key is the at-rule chain, and the wrapping selector is not part of it.
assert.deepEqual(contextAfterDevice(context('@media (width < 42rem)'), DESKTOP), BASE, 'a nested @media goes back to Base');
assert.deepEqual(contextAfterDevice(context('@MEDIA print'), DESKTOP), BASE, 'the at-name is matched without case');
assert.deepEqual(contextAfterDevice(context('@container (width > 40em) › @media (width < 42rem)'), DESKTOP), BASE, 'a chain ending in @media');
assert.deepEqual(contextAfterDevice(context('@container (width > 40em)'), DESKTOP), KEEP, '@container stays');
assert.deepEqual(contextAfterDevice(context('@media (width < 42rem) › @container card (width > 1px)'), DESKTOP), KEEP, 'a chain ending in @container stays');
assert.deepEqual(contextAfterDevice(context('@supports (display: grid)'), DESKTOP), KEEP, '@supports stays');
assert.deepEqual(contextAfterDevice(context(''), DESKTOP), KEEP, 'Base stays Base');
assert.deepEqual(
  contextAfterDevice({ key: 'bp:small', breakpoint: 'small', embedAtContext: '@media (max-width: 767px)' }, DESKTOP),
  BASE,
  'a breakpoint row is @media',
);
assert.deepEqual(contextAfterDevice({ key: 'bp:small', breakpoint: 'small', embedAtContext: undefined }, DESKTOP), BASE, 'so is a native-only one');
assert.deepEqual(contextAfterDevice({ key: 'odd', breakpoint: undefined, embedAtContext: undefined }, DESKTOP), KEEP, 'a context with no query stays');

// The interaction state (`:hover`) is not a context: the decision takes none and
// so cannot change it. Base viewed in :hover is still Base, and stays.
assert.equal(contextAfterDevice.length, 2, 'the decision reads the context and the device only');

// Other devices change nothing, whatever the context.
for (const device of ['tablet', 'phone', 'canvas', 'custom']) {
  for (const key of ['', '@media (width < 42rem)', '@container (width > 40em)']) {
    assert.deepEqual(contextAfterDevice(context(key), deviceTargetOf(device)), KEEP, `${device} leaves ${key || 'Base'} alone`);
  }
}

// The query kind, on its own.
assert.deepEqual(contextQueryOf(context('')), { kind: 'base' });
assert.deepEqual(contextQueryOf(context('@media screen')), { kind: 'media' });
assert.deepEqual(contextQueryOf(context('@mediaish x')), { kind: 'other' }, 'a prefix is not the at-name');
assert.throws(() => contextQueryOf(context('@media x ›  ')), /an at-context names a query/, 'an empty last link is a programmer error');

console.log('device-context: passed');
