// Goal: a plain HTML page becomes an Astro page that renders the same document. Every place Astro reads
// HTML differently is handled (braces in text, capitalised tags, bare scripts, scoped styles, slots, a
// leading `---`), and nothing else is touched: comments, CDATA, quoted attributes and raw-text elements stay
// byte for byte.
// Method: a table of inputs with their exact expected output, then every output (and a whole realistic
// page) compiled by the installed @astrojs/compiler. A compiled page must hold no expression, component,
// slot or bundled script that came from the HTML: Astro's own helpers are the only `${…}` in its template.
// Negative space: text that only looks like markup (`a < b`), unterminated tags and comments, JSON scripts
// and SVG/template styles, which must all come through unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from '@astrojs/compiler';
import { htmlToAstro } from '#dist/electron/project/htmlToAstro.js';

const CASES: readonly (readonly [string, string, string])[] = [
  ['braces in text become character references', '<p>a {b} c}</p>', '<p>a &#123;b&#125; c&#125;</p>'],
  [
    'braces in pre, title, textarea and noscript too',
    '<pre>{x}</pre><title>{t}</title><textarea>{z}</textarea><noscript>{n}</noscript>',
    '<pre>&#123;x&#125;</pre><title>&#123;t&#125;</title><textarea>&#123;z&#125;</textarea><noscript>&#123;n&#125;</noscript>',
  ],
  ['comments and CDATA are literal', '<!-- {x} --><svg><![CDATA[ {y} ]]></svg>', '<!-- {x} --><svg><![CDATA[ {y} ]]></svg>'],
  ['quoted attribute values are literal', '<div x-data="{ open: false }" title=\'{a}\'>x</div>', '<div x-data="{ open: false }" title=\'{a}\'>x</div>'],
  ['an unquoted braced value gets quotes', '<div data-x={a} data-y=b>x</div>', '<div data-x="{a}" data-y=b>x</div>'],
  ['an unquoted value with a double quote gets single quotes', '<div data-x={a"b}>x</div>', "<div data-x='{a\"b}'>x</div>"],
  [
    'raw-text elements are left alone',
    '<xmp>{a}</xmp><iframe>{b}</iframe><noembed>{c}</noembed><noframes>{d}</noframes>',
    '<xmp>{a}</xmp><iframe>{b}</iframe><noembed>{c}</noembed><noframes>{d}</noframes>',
  ],
  ['a bare script is kept inline', '<script>if (a) { b(); }</script>', '<script is:inline>if (a) { b(); }</script>'],
  ['a module script and a script with src too', '<script type="module" src="js/app.js"></script>', '<script is:inline type="module" src="js/app.js"></script>'],
  ['a script that is already inline is untouched', '<script is:inline>a()</script>', '<script is:inline>a()</script>'],
  [
    'JSON scripts are left alone',
    '<script type="application/ld+json">{"a":1}</script><script type="importmap">{}</script>',
    '<script type="application/ld+json">{"a":1}</script><script type="importmap">{}</script>',
  ],
  [
    'a script holding a fake end tag ends at the real one',
    '<script>var s = "</scr" + "ipt>"; if(a){}</script><p>{x}</p>',
    '<script is:inline>var s = "</scr" + "ipt>"; if(a){}</script><p>&#123;x&#125;</p>',
  ],
  ['a style stays global', '<style>.a { color: red }</style>', '<style is:global>.a { color: red }</style>'],
  ['a style with @import stays inline', '<style>@import url("css/x.css"); .a{}</style>', '<style is:inline>@import url("css/x.css"); .a{}</style>'],
  [
    'styles inside svg and template are left alone',
    '<svg><style>.a{}</style></svg><template><style>.b{}</style><script>c()</script></template>',
    '<svg><style>.a{}</style></svg><template><style>.b{}</style><script is:inline>c()</script></template>',
  ],
  ['after </svg> a style is global again', '<svg><g/></svg><style>.a{}</style>', '<svg><g/></svg><style is:global>.a{}</style>'],
  ['a slot stays the web-component slot', '<template><slot name="x"></slot></template>', '<template><slot is:inline name="x"></slot></template>'],
  [
    'capitalised tags are lowercased, camelCase SVG is kept',
    '<DIV CLASS="a"><Svg><linearGradient/></Svg></DIV>',
    '<div CLASS="a"><svg><linearGradient/></svg></div>',
  ],
  ['a capitalised SCRIPT is a script', '<SCRIPT>a()</SCRIPT >', '<script is:inline>a()</script >'],
  ['a page that starts with --- gets an empty frontmatter first', '---\n<p>x</p>', '---\n---\n---\n<p>x</p>'],
  ['so does one with leading space and a byte-order mark', '﻿\n  ---<p>x</p>', '---\n---\n\n  ---<p>x</p>'],
  [
    'a doctype and html stay',
    '<!DOCTYPE html>\n<html lang="en"><head></head><body></body></html>',
    '<!DOCTYPE html>\n<html lang="en"><head></head><body></body></html>',
  ],
  ['text that only looks like markup is text', '<p>a < b && c > d</p><p>1 <2</p>', '<p>a < b && c > d</p><p>1 <2</p>'],
  ['an unterminated comment is closed where the file ends, as a browser reads it', '<p>{a}</p><!-- {b}', '<p>&#123;a&#125;</p><!-- {b} -->'],
  ['an unterminated script is closed where the file ends', '<p>x</p><script>if(a){', '<p>x</p><script is:inline>if(a){</script>'],
  ['an unterminated tag is closed', '<p>{a}</p><img src="x.png"', '<p>&#123;a&#125;</p><img src="x.png">'],
  ['self-closing and void tags keep their shape', '<br/><img src=x.png /><input disabled>', '<br/><img src=x.png /><input disabled>'],
  ['unicode and emoji text is kept', '<p>Café — 東京 🎉 {x}</p>', '<p>Café — 東京 🎉 &#123;x&#125;</p>'],
];

