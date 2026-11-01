// Nothing this puts on a page is a child of anything.
//
//   node test/electron/previewServer/commentMarkers.test.js
//
// CSS is written for the children a component is given — `> :last-child`,
// `:nth-child(2)`, `& > * + *` — so a preview that adds one child has changed
// the page it is previewing. Nothing here may be a node the page can count.
//
// A marker has one job — to say which node is which on the canvas — and one
// rule about how it does it: it must not be a thing the page can see. A comment
// is invisible to :nth-child, :first-child, + and ~, to layout, and to the box
// model, so a marked page renders as the real build renders.
//
// Two places had gone on writing elements instead.
//
//   a slotted node    Its markers have to carry the same `slot` or they land in
//                     the default slot while the node renders in the named one.
//                     An attribute needs something to sit on, and that was a
//                     <template> — an element, in the page, between the slot's
//                     real children, until the canvas takes it out again. A
//                     <Fragment slot="…" set:html> carries the attribute and
//                     renders no element: the slot gets a comment and the node.
//   a markdown block  Every paragraph, heading and list was wrapped in a
//                     <template> pair — the original approach, never revisited
//                     when the .astro side moved to comments.
//
// A <Fragment slot="…"> can hold no attribute at all — it puts no element on the
// page and takes no props — so its markers ride INSIDE it, where the Fragment's
// own contents take them into the slot. Two comments, no node.
//
// And the patcher that replaces a full reload used to be a <script> appended to
// each page. A script is display:none, so it looked free; it is still a child,
// and a page rendered into a layout's slot handed that slot one extra one. It
// goes in through Astro's own injectScript now — the page's module graph, which
// is where it wanted to be anyway, and which puts nothing in the markup.
//
// What is left on an element is `data-avb-p`, an attribute, which is the one
// carrier that changes nothing: :nth-child, :last-child, `+`, `~` and `> *` all
// read the same page with it as without. It is there because a component that
// renders a slot to a string and strips the comments out — the ordinary way to
// ask whether a slot rendered anything — takes every marker in that slot with
// them, and something has to survive that.
//
// On one real page: fifty-six element markers, one cleanup script and one
// patcher tag became none of any, with every one of the 1267 comment markers
// unchanged.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const { parsePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');
const { repoPath } = require('../../helpers/sources.js');
const { readFolderSource, readSource, readSourceGroup } = require('../../helpers/sourceText.js');

const marked = (body, frontmatter = 'import Split from "./Split.astro";\nimport Img from "./Img.astro";') =>
  serializePageMarked(parsePage(`---\n${frontmatter}\n---\n${body}\n`).model, '');

