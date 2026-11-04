// Which link-type tab an href opens on.
//
//   node test/renderer/props/linkType.test.js
//
// The href field has a row of tabs (URL, Page, Anchor, Email, Phone, Asset),
// and the value alone decides which one it opens on. The bug this holds shut:
// `href="#"` opened on the Anchor tab, which then had nothing to offer. A
// fragment is an anchor only when an element on the page carries that exact
// id; HTML ids are case-sensitive, so `#T` is not `id="t"`. The suite bundles
// the pure detector and walks every rule, then the limits it asserts.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'link-type.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/props/linkType.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { anchorTargetExists, detectLinkType } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);

  const context = { routes: ['/', '/about', '/blog/post'], sectionIds: ['t', 'pricing', 'Hero'] };
  const opens = (text, expected, why) => {
    const actual = detectLinkType(text, context);
    check(`${why}: ${JSON.stringify(text)} opens on ${expected}`, actual === expected, `got ${actual}`);
  };

  // --- the default ---------------------------------------------------------------
  opens('', 'url', 'an empty value');

  // --- fragments -----------------------------------------------------------------
  opens('#', 'url', 'a bare hash');
  opens('#missing', 'url', 'a fragment no element answers to');
  opens('#t', 'section', 'a fragment matching an id');
  opens('#pricing', 'section', 'another matching id');
  opens('#T', 'url', 'ids are case-sensitive: #T is not id="t"');
  opens('#hero', 'url', 'nor is #hero id="Hero"');
  opens('#Hero', 'section', 'the exact case matches');
  opens('# t', 'url', 'a space is part of the fragment');
  check('a page without ids has no anchors', detectLinkType('#t', { routes: [], sectionIds: [] }) === 'url');

  // --- pages, email, phone, assets, the rest ----------------------------------------
  opens('/about', 'page', 'a route the project has');
  opens('/', 'page', 'the home route');
  opens('/nowhere', 'url', 'a path the project has no page for');
  opens('mailto:bob@example.com', 'email', 'a mailto link');
  opens('tel:+14155551212', 'phone', 'a tel link');
  opens('/files/brochure.pdf', 'asset', 'a path to a file');
  opens('https://example.com', 'url', 'an absolute URL');
  opens('https://example.com/#t', 'url', 'an absolute URL with a matching fragment');
  opens('about', 'url', 'a relative word');

  // --- the anchor helper the Anchor tab's dropdown shares ------------------------------
  check('anchor: matching id', anchorTargetExists('#t', ['t']) === true);
  check('anchor: bare hash', anchorTargetExists('#', ['t', '']) === false);
  check('anchor: wrong case', anchorTargetExists('#T', ['t']) === false);
  check('anchor: no hash', anchorTargetExists('t', ['t']) === false);

  // --- limits are asserted, with their messages -----------------------------------------
  const throws = (what, run, message) => {
    try {
      run();
      check(what, false, 'did not throw');
    } catch (error) {
      check(what, String(error).includes(message), String(error));
    }
  };
  throws('too many routes', () => detectLinkType('/', { routes: new Array(10_001).fill('/'), sectionIds: [] }), 'detectLinkType: route limit exceeded');
  throws('too many ids', () => detectLinkType('#a', { routes: [], sectionIds: new Array(20_001).fill('a') }), 'detectLinkType: section limit exceeded');

  if (failures.length) {
    console.error(`\nlink-type: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`link-type: ${checked} passed  [which tab an href opens on]`);
})();