test('each construct converts to exactly the expected text', () => {
  for (const [what, input, expected] of CASES) {
    assert.equal(htmlToAstro(input).text, expected, what);
  }
});

test('the changes are counted', () => {
  const { changes } = htmlToAstro(
    '---\n<DIV>{a}</DIV><script></script><style></style><style>@import "a";</style><template><slot></slot></template><p x={y}></p>',
  );
  assert.deepEqual(changes, {
    bracesEscaped: 2,
    scriptsInlined: 1,
    stylesGlobal: 1,
    stylesInlined: 1,
    slotsInlined: 1,
    tagsLowercased: 2,
    attributesQuoted: 1,
    frontmatterAdded: true,
  });
  assert.deepEqual(htmlToAstro('<p>plain</p>').changes.frontmatterAdded, false);
});

test('converting twice changes nothing more: the output is already an Astro page', () => {
  for (const [what, input] of CASES) {
    const once = htmlToAstro(input).text;
    const twice = htmlToAstro(once).text;
    // A page that opens with the empty frontmatter gains another in front, which Astro reads as the
    // frontmatter, leaving the first pair as text: it is the one case a second pass adds anything.
    assert.equal(twice, once.startsWith('---\n---\n') ? `---\n---\n${once}` : once, what);
  }
});

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Shop {beta}</title>
  <link rel="stylesheet" href="css/site.css">
  <style>.hero { background: url(img/hero.jpg) }</style>
  <script type="application/ld+json">{"@type": "Organization"}</script>
</head>
<BODY>
  <!-- {not an expression} -->
  <div x-data="{ open: false }" data-config={a:1}>Prices from {9}</div>
  <pre>function a() { return {}; }</pre>
  <svg viewBox="0 0 10 10"><style>.s{fill:red}</style><linearGradient id="g"/></svg>
  <template id="card"><style>.c{}</style><slot name="title"></slot></template>
  <script src="js/app.js"></script>
  <script type="module">import { a } from './js/a.js'; if (a) { a(); }</script>
</BODY>
</html>
`;

interface Diagnostic {
  readonly severity: number;
  readonly text: string;
}

// The template the compiled page renders (its imports name every helper, used or not), and its errors.
async function compiled(source: string): Promise<{ readonly code: string; readonly errors: readonly Diagnostic[] }> {
  const result = await transform(source, { filename: '/site/src/pages/index.astro' });
  const template = /return \$\$render`([\s\S]*)`;\n\}, '/.exec(result.code)?.[1];
  assert.notEqual(template, undefined, 'the compiled page renders a template');
  // Severity 1 is an error; hints (4) about JSON scripts being inline are expected.
  return { code: template ?? '', errors: result.diagnostics.filter((diagnostic: Diagnostic) => diagnostic.severity === 1) };
}

// The template Astro renders, with its own helpers taken out: what is left came from the page.
function pageExpressions(code: string): readonly string[] {
  return [...code.matchAll(/\$\{(?!\$\$)([^}]*)\}/g)].map((match) => match[0]);
}

test('every converted case and a whole page compile with no expression, component, slot or bundled script from the HTML', async () => {
  for (const [what, input] of [...CASES, ['a realistic page', PAGE, '']] as const) {
    const { code, errors } = await compiled(htmlToAstro(input).text);
    assert.deepEqual(errors, [], what);
    assert.deepEqual(pageExpressions(code), [], what);
    assert.doesNotMatch(code, /\$\$renderComponent/, what);
    assert.doesNotMatch(code, /\$\$renderSlot/, what);
    assert.doesNotMatch(code, /\$\$renderScript/, what);
  }
});

test('the same page unconverted is read differently, so each rule is needed', async () => {
  const { code } = await compiled(PAGE);
  assert.ok(pageExpressions(code).length > 0, 'braces in text become expressions');
  assert.match(code, /\$\$renderComponent/, 'a capitalised tag becomes a component');
  assert.match(code, /\$\$renderSlot/, 'a slot becomes an Astro slot');
  assert.match(code, /\$\$renderScript/, 'a bare script is bundled');
  const fenced = await compiled('---\n<p>x</p>');
  assert.equal(fenced.code, '', 'a leading --- swallows the page as frontmatter');
});
