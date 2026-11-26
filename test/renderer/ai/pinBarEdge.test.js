// Goal: the floating comment pins pill keeps its faded edge, so it does not blend into a dark page behind it (the owner's
// one exception to fills-not-borders), and the edge moves nothing: edge and padding add up to the 4px the pill's contents
// have always stood in from its 36px box.
// Method: read the pill's own rule from pins.css and check the edge's token, the corners and the sum.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

test('the pill has a faded theme edge that shifts nothing', () => {
  const css = fs.readFileSync(repoPath('src/features/ai/pins/pins.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\n\.ai-pin-bar \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(rule !== undefined, 'the pill has its rule');
  const edge = /\bborder: (\d+)px solid var\(--border-strong\);/.exec(rule);
  const padding = /\bpadding: (\d+)px;/.exec(rule);
  assert.ok(edge !== null, 'a theme token edge');
  assert.ok(padding !== null, 'one padding');
  assert.equal(Number(edge[1]) + Number(padding[1]), 4);
  assert.match(rule, /box-sizing: border-box;/);
  assert.match(rule, /border-radius: 10px;/, 'the edge follows the corners');
});