(async () => {
  // --- nothing the page can see -------------------------------------------------
  {
    const out = marked(`<Split>
  <p>Left</p>
  <Img slot="column2" src="/a.png" />
  <span slot="caption">Hi</span>
</Split>`);
    check('nothing here is marked with an element', !/<template/.test(out), out);
    check(
      'a node in a named slot is marked with a comment that travels with it',
      /<Fragment slot="column2" set:html=\{"<!--avb-s:0\.1-->"\} \/>/.test(out),
      out,
    );
    check('and closed the same way', /<Fragment slot="column2" set:html=\{"<!--avb-e:0\.1-->"\} \/>/.test(out), out);
    check('the marker carries the slot the node is in, not another one', !/<Fragment slot="caption"/.test(out), out);
    // A slotted ELEMENT needs no marker node at all: it wears its path.
    check('a slotted element is still tagged in place', /<span slot="caption" data-avb-p="0\.2">/.test(out), out);
    check('with no marker written beside it', !/avb-s:0\.2/.test(out), out);
    // Ordinary slot content still gets the Fragment form, for the same reason
    // it always did: Astro drops a plain comment there.
    check('slot content keeps its comment in a Fragment', /<Fragment set:html=\{"<!--avb-s:0\.0-->"\} \/>/.test(out), out);
    check('and the page around it is plain comments', /^<!--avb-s:0-->$/m.test(out), out);
  }
  {
    // The node that can hold no attribute of its own — a <Fragment slot="…">
    // puts nothing on the page and takes no props — carries its markers INSIDE
    // itself, where they travel into the slot with its own contents. Nothing
    // lands in that slot but two comments and what was written there.
    const out = marked(`<Split>
  <Fragment slot="links">
    <div class="a">A</div>
  </Fragment>
  <Img slot="hero" src="/h.png" />
</Split>`);
    check('a slotted Fragment adds no element', !/<template/.test(out), out);
    check('its markers ride inside it', /<Fragment slot="links">\n\s*<Fragment set:html=\{"<!--avb-s:0\.0-->"\} \/>/.test(out), out);
    check('and close inside it', /<Fragment set:html=\{"<!--avb-e:0\.0-->"\} \/>\n\s*<\/Fragment>/.test(out), out);
    check('while the component beside it is marked with a comment', /<Fragment slot="hero" set:html=\{"<!--avb-s:0\.1-->"\} \/>/.test(out), out);
    check('and carries its path as well, which is what survives a scrubbed slot', /<Img slot="hero" src="\/h\.png" data-avb-p="0\.1" \/>/.test(out), out);
    // A project reads a slot by rendering it to a string and stripping the
    // comments — that is how it asks whether the slot rendered anything — and
    // the marker goes with them. What the node is addressed by then is the
    // attribute, so the comment form is only ever the better of two answers,
    // never the only one.
    check('a slotted component is addressable either way', /data-avb-p="0\.1"/.test(out) && /avb-s:0\.1/.test(out), out);
  }

  {
    // A file whose own ROOT goes into a parent's named slot — how a component
    // says "I am the aside". Nothing above it in this file makes it slot
    // content, so the marker has to take the slot from the node itself.
    const out = serializePageMarked(
      parsePage('---\nimport Card from "./Card.astro";\n---\n<Card slot="aside" title="Hi" />\n').model,
      'src/components/Side.astro|',
    );
    check('a slotted root is marked into its slot', /<Fragment slot="aside" set:html=\{"<!--avb-s:src\/components\/Side\.astro\|0-->"\} \/>/.test(out), out);
    check('and not into the default one', !/<Fragment set:html/.test(out), out);
  }

  // --- the compilers are the only thing that can say it is real -------------------
  {
    const out = marked(`<Split>
  <Img slot="column2" src="/a.png" />
</Split>`);
    for (const [label, mod] of [
      ['@astrojs/compiler-rs (Astro 7+)', '@astrojs/compiler-rs'],
      ['@astrojs/compiler (Astro ≤6)', '@astrojs/compiler'],
    ]) {
      let error;
      let code = '';
      try {
        const { transform } = require(mod);
        code = (await transform(out, { filename: 'Page.astro' })).code || '';
      } catch (caught) {
        error = String(caught?.message || caught);
      }
      check(`a slotted marker compiles — ${label}`, error === undefined, error);
      check(`and keeps the slot on it — ${label}`, /column2/.test(code) && /avb-s:0\.0/.test(code), code.slice(0, 400));
    }
  }

  // --- the patcher, which was the other node in the page ---------------------------
  //
  // Written with `is:inline`, a <script> stays exactly where it was put: at the
  // end of the page's own markup, which for a page inside a layout is inside
  // that layout's slot. display:none costs no layout and is still a child.
  // Written as a script Astro may process, it is hoisted into <head> and the
  // markup keeps nothing. Astro's compiler is the one that decides this, so it
  // is the one asked.
  {
    const { transform } = require('@astrojs/compiler-rs');
    const hoisted = await transform("---\n---\n<div>hi</div>\n<script>import 'virtual:avb-morph';</script>\n", { filename: 'P.astro' });
    check('the patcher is hoisted out of the page', (hoisted.scripts || []).length === 1, JSON.stringify(hoisted.scripts));
    check('and leaves no tag in the markup', !/<script/.test(hoisted.code), 'a script tag is still rendered into the page');
    check(
      'and it is still the module it has to be',
      /import "virtual:avb-morph"/.test((hoisted.scripts || [])[0]?.code || ''),
      JSON.stringify((hoisted.scripts || [])[0]),
    );
    // The form it used to have, for the same compiler to describe.
    const inline = await transform('---\n---\n<div>hi</div>\n<script is:inline src="/x.js"></script>\n', { filename: 'P.astro' });
    check(
      'the old form is exactly what it looked like',
      (inline.scripts || []).length === 0 && /<script/.test(inline.code),
      'is:inline no longer leaves a tag',
    );
    // And what the dev config now writes.
    const main = readSource('electron/handlers/devServers.ts');
    check(
      'the dev config writes the hoistable form',
      new RegExp(/const MORPH_TAG_HTML = MORPH_CLIENT \? "<script/.source + />import 'virtual:avb-morph';<\/script>" : '';/.source).test(main),
      'the patcher is written some other way',
    );
  }

  // --- markdown blocks ------------------------------------------------------------
  {
    // Everything that writes the dev config: the config's parts, and the code
    // that assembles and writes them.
    const main = readSourceGroup(['electron/preview/markerConfig.ts', 'electron/handlers/devServers.ts', 'electron/main.ts']);
    check(
      'a markdown block is marked with comments',
      /insertBefore\(node, \{ type: 'html', value: '<!--avb-s:' \+ path \+ '-->' \}\)/.test(main),
      'markdown still wraps every block in an element',
    );
    check(
      'and closed with one',
      /insertAfter\(node, \{ type: 'html', value: '<!--avb-e:' \+ path \+ '-->' \}\)/.test(main),
      'markdown still wraps every block in an element',
    );
    check('nothing in the dev config writes a template marker', !/<template data-avb/.test(main), 'a template marker is still written');
    // Nothing is added to a page, so nothing has to be taken back out of it.
    check('no cleanup script is injected', !/AVB_CLEANUP/.test(main), 'the cleanup script is still there');
    check(
      'and nothing but the patcher rides along with a page',
      /return marked\.page \? marked\.code \+ AVB_MORPH_TAG : marked\.code;/.test(main),
      'something else is appended to the page',
    );
  }

  // --- the canvas still reads what it is served ------------------------------------
  {
    const preload = readFolderSource('electron/preload');
    check('a comment is a marker', /if \(isComment\(node\)\) \{[\s\S]*?avb-\$\{kind\}:/.test(preload), 'the collector cannot read a comment marker');
    check(
      'and a template still is too, for a page served before this update',
      new RegExp(String.raw`node\.tagName === 'TEMPLATE'\) \{[\s\S]*?` + String.raw`return node\.getAttribute\(\`data-avb-\$\{kind\}\`\)`).test(preload),
      'a running dev server would go blank on update',
    );
  }

  if (failures.length) {
    console.error(`\ncomment-markers: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`comment-markers: ${checked} passed  [nothing added is a child]`);
})();
