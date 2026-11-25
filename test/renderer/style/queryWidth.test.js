// The canvas width a picked media query asks for.
//
//   node test/renderer/style/queryWidth.test.js
//
// Goal: canvasWidthForQuery turns a context's query into a canvas width just
// inside it, by one rule per bound (model/queryWidth.ts): `<` the whole pixel
// below, `<=` and `max-width` the bound, `>` the whole pixel above, `>=` and
// `min-width` the bound, and a range its upper bound. `rem` is read at the root
// font size given. Everything it cannot read for certain leaves the canvas alone.
//
// Method: the pure function on each form, the rem conversion at two root sizes,
// and every case it must ignore, each with its stated reason.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { canvasWidthForQuery } = load('src/features/style/model/queryWidth.ts');
const width = (query, root = 16) => canvasWidthForQuery(query, root);
const px = (widthPx) => ({ kind: 'width', widthPx });
const none = (reason) => ({ kind: 'none', reason });

// Each form:
assert.deepEqual(width('@media (width < 800px)'), px(799), '`<`: the pixel below');
assert.deepEqual(width('@media (width <= 800px)'), px(800), '`<=`: the bound');
assert.deepEqual(width('@media (max-width: 800px)'), px(800), '`max-width`: the bound');
assert.deepEqual(width('@media (width > 800px)'), px(801), '`>`: the pixel above');
assert.deepEqual(width('@media (width >= 800px)'), px(800), '`>=`: the bound');
assert.deepEqual(width('@media (min-width: 800px)'), px(800), '`min-width`: the bound');
assert.deepEqual(width('@media (800px < width)'), px(801), 'reversed `<` reads as `>`');
assert.deepEqual(width('@media (800px >= width)'), px(800), 'reversed `>=` reads as `<=`');
assert.deepEqual(width('@media (40rem < width < 50rem)'), px(799), 'a range: just inside its upper bound');
assert.deepEqual(width('@media (40rem <= width <= 50rem)'), px(800), 'an inclusive range: its upper bound');
assert.deepEqual(width('@media (min-width: 640px) and (max-width: 900px)'), px(900), 'two conditions: the upper bound');
assert.deepEqual(width('@media screen and (max-width: 767px)'), px(767), 'a media type in front is fine');
assert.deepEqual(width('@media only screen and (width < 50rem)'), px(799), 'and `only` too');
assert.deepEqual(width('@media (width < 800.5px)'), px(800), 'a fractional `<` bound: the largest whole pixel below it');
assert.deepEqual(width('@media (width > 800.5px)'), px(801), 'a fractional `>` bound: the smallest whole pixel above it');
assert.deepEqual(width('@container card (width > 1px) › @media (width < 50rem)'), px(799), 'a chain is read by its last link');

// The rem conversion:
assert.deepEqual(width('@media (width < 50rem)', 16), px(799), '50rem at 16px is 800px; just inside is 799');
assert.deepEqual(width('@media (width < 50rem)', 10), px(499), '50rem at 10px is 500px');
assert.deepEqual(width('@media (min-width: 42rem)', 16), px(672), '42rem at 16px');

// What is ignored:
assert.deepEqual(width('@media (width < 50em)'), none('unit'), 'em is not read');
assert.deepEqual(width('@media (width < 80vw)'), none('unit'), 'nor vw');
assert.deepEqual(width('@media (height < 600px)'), none('no-width'), 'height is not width');
assert.deepEqual(width('@media (orientation: portrait)'), none('no-width'), 'nor orientation');
assert.deepEqual(width('@media (hover: hover)'), none('no-width'), 'nor hover');
assert.deepEqual(width('@media print'), none('unparsed'), 'a bare media type has no width');
assert.deepEqual(width('@container (width < 50rem)'), none('not-media'), 'a container query follows its container');
assert.deepEqual(width('@supports (display: grid)'), none('not-media'), 'a supports query has no width');
assert.deepEqual(width('@media (width < 50rem), print'), none('unparsed'), 'a list of queries is not one width');
assert.deepEqual(width('@media (width < 30rem) or (width > 60rem)'), none('unparsed'), '`or` is not one width');
assert.deepEqual(width('@media not (width < 50rem)'), none('unparsed'), 'nor is `not`');
assert.deepEqual(width('@media (width < calc(50rem - 1px))'), none('unparsed'), 'calc is not read');
assert.deepEqual(width('@media (60rem < width < 40rem)'), none('no-width'), 'a range holding no pixel');
assert.deepEqual(width('@media (width < 10px)'), none('unparsed'), 'a width below the canvas minimum');
assert.deepEqual(width('@media (min-width: 9000px)'), none('unparsed'), 'or above its maximum');
assert.deepEqual(width(''), none('not-media'), 'Base has no query');
assert.throws(() => width('@media (width < 1px)', 0), /a root font size is positive/, 'a root font size must be positive');

console.log('query-width: passed');
