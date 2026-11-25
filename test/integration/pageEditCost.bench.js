// Goal: what one edit costs the main process end to end, from the `page:edit`
// request to its reply, and how much of that is the reply's own parse of the
// page just written. A measurement, not a test: it prints a table to compare
// before and after a change.
// Method: generate pages of about 25 KB and 90 KB, each with and without a
// <style> block, in a temporary project. Drive the real main handlers through
// the windowless harness: each sample reads the page through `page:read` and
// sends one code patch through `page:edit` (a CSS value when the page has a
// style block, a heading's text otherwise), timed whole. The same sample's text
// is then parsed alone through `page:parse`, which runs the parse the reply
// runs. Two warm-ups, then thirty samples per page; p50 and p95.
// Run: npm run bench:page-edit (after npm run build:runtime).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const SAMPLES = 30;
const WARM_UPS = 2;
const TARGET_KB = [25, 90];

// A page of sections of cards, `kilobytes` long, with or without a style block.
function pageOf(kilobytes, styled) {
  const cards = [];
  let index = 0;
  while (cards.join('\n').length < kilobytes * 1024) {
    cards.push(`  <article class="card"><h3>Card ${index}</h3><p>Text for card ${index}.</p>` + `<a href="/c/${index}">Read</a></article>`);
    index += 1;
  }
  const style = styled ? '\n<style>.card { color: rgb(1, 0, 0); }</style>\n' : '\n';
  return `<main>\n<h1>Heading 0</h1>\n${cards.join('\n')}\n</main>${style}`;
}

const percentile = (values, rank) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)];
};

async function benchPage(harness, codePatch, file, styled) {
  const total = [];
  const parse = [];
  for (let index = 0; index < WARM_UPS + SAMPLES; index += 1) {
    const read = await harness.invoke('page:read', file);
    const next = styled
      ? read.source.replace(/rgb\(\d+, 0, 0\)/, `rgb(${(index % 250) + 2}, 0, 0)`)
      : read.source.replace(/Heading \d+/, `Heading ${index + 1}`);
    const hunks = codePatch.diffCodePatch(read.source, next);
    const edit = { tag: 'code-patch', hunks: hunks.value };
    const started = performance.now();
    const reply = await harness.invoke('page:edit', {
      pagePath: file,
      authoredChecksum: read.checksum,
      edit,
    });
    const edited = performance.now() - started;
    if (reply.ok !== true) {
      throw new Error(`page:edit refused: ${JSON.stringify(reply.error)}`);
    }
    const parseStarted = performance.now();
    await harness.invoke('page:parse', { pagePath: file, source: next });
    const parsed = performance.now() - parseStarted;
    if (index >= WARM_UPS) {
      total.push(edited);
      parse.push(parsed);
    }
  }
  return { total, parse };
}

async function main() {
  const { mainHarness } = await import('../helpers/mainHarness.ts');
  const codePatch = require('#dist/shared/engine/codePatch.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-edit-bench-')));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  const harness = mainHarness(path.join(root, 'user'));
  // Main logs every write it makes; the table is printed after the samples so
  // those lines do not split it.
  const lines = [];
  lines.push(
    `page:edit end to end in main, ms; p50 / p95 of ${SAMPLES} samples after ` + `${WARM_UPS} warm-ups. "parse" is the reply's parse of the same text, alone.`,
  );
  lines.push('page             bytes    style  edit p50  edit p95  parse p50  parse p95');
  try {
    for (const kilobytes of TARGET_KB) {
      for (const styled of [false, true]) {
        const name = `p${kilobytes}${styled ? 's' : ''}.astro`;
        const file = path.join(root, 'src', 'pages', name);
        fs.writeFileSync(file, pageOf(kilobytes, styled));
        const { total, parse } = await benchPage(harness, codePatch, file, styled);
        const cell = (values, rank) => percentile(values, rank).toFixed(1).padStart(10);
        lines.push(
          `${name.padEnd(17)}${String(fs.statSync(file).size).padEnd(9)}` +
            `${(styled ? 'yes' : 'no').padEnd(5)}${cell(total, 50)}${cell(total, 95)}` +
            `${cell(parse, 50)}${cell(parse, 95)}`,
        );
      }
    }
    console.log(lines.join('\n'));
  } finally {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
