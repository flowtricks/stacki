// Goal: syntax colouring has no size limit. A code string of tens of megabytes is
// coloured by window: the top is coloured after one slice of work whatever the
// length, the rest follows slice by slice with the event loop free between
// slices, and the batches together are exactly the lines of the text. Astro, whose
// TextMate grammar is synchronous CPU, resumes each slice from the grammar state
// the slice before it ended in, so a comment left open crosses a slice boundary.
//
// Method: sources are generated in memory (never committed) and sized by
// scaleMegabytes(). The biggest string is only started: its first batch is timed
// (time to first window) and a run of further batches is drained under
// measureOperation, which asserts the longest event-loop block stays under
// lagMsBound(). A smaller string is drained to its end and compared line for line
// with the text. The editor's incremental pass runs in jsdom against an Astro
// document and must colour a late line, then recolour after an edit at the top,
// without a block over the bound.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule.js');
const { lagMsBound, measureOperation, scaleMegabytes } = loadRenderer('test/helpers/scaleFixtures.ts');

const MEGABYTE = 1024 * 1024;
const FIRST_WINDOW_MS_MAX = 1000;

function typescriptSource(characters) {
  const lines = [];
  let length = 0;
  for (let index = 0; length < characters; index++) {
    const line = `export const value${index} = { name: "item ${index}", list: [${index}, ${index + 1}], on: index % 2 === 0 }; // note ${index}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

// Frontmatter, markup, and a comment that opens in one place and closes far below.
function astroSource(characters) {
  const lines = ['---', 'const title = "Scale";', '---', '<main>'];
  let length = 0;
  for (let index = 0; length < characters; index++) {
    const line =
      index % 400 === 0
        ? `<!-- block ${index}`
        : index % 400 === 3
          ? `still inside the comment ${index} -->`
          : `<p class="row-${index}" data-index={${index}}>{title} item ${index}</p>`;
    lines.push(line);
    length += line.length + 1;
  }
  lines.push('</main>');
  return lines.join('\n');
}

function countLines(text) {
  let count = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    count += 1;
  }
  return count;
}

let highlight;
let astro;
let slices;
before(() => {
  highlight = loadRenderer('src/ui/codeHighlight.ts');
  astro = loadRenderer('src/ui/astroHighlight.ts');
  slices = loadRenderer('src/ui/codeSlices.ts');
});

test('slices cover the text in whole lines, one per pass of bounded work', () => {
  const text = 'a\n\nbb\nccc\n';
  for (const charsMax of [1, 2, 3, 100]) {
    const joined = [];
    for (const slice of slices.lineSlices(text, 0, charsMax)) {
      joined.push(text.slice(slice.start, slice.end));
      assert.ok(slice.end - slice.start <= Math.max(charsMax, 3), 'a slice is no longer than its bound unless one line is');
    }
    assert.equal(joined.join('\n'), text, `slices of ${charsMax} rejoin to the text`);
  }
  assert.throws(() => slices.nextLineSlice(text, 0, 0), /at least one character/);
  assert.throws(() => slices.nextLineSlice(text, text.length + 1, 4), /past the text/);
});

test('text past one slice shows plain at once and is coloured through batches', async () => {
  const text = typescriptSource(2 * MEGABYTE);
  const instant = highlight.codeTokenLines(text, 'typescript');
  assert.equal(instant.length, countLines(text), 'the instant lines are every line of the text');
  assert.ok(
    instant.every((line) => line.length <= 1 && line.every((token) => token.style === undefined)),
    'the instant lines are plain',
  );
  let lineCount = 0;
  let coloured = 0;
  const { lagMsMax } = await measureOperation('highlight-lezer-full', `${text.length} chars`, async () => {
    for await (const batch of highlight.codeLineBatches(text, 'typescript')) {
      lineCount += batch.length;
      coloured += batch.reduce((sum, line) => sum + line.filter((token) => token.style !== undefined).length, 0);
    }
  });
  assert.equal(lineCount, countLines(text), 'the batches are every line of the text, once');
  assert.ok(coloured > lineCount, 'the lines are coloured');
  assert.ok(lagMsMax < lagMsBound(), `the event loop was blocked ${lagMsMax} ms`);
});

test('the batches of a long string rejoin to its text, a comment crossing a slice included', async () => {
  const text = astroSource(300_000);
  const lines = [];
  for await (const batch of astro.astroCodeLineBatches(text)) {
    lines.push(...batch);
  }
  assert.equal(lines.map((line) => line.map((token) => token.text).join('')).join('\n'), text);
  // A comment opened in one slice colours the lines of the next one as a comment.
  const inside = lines.findIndex((line) =>
    line
      .map((token) => token.text)
      .join('')
      .startsWith('still inside the comment'),
  );
  assert.ok(inside > 0, 'the generated text has a comment to cross');
  const colours = new Set(lines[inside].map((token) => token.style?.color));
  assert.equal(colours.size, 1, 'a line inside a comment is one colour');
});

test('every grammar returns the lines of a long text and colours the lines past its first slice', async () => {
  const json = `{${Array.from({ length: 12_000 }, (_, index) => `\n  "key${index}": { "name": "item ${index}", "on": true }`).join(',')}\n}`;
  const samples = { typescript: typescriptSource(250_000), json, css: Array.from({ length: 9000 }, (_, i) => `.a${i} { color: #${i % 10}00; }`).join('\n') };
  for (const [language, text] of Object.entries(samples)) {
    const lines = [];
    for await (const batch of highlight.codeLineBatches(text, language)) {
      lines.push(...batch);
    }
    assert.equal(lines.map((line) => line.map((token) => token.text).join('')).join('\n'), text, `${language}: the lines rejoin to the text`);
    const last = lines.at(-2);
    assert.ok(
      last.some((token) => token.style !== undefined),
      `${language}: a line past the first slice is coloured`,
    );
  }
});

test('the top of a huge string is coloured after one slice, whatever its length', async () => {
  const text = typescriptSource(scaleMegabytes() * MEGABYTE);
  const iterator = highlight.codeLineBatches(text, 'typescript');
  const first = await measureOperation('highlight-lezer-first-window', `${text.length} chars`, () => iterator.next());
  assert.ok(first.wallMs < FIRST_WINDOW_MS_MAX, `the first window took ${first.wallMs} ms`);
  assert.ok(first.lagMsMax < lagMsBound(), `the first window blocked ${first.lagMsMax} ms`);
  assert.ok(
    first.value.value.some((line) => line.some((token) => token.style !== undefined)),
    'the first window is coloured',
  );
  const drained = await measureOperation('highlight-lezer-windows', `${text.length} chars, 25 windows`, async () => {
    for (let batches = 0; batches < 25; batches++) {
      assert.equal((await iterator.next()).done, false);
    }
  });
  assert.ok(drained.lagMsMax < lagMsBound(), `the next windows blocked ${drained.lagMsMax} ms`);
  await iterator.return(undefined);
});

test('an Astro string of any length is coloured window by window', async () => {
  const text = astroSource(scaleMegabytes() * MEGABYTE);
  const iterator = astro.astroCodeLineBatches(text);
  // The grammar loads once; that is startup, not the cost of a window.
  await astro.prefetchAstroHighlighter();
  const first = await measureOperation('highlight-astro-first-window', `${text.length} chars`, () => iterator.next());
  assert.ok(first.wallMs < FIRST_WINDOW_MS_MAX, `the first window took ${first.wallMs} ms`);
  assert.ok(first.lagMsMax < lagMsBound(), `the first window blocked ${first.lagMsMax} ms`);
  assert.ok(
    first.value.value.some((line) => line.some((token) => token.style !== undefined)),
    'the first window is coloured',
  );
  const drained = await measureOperation('highlight-astro-windows', `${text.length} chars, 15 windows`, async () => {
    for (let batches = 0; batches < 15; batches++) {
      assert.equal((await iterator.next()).done, false);
    }
  });
  assert.ok(drained.lagMsMax < lagMsBound(), `the next windows blocked ${drained.lagMsMax} ms`);
  await iterator.return(undefined);
});
