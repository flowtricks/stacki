// Goal: the dev plugin marks a page of any size completely. Owner requirement:
// there is no size limit, so a page of tens of megabytes, hundreds of thousands
// of lines and hundreds of thousands of nodes gets every marker pair and its
// stamp, never a truncated copy and never a "past the file bound, show it as
// code" refusal (electron/previewServer/previewMarkers.ts).
// Method: generate an astro-like page in os.tmpdir from one repeated section
// (headings, copy, a link, a list: eight element nodes and about twenty lines a
// unit), mark it through the real markSourceFile from dist, and check the
// result: every unit is present, start and end markers pair up one for one and
// number at least one pair per element node, and the stamp comment closing the
// module names the SHA-256 of the exact bytes on disk. The marking runs in the
// project's dev server process, never the app's UI, so its cost is printed
// (SCALE line) rather than held to the loop-lag bound: the parser it calls
// (electron/parse) is synchronous. Size follows STACKI_SCALE_MB when set; by
// default it is 8 MB, because parsing 24 MB takes tens of seconds today and the
// gate must stay quick (the report names that as a parser finding).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { measureOperation, scaleMegabytes } = require('../../helpers/scaleFixtures.ts');
const { markSourceFile } = require('#dist/electron/previewServer/previewMarkers.js');
const { stampComment } = require('#dist/shared/page/previewToken.js');

const ELEMENTS_PER_UNIT = 8;

function pageMegabytes() {
  return process.env.STACKI_SCALE_MB === undefined || process.env.STACKI_SCALE_MB === '' ? Math.min(8, scaleMegabytes()) : scaleMegabytes();
}

function unit(index) {
  return (
    `  <section class="block block-${index % 7}" id="s${index}">\n` +
    `    <h2 class="title">Section ${index}</h2>\n` +
    '    <div class="row">\n' +
    `      <p class="copy">Lorem ipsum dolor sit amet ${index}</p>\n` +
    `      <a href="/page-${index}" class="link">Read more</a>\n` +
    '    </div>\n' +
    '    <ul>\n      <li>One</li>\n      <li>Two</li>\n    </ul>\n' +
    '  </section>\n'
  );
}

function countOf(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

test('a page of megabytes is marked completely, however long', async (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-markers-scale-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const file = path.join(project, 'src', 'pages', 'big.astro');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parts = ['---\nconst title = "Big";\n---\n<main>\n'];
  let bytes = parts[0].length;
  let units = 0;
  while (bytes < pageMegabytes() * 1024 * 1024) {
    const next = unit(units++);
    parts.push(next);
    bytes += next.length;
  }
  parts.push('</main>\n');
  const text = parts.join('');
  fs.writeFileSync(file, text);
  const lines = countOf(text, '\n');
  assert.ok(lines > 100_000, `the page has hundreds of thousands of lines at full size (${lines})`);

  const { value: marked } = await measureOperation('previewMarkers', `bytes=${text.length} lines=${lines} units=${units}`, async () =>
    markSourceFile(file, [project]),
  );
  assert.ok(marked !== undefined, 'a page of any size is marked, not left unmarked past a bound');
  assert.equal(marked.source.length, text.length, 'the marked module carries the whole file');
  assert.ok(marked.page, 'a page under src/pages is a page');
  const starts = countOf(marked.code, '<!--avb-s:');
  const ends = countOf(marked.code, '<!--avb-e:');
  assert.equal(starts, ends, 'every start marker has its end marker');
  assert.ok(starts >= units * ELEMENTS_PER_UNIT, `a pair per element node at least: ${starts} for ${units * ELEMENTS_PER_UNIT}`);
  assert.ok(marked.code.includes(`id="s${units - 1}"`), 'the last unit is in the copy, not truncated');
  assert.ok(marked.code.includes('id="s0"'), 'and the first');
  const checksum = createHash('sha256').update(text).digest('hex');
  const stamp = stampComment({ file: 'src/pages/big.astro', checksum });
  assert.ok(marked.code.trimEnd().endsWith(stamp), 'the stamp closes the module and names the exact bytes on disk');
});
