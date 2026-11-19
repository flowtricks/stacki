// Goal: a drop on the canvas writes the same edit a Navigator drop writes, through the real page IPC, and one Undo
// puts every byte back; a drop where the node already stands asks for no edit at all.
//
// Method: a Lumos-like page in a scratch project (never a real one) is read through `page:read`. The drop model
// (src/editor/canvasDrop.ts, canvasDropView.ts) decides the place from levels measured by hand, as the frame reports
// them; the decision becomes the app's move gesture (editGestures.ts moveGesture), whose request is sent through
// `page:edit` with node refs built from the page as read. The file's bytes are compared after the move, and after
// the reply's inverse is applied as a revert: the one Undo step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('../../helpers/rendererModule');
const { decideCanvasDrop } = load('src/editor/canvasDrop.ts');
const { dropView, dropActionOf, startDropSession } = load('src/editor/canvasDropView.ts');
const { moveGesture } = load('src/editor/editGestures.ts');
const { repoPath } = require('../../helpers/sources.js');
const { parsePageDiskRead, parsePageEditResult } = require(repoPath('dist/shared/ipc/pageSave.js'));

const SOURCE =
  '---\nconst title = "Lumos";\n---\n<section class="section">\n  <div class="container">\n    <img class="logo" alt="Lumos" />\n    <h1>Style Guide</h1>\n' +
  '    <div class="row"><span class="badge">v2.2.4</span><a href="/docs">View Docs</a></div>\n  </div>\n</section>\n<!-- untouched -->\n';

async function scratch(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-drop-'));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const file = path.join(root, 'src', 'pages', 'index.astro');
  fs.writeFileSync(file, SOURCE);
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { harness, file };
}

// Ids and refs by walking the page as read: what the app's refOf answers.
function index(nodes) {
  const byClass = new Map();
  const refs = new Map();
  const pending = nodes.map((node, at) => ({ node, path: [at] }));
  for (let visited = 0; visited < pending.length; visited++) {
    assert.ok(visited < 500, 'the fixture page is small');
    const { node, path: trail } = pending[visited];
    const className = node.props?.class?.type === 'string' ? node.props.class.value : node.name;
    if (className !== undefined && !byClass.has(className)) {
      byClass.set(className, node);
    }
    if (node.start !== undefined && node.end !== undefined) {
      refs.set(node.id, { path: trail, kind: node.kind, span: { start: node.start, end: node.end } });
    }
    (node.children ?? []).forEach((child, at) => pending.push({ node: child, path: [...trail, at] }));
  }
  return { byClass, refs };
}

const rect = (x, y, width, height) => ({ x, y, w: width, h: height });

test('a canvas drop of the heading above the logo moves its bytes, and one Undo restores every byte', async (context) => {
  const { harness, file } = await scratch(context);
  const page = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(page.editable, 'the fixture page is editable');
  const { byClass, refs } = index(page.model.nodes);
  const container = byClass.get('container');
  const heading = byClass.get('h1');
  const logo = byClass.get('logo');
  const indexOf = (node) => container.children.indexOf(node);
  const levels = [
    { id: logo.id, box: rect(370, 56, 160, 40), content: rect(370, 56, 160, 40), flow: 'block', children: [] },
    {
      id: container.id,
      box: rect(40, 40, 820, 300),
      content: rect(56, 56, 788, 268),
      flow: 'column',
      children: [
        { id: logo.id, index: indexOf(logo), box: rect(370, 56, 160, 40) },
        { id: heading.id, index: indexOf(heading), box: rect(250, 120, 400, 74) },
      ],
    },
  ];
  const subject = { kind: 'element', id: heading.id, label: 'h1' };
  const session = startDropSession(page.model.nodes, subject, { insertables: [], document: 'page' });
  const view = dropView(session, { levels, pointer: { x: 450, y: 58 }, dragged: [], outside: false }, () => undefined);
  const action = dropActionOf(subject, view);
  assert.deepEqual(action, { kind: 'move', id: heading.id, place: { parentId: container.id, index: indexOf(logo) } });
  const gesture = moveGesture(page.model, heading.id, action.place, { keepsSlot: () => true }, { urgency: true });
  const edits = gesture.request((id) => refs.get(id));
  assert.equal(edits.length, 1, 'a move without a slot is one edit');
  const moved = parsePageEditResult(await harness.invoke('page:edit', { pagePath: file, authoredChecksum: page.checksum, edit: edits[0] }));
  assert.ok(moved.ok, JSON.stringify(moved));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.indexOf('<h1>Style Guide</h1>') < after.indexOf('<img class="logo"'), after);
  assert.ok(after.endsWith('<!-- untouched -->\n'), 'nothing else in the file changed');
  const undone = parsePageEditResult(
    await harness.invoke('page:edit', {
      pagePath: file,
      authoredChecksum: moved.value.checksum,
      edit: { tag: 'revert', hunks: moved.value.inverse },
    }),
  );
  assert.ok(undone.ok, JSON.stringify(undone));
  assert.equal(fs.readFileSync(file, 'utf8'), SOURCE, 'one Undo restores every byte');
});

test('a drop where the heading already stands asks for no edit', async (context) => {
  const { harness, file } = await scratch(context);
  const page = parsePageDiskRead(await harness.invoke('page:read', file));
  const { byClass } = index(page.model.nodes);
  const container = byClass.get('container');
  const heading = byClass.get('h1');
  const logo = byClass.get('logo');
  const tree = startDropSession(page.model.nodes, { kind: 'element', id: heading.id, label: 'h1' }, { insertables: [], document: 'page' });
  // The bottom edge of the logo: after the logo is just before the heading, where it stands.
  const levels = [
    { id: logo.id, box: rect(370, 56, 160, 40), content: rect(370, 56, 160, 40), flow: 'block', children: [] },
    {
      id: container.id,
      box: rect(40, 40, 820, 300),
      content: rect(56, 56, 788, 268),
      flow: 'column',
      children: [{ id: logo.id, index: container.children.indexOf(logo), box: rect(370, 56, 160, 40) }],
    },
  ];
  const decision = decideCanvasDrop({ tree: tree.tree, draggedId: heading.id, point: { x: 450, y: 94 }, levels });
  const view = dropView(tree, { levels, pointer: { x: 450, y: 94 }, dragged: [], outside: false }, () => undefined);
  // The parser keeps no whitespace between tags as nodes, so the logo's next sibling is the heading itself.
  assert.equal(container.children[container.children.indexOf(logo) + 1], heading);
  assert.equal(decision.noop, true);
  assert.deepEqual(dropActionOf(view.subject, view), { kind: 'none' });
  assert.equal(fs.readFileSync(file, 'utf8'), SOURCE, 'deciding writes nothing');
});
