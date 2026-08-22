// Characters in the panel, spelling in the file.
//
//   node test/html-text.js
//
// `<p class="footer_copyright">&copy;<span>2026</span>&#160;{SITE_NAME}</p>`
// renders as "© 2026 Remarkable". The navigator drew the row as `&copy;` and
// the Content field offered `&#160;` to edit — the source's spelling of a
// character rather than the character. An editor over a rendered page has to
// say what the page says.
//
// Which opens the other half of it. Decode on the way in and the file gets
// rewritten on the way out: every `&copy;` in the project turned into `©` the
// next time anything on that page was saved — a diff on a file that was only
// opened. So a text node holds the CHARACTERS, and the file keeps its own
// SPELLING: untouched, it goes back exactly as it was found; edited, the
// characters are what there is, and the three that would otherwise be markup
// become entities again.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { decodeEntities, encodeText } = require('../electron/htmlText.js');
const { parsePage, serializePage } = require('../electron/astroParser.js');

// ── Reading ─────────────────────────────────────────────────────────────────
const reads = (raw, want) =>
  check(`${raw} reads as ${JSON.stringify(want)}`, decodeEntities(raw) === want, JSON.stringify(decodeEntities(raw)));
reads('&copy;', '©');
reads('&#160;', ' ');
reads('&#xA9;', '©');
reads('&amp;', '&');
reads('a &lt; b &gt; c', 'a < b > c');
reads('Let&rsquo;s go', 'Let’s go');
reads('caf&eacute;', 'café');
reads('&copy; 2026 &mdash; Remarkable', '© 2026 — Remarkable');
// A name this doesn't know is still valid HTML; rewriting it as itself is
// better than mangling it into something else.
reads('&unknowable;', '&unknowable;');
reads('&#x110000;', '&#x110000;'); // past the last code point
reads('plain words', 'plain words');
reads('a & b', 'a & b'); // a bare ampersand is not an entity

// ── Writing ─────────────────────────────────────────────────────────────────
const writes = (chars, want) =>
  check(`${JSON.stringify(chars)} writes as ${want}`, encodeText(chars) === want, JSON.stringify(encodeText(chars)));
writes('a & b', 'a &amp; b');
writes('a < b', 'a &lt; b');
writes('a > b', 'a &gt; b');
// Invisible in a source file, so it goes in as something a reader can see.
writes('x y', 'x&#160;y');
// A character the file can hold goes in as itself: spelling `©` as `&copy;` in
// a file that says `©` everywhere else would be the editor imposing its habits.
writes('© 2026', '© 2026');
writes('Let’s go', 'Let’s go');
check('and what is written reads back as what it was', decodeEntities(encodeText('a & b < c')) === 'a & b < c');

// ── Through a page ──────────────────────────────────────────────────────────
const page = (body) => `---\nconst SITE_NAME = "Remarkable";\n---\n${body}\n`;
const FOOTER = page('<p class="footer_copyright">&copy;<span>2026</span>&#160;{SITE_NAME}</p>');
const parsed = parsePage(FOOTER);
const kids = parsed.model.nodes[0].children;
check(
  'the copyright sign is a copyright sign',
  kids[0]?.value === '©',
  JSON.stringify(kids.map((k) => k.value))
);
check(
  'and the hard space is a space',
  kids[2]?.value === ' ',
  JSON.stringify(kids.map((k) => k.value))
);

// Nothing was edited, so nothing about the file changes.
check('an untouched page is written back exactly', serializePage(parsePage(FOOTER).model) === FOOTER);
for (const body of [
  '<p>&copy;&#160;{SITE_NAME}</p>',
  '<p>Let&rsquo;s create the remarkable</p>',
  '<p>\n  Let&rsquo;s create\n  the remarkable\n</p>',
  '<p>a &amp; b</p>',
  '<p>plain words</p>',
]) {
  check(`and so is ${JSON.stringify(body.slice(0, 34))}`, serializePage(parsePage(page(body)).model) === page(body));
}

// Edited, the characters are what there is — and the ampersand somebody typed
// has to go in as an entity or it is markup.
{
  const model = parsePage(page('<p>&copy; 2026</p>')).model;
  const text = model.nodes[0].children[0];
  text.value = '© 2026 Remarkable & Co';
  delete text.source;
  delete model.nodes[0].source;
  const out = serializePage(model);
  check('an edit writes the characters', /© 2026 Remarkable/.test(out), out);
  check('with the ampersand made safe', /&amp; Co/.test(out), out);
  check(
    'and it reads back as what was typed',
    parsePage(out).model.nodes[0].children[0].value === '© 2026 Remarkable & Co',
    JSON.stringify(parsePage(out).model.nodes[0].children[0].value)
  );
}

// The whole point of keeping the source: a hand-wrapped paragraph with an
// entity in it must not be reflowed onto one line for having been read.
{
  const wrapped = page('<p class="lead">\n  Let&rsquo;s create\n  the remarkable\n</p>');
  const out = serializePage(parsePage(wrapped).model);
  check('a wrapped run with an entity keeps its lines', out === wrapped, JSON.stringify(out));
}

// ── The real file this came from ────────────────────────────────────────────
const REAL = '/Users/timothyricks/Documents/Projects/remarkable-agency/src/components/Footer.astro';
if (fs.existsSync(REAL)) {
  const src = fs.readFileSync(REAL, 'utf8');
  const model = parsePage(src).model;
  const values = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'text') values.push(n.value);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(model.nodes);
  check('the real footer shows characters, not entities', !values.some((v) => /&[#a-z]/i.test(v)), JSON.stringify(values.filter((v) => /&[#a-z]/i.test(v))));
  check(
    'and the copyright row is the sign itself',
    values.some((v) => v.trim() === '©'),
    JSON.stringify(values)
  );
  check('while the file is left as it was', serializePage(parsePage(src).model) === src);
}

if (failures.length) {
  console.error(`\nhtml-text: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`html-text: ${checked} passed  [read as characters, written as found]`);
