// Goal: a page `<style>` node written by the Style panel's live writes (a gradient stop
// dragged, the angle turned, a stop colour scrubbed) never surfaces an editor error. The
// failure this pins: a drag that overshoots a clamped end (a stop held at 100%) writes
// A = `100%`, then B = `99%`, then C = `100%` again. B is still unsent when C arrives,
// so the queue replaces B with C; A's reply then makes A the origin, and C, which
// restates A exactly, reached main as a node rewrite that changes nothing. Main refuses
// that as `unsupported-operation`, which the page reported as "Stacki encountered an
// editor error while applying the change."
// Method: the real renderer modules (bundled with esbuild) and main's real handlers in
// the windowless harness, on a temporary project: the writes are sent in the order the
// queue sends them, each stated against the origin the previous reply left.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/style-node-writes');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  entryPoints: {
    pageEdits: repoPath('src/editor/pageEdits.ts'),
    editGestures: repoPath('src/editor/editGestures.ts'),
    gradient: repoPath('src/features/style/model/gradient.ts'),
  },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDirectory, 'pageEdits.js'));
const gestures = require(path.join(buildDirectory, 'editGestures.js'));
const gradients = require(path.join(buildDirectory, 'gradient.js'));

const css = (image) => `\n  @layer components {\n    .my-class {\n      background-image: ${image};\n    }\n  }\n`;
const linear = (angle, first, last) => `linear-gradient(${angle}, #e30e0e ${first}, #9ef4ff ${last})`;

async function openPage(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-node-writes-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, `<div class="my-class"></div>\n<style>${css(linear('180deg', '0%', '100%'))}</style>\n`);
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  return { file, send, origin: { checksum: read.checksum, source: read.source, model: read.model } };
}

// The page's one `<style>` node in a parse.
function styleNode(model) {
  const node = model.nodes.find((candidate) => candidate.kind === 'raw' && candidate.name === 'style');
  assert.ok(node !== undefined, 'the page has its style node');
  return node;
}

// One Style panel write of the style node's contents, sent against `origin`; the
// origin the reply leaves (or the same one when nothing was written).
async function write(page, origin, inner) {
  const node = styleNode(origin.model);
  const gesture = gestures.nodeGesture(node.id, { ...node, inner }, { coalesceKey: `text:${node.id}`, urgency: 'live' });
  const step = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const sent = await edits.sendGesture({ path: page.file, origin, gesture, record: step, send: page.send });
  if (sent.tag !== 'applied') {
    return { sent, origin };
  }
  const last = sent.replies.at(-1);
  const next = last === undefined ? origin : { checksum: last.checksum, source: last.source, model: last.model };
  return { sent, origin: next };
}

test('a live write that restates the bytes on disk is a write of nothing, not an editor error', async (context) => {
  const page = await openPage(context);
  const atEnd = css(linear('180deg', '0%', '100%'));
  // A (the drag reaches the end) and C (it comes back to the end after B was replaced).
  const first = await write(page, page.origin, css(linear('180deg', '0%', '99%')));
  assert.equal(first.sent.tag, 'applied');
  const second = await write(page, first.origin, atEnd);
  assert.equal(second.sent.tag, 'applied');
  const restated = await write(page, second.origin, atEnd);
  assert.deepEqual(restated.sent, { tag: 'applied', replies: [] }, 'nothing to write is settled, never refused');
  assert.equal(restated.origin.checksum, second.origin.checksum, 'the page is untouched');
  assert.ok(fs.readFileSync(page.file, 'utf8').includes(linear('180deg', '0%', '100%')));
});

test('a drag far past both ends, sent as rapid live writes, never refuses', async (context) => {
  const page = await openPage(context);
  let origin = page.origin;
  // Pointer positions far outside the bar, back and forth, as the editor sees them:
  // the stop's percentage and the dial's angle both come from the same drag.
  const pointer = [-500, -40, -1, 0, 1, 50, 99, 100, 101, 140, 9999, 100, 99, 100, -3, 0, 0.4, 100.6, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
  let last = '';
  for (const [index, raw] of pointer.entries()) {
    const percent = gradients.clampedPercent(raw);
    const angle = gradients.degreesToAngle(raw * 7);
    const parsed = gradients.parseGradient(linear('180deg', '0%', '100%'));
    assert.ok(parsed !== undefined);
    const next = { ...parsed, angle, stops: parsed.stops.map((stop, at) => (at === 1 ? { ...stop, pos: `${percent}%` } : stop)) };
    const image = gradients.serializeGradient(next);
    assert.match(image, /^linear-gradient\(\d{1,3}deg, #e30e0e 0%, #9ef4ff \d{1,3}(\.\d{1,2})?%\)$/, `write ${index} is plain CSS`);
    last = css(image);
    const result = await write(page, origin, last);
    assert.equal(result.sent.tag, 'applied', `write ${index} (${raw}) applied`);
    origin = result.origin;
  }
  assert.equal(fs.readFileSync(page.file, 'utf8'), `<div class="my-class"></div>\n<style>${last}</style>\n`);
});

test('a write after the text before the value changed length lands on the value', async (context) => {
  const page = await openPage(context);
  // The angle's text grows from `180deg` to `5deg` to `355deg`, moving every byte after it.
  let origin = page.origin;
  for (const angle of ['5deg', '355deg', '5deg', '90deg']) {
    const result = await write(page, origin, css(linear(angle, '0%', '100%')));
    assert.equal(result.sent.tag, 'applied', angle);
    origin = result.origin;
  }
  const result = await write(page, origin, css(linear('90deg', '0%', '42%')));
  assert.equal(result.sent.tag, 'applied');
  assert.ok(fs.readFileSync(page.file, 'utf8').includes(linear('90deg', '0%', '42%')));
});
