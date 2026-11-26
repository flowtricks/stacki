// Goal: rich text typed on the canvas is never dropped without a word. A save is applied to the page as it is when it
// arrives, even when the page was read again since the editor opened (new node handles), and while the page is being
// read it is tried again, a bounded number of times. It ends written, found unchanged, or refused and said; content that
// changed under the editor is never written over.
// Method: the host's saver (src/features/preview/canvasRichSave.ts) over pages the test hands it, with a wait the test
// steps, so each timing is forced rather than hoped for; and the formatter both apps build (canvasTextFormat.ts) over
// a parsed page in JSDOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const { createCanvasRichSaver, RICH_SAVE_RETRY } = loadRenderer('src/features/preview/canvasRichSave.ts');
const { canvasTextFormatter } = loadRenderer('src/app/model/canvasTextFormat.ts');

const SOURCE = '---\nimport RichText from "../components/RichText.astro";\n---\n<RichText><p>One</p></RichText>\n';
const EDIT = { edit: 'e1', file: 'src/pages/index.astro', root: '0', breaks: 'rich' };
const SAVE = { ...EDIT, base: '<p>One</p>', html: '<p>One typed</p>' };

// The page as one reading of it: `prefix` names this reading's node handles.
function reading(prefix, source = SOURCE, writes = [], options = {}) {
  const parsed = parsePage(source, { locs: true });
  assert.equal(parsed.editable, true);
  // Every node gets this reading's handle for its place; walked as a list, so the depth needs no bound of its own.
  const nodes = structuredClone(parsed.model.nodes);
  const pending = nodes.map((node, index) => ({ node, path: [index] }));
  for (let visited = 0; visited < pending.length; visited++) {
    const { node, path } = pending[visited];
    node.id = `${prefix}${path.join('.')}`;
    (node.children ?? []).forEach((child, index) => pending.push({ node: child, path: [...path, index] }));
  }
  const format = canvasTextFormatter(nodes, (id, children) => {
    if (options.busy?.()) {
      return false;
    }
    writes.push({ id, children });
    return true;
  });
  return { file: EDIT.file, nodes, pathFor: (id) => id.slice(prefix.length), format, writes };
}

function withDocument(run) {
  return async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const saved = { document: global.document, window: global.window, Node: global.Node, Element: global.Element };
    Object.assign(global, { document: dom.window.document, window: dom.window, Node: dom.window.Node, Element: dom.window.Element });
    try {
      await run();
    } finally {
      Object.assign(global, saved);
      dom.window.close();
    }
  };
}

// A host over a page that may change between tries; each wait runs `between`.
function hostOf(page, between = () => {}) {
  const said = [];
  let waits = 0;
  return {
    said,
    waits: () => waits,
    host: {
      document: () => page.now,
      refused: (why) => said.push(why),
      unchanged: () => said.push('unchanged'),
      wait: async () => {
        waits += 1;
        between(waits);
      },
    },
  };
}

test(
  'a page read again since the editor opened is written by its present node handles',
  withDocument(async () => {
    const writes = [];
    const saver = createCanvasRichSaver();
    saver.opened(EDIT, reading('a', SOURCE, writes));
    const page = { now: reading('b', SOURCE, writes) };
    const { host, said } = hostOf(page);
    await saver.save(SAVE, host);
    assert.deepEqual(said, []);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 'b0', 'the present handle, not the one the editor opened under');
  }),
);

test(
  'while the page is being read, and while the editor is busy, the save waits and then lands',
  withDocument(async () => {
    const writes = [];
    let busy = true;
    const page = { now: undefined };
    const { host, said, waits } = hostOf(page, (count) => {
      if (count === 3) {
        page.now = reading('b', SOURCE, writes, { busy: () => busy });
      }
      if (count === 5) {
        busy = false;
      }
    });
    await createCanvasRichSaver().save(SAVE, host);
    assert.deepEqual(said, []);
    assert.equal(writes.length, 1);
    assert.equal(waits(), 5);
  }),
);

test(
  'a page that never comes back is refused and said after a bounded number of tries',
  withDocument(async () => {
    const { host, said, waits } = hostOf({ now: undefined });
    await createCanvasRichSaver().save(SAVE, host);
    assert.deepEqual(said, ['refused']);
    assert.equal(waits(), RICH_SAVE_RETRY.triesMax + 1);
  }),
);

test(
  'content that changed under the editor is not written over; another file is refused; no change is said',
  withDocument(async () => {
    const writes = [];
    const saver = createCanvasRichSaver();
    saver.opened(EDIT, reading('a', SOURCE, writes));
    const changed = SOURCE.replace('<p>One</p>', '<p>Someone else</p>');
    const conflict = hostOf({ now: reading('b', changed, writes) });
    await saver.save(SAVE, conflict.host);
    assert.deepEqual(conflict.said, ['conflict']);
    const elsewhere = hostOf({ now: { ...reading('b', SOURCE, writes), file: 'src/pages/about.astro' } });
    await saver.save(SAVE, elsewhere.host);
    assert.deepEqual(elsewhere.said, ['refused']);
    const same = hostOf({ now: reading('b', SOURCE, writes) });
    await saver.save({ ...SAVE, html: '<p>One</p>' }, same.host);
    assert.deepEqual(same.said, ['unchanged']);
    assert.equal(writes.length, 0);
  }),
);
