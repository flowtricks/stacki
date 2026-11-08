// Goal: canvas text editing opens on a demo rendering. The frame opens it only when the
// rendering's stamp for the page names the checksum of the source the editor holds, so
// the demo's renderings must carry that checksum on first load, after an edit and after
// a reload with saved edits, and never claim it for a file they were not made from.
// Method: the frame's own manifest rule (one checksum per file, the editor's SHA-256 of
// the source) is applied to baked and restamped renderings of a small page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { restampRendering, sourceChecksum } from '../demo/renderStamps';

const PAGE = 'src/pages/index.astro';
const CARD = 'src/components/Card.astro';
const BAKED_PAGE = '<h1>Original</h1>\n';
const BAKED_CARD = '<article><slot /></article>\n';

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function rendering(page: string, card: string): string {
  return [
    `<html data-avb-d="avb-d:${page}:${PAGE}">`,
    `<article data-avb-d="avb-d:${card}:${CARD}\navb-d:${page}:${PAGE}"></article>`,
    `<!--avb-d:${card}:${CARD}-->`,
    `<!--avb-d:${page}:${PAGE}-->`,
    '</html>',
  ].join('');
}

/** What the frame's manifest says: undefined when a file carries two checksums. */
function manifest(html: string): ReadonlyMap<string, string> | undefined {
  const files = new Map<string, string>();
  for (const match of html.matchAll(/avb-d:([0-9a-f]{64}):([^\n"<>]+?)(?=-->|"|\n)/g)) {
    const [, checksum = '', file = ''] = match;
    if (files.has(file) && files.get(file) !== checksum) {
      return undefined;
    }
    files.set(file, checksum);
  }
  return files;
}

/** The frame's gate: text editing opens only when the page's stamp is the source's. */
function textEditingOpens(html: string, file: string, source: string): boolean {
  return manifest(html)?.get(file) === digest(source);
}

const baked = (file: string): string | undefined => ({ [PAGE]: BAKED_PAGE, [CARD]: BAKED_CARD })[file];

test('the source checksum is the digest the editor computes', () => {
  for (const text of ['', BAKED_PAGE, 'Ünïcödé “quotes” and 😀', 'x'.repeat(200)]) {
    assert.equal(sourceChecksum(text), digest(text));
  }
});

test('text editing opens on the baked rendering of an unedited page', () => {
  const html = rendering(digest(BAKED_PAGE), digest(BAKED_CARD));
  assert.equal(restampRendering(html, new Map(), baked), html, 'Nothing edited, nothing restamped');
  assert.ok(textEditingOpens(html, PAGE, BAKED_PAGE));
});

test('after an edit the rendering names the edited source, and only that', () => {
  const edited = '<h1>Edited</h1>\n';
  const before = rendering(digest(BAKED_PAGE), digest(BAKED_CARD));
  assert.equal(textEditingOpens(before, PAGE, edited), false, 'Without a restamp the gate would wait forever');
  const after = restampRendering(before, new Map([[PAGE, edited]]), baked);
  assert.ok(textEditingOpens(after, PAGE, edited), 'Text editing opens after an edit');
  assert.equal(manifest(after)?.get(CARD), digest(BAKED_CARD), 'An unedited file keeps its baked stamp');
  assert.equal(textEditingOpens(after, PAGE, BAKED_PAGE), false, 'The old source no longer matches');
});

test('a second edit and a reload with saved edits restamp from the baked bytes again', () => {
  const html = rendering(digest(BAKED_PAGE), digest(BAKED_CARD));
  for (const text of ['<h1>One</h1>\n', '<h1>Two</h1>\n']) {
    const after = restampRendering(html, new Map([[PAGE, text]]), baked);
    assert.ok(textEditingOpens(after, PAGE, text));
  }
  const both = restampRendering(
    html,
    new Map([
      [PAGE, '<h1>Page</h1>\n'],
      [CARD, '<article>Card</article>\n'],
    ]),
    baked,
  );
  assert.equal(manifest(both)?.get(CARD), digest('<article>Card</article>\n'), 'Edited components restamp too');
});

test('a stamp is replaced only where it ends, never inside a longer file name', () => {
  const longer = `<!--avb-d:${digest(BAKED_PAGE)}:${PAGE}x-->`;
  assert.equal(restampRendering(longer, new Map([[PAGE, 'changed']]), baked), longer);
  const unknown = rendering(digest(BAKED_PAGE), digest(BAKED_CARD));
  assert.equal(restampRendering(unknown, new Map([['src/pages/other.astro', 'x']]), baked), unknown, 'A file the bake never had is left alone');
});
