// Goal: `.stacki/component-canvas.json` keys follow their components. A rename or a move rewrites the key in the same plan
// as every other reference, a deletion plans the key's removal with the other settings it cleans, other components are
// untouched, and a canvas file the parser refuses never blocks either operation (it is reported and left as it is).
// Method: build a small project in a temp directory, run the real rename planner and apply it with the real writer, plan a
// deletion's metadata changes, and read the canvas file back through the shared parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planComponentRenameWork } from '#dist/electron/handlers/componentRenamePlan.js';
import { applyComponentRename } from '#dist/electron/handlers/componentRenameApply.js';
import { desktopRenameWriter } from '#dist/electron/project/pageRenameDesktop.js';
import { planMetadataChanges } from '#dist/electron/handlers/componentOps.js';
import { runSync } from '#dist/electron/lib/slicedWork.js';
import { parseComponentCanvasSource } from '#dist/shared/properties/componentCanvas.js';

const CANVAS = `${JSON.stringify(
  {
    version: 1,
    components: {
      'src/components/Button.astro': { split: ['variant'], frames: { 'variant=arrow': { width: 200 } } },
      'src/components/Card.astro': { split: [] },
    },
  },
  undefined,
  2,
)}\n`;

function project(canvas: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-upkeep-')));
  const files: Record<string, string> = {
    'package.json': '{"name":"fixture"}',
    'src/components/Button.astro': '---\nconst { variant } = Astro.props;\n---\n<button>{variant}</button>\n',
    'src/components/Card.astro': '<div><slot /></div>\n',
    'src/pages/index.astro': '---\nimport Card from "../components/Card.astro";\n---\n<Card />\n',
    '.stacki/component-canvas.json': canvas,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const readCanvas = (root: string) => {
  const parsed = parseComponentCanvasSource(fs.readFileSync(path.join(root, '.stacki/component-canvas.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
};

test('a rename moves the canvas key with the file and keeps its settings', (context) => {
  const root = project(CANVAS);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planned = runSync(planComponentRenameWork(root, { from: 'src/components/Button.astro', to: 'src/components/ui/Action.astro' }));
  assert.ok(planned.ok, planned.ok ? '' : planned.error.message);
  assert.ok(planned.value.summary.files.some((file) => file.file === '.stacki/component-canvas.json' && file.kind === 'settings'));
  assert.ok(applyComponentRename(planned.value, desktopRenameWriter()).ok);
  const canvas = readCanvas(root);
  assert.deepEqual(Object.keys(canvas.components).sort(), ['src/components/Card.astro', 'src/components/ui/Action.astro']);
  assert.deepEqual(canvas.components['src/components/ui/Action.astro'], { split: ['variant'], frames: { 'variant=arrow': { width: 200 } } });
});

test('a rename of a component without canvas settings leaves the file byte for byte', (context) => {
  const root = project(CANVAS);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src/components/Badge.astro'), '<span />\n');
  const planned = runSync(planComponentRenameWork(root, { from: 'src/components/Badge.astro', to: 'src/components/Tag.astro' }));
  assert.ok(planned.ok);
  assert.equal(
    planned.value.texts.some((text) => text.file === '.stacki/component-canvas.json'),
    false,
  );
});

test('a canvas file the parser refuses is reported, never blocks the rename, and is left as it is', (context) => {
  const broken = '{"version":1,"components":{"src/components/Button.astro":{"split":"variant"}}}\n';
  const root = project(broken);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planned = runSync(planComponentRenameWork(root, { from: 'src/components/Button.astro', to: 'src/components/Action.astro' }));
  assert.ok(planned.ok);
  assert.ok(planned.value.summary.notices.some((notice) => notice.file === '.stacki/component-canvas.json' && notice.kind === 'unparsed'));
  assert.ok(applyComponentRename(planned.value, desktopRenameWriter()).ok);
  assert.equal(fs.readFileSync(path.join(root, '.stacki/component-canvas.json'), 'utf8'), broken);
});

test('a deletion plans the removal of its canvas key and nothing else', (context) => {
  const root = project(CANVAS);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planned = planMetadataChanges(root, { kind: 'component', path: 'src/components/Button.astro' });
  assert.ok(planned.ok);
  const change = planned.value.find((candidate) => candidate.kind === 'componentCanvas');
  assert.ok(change !== undefined);
  assert.equal(change.before, CANVAS);
  const after = parseComponentCanvasSource(change.after);
  assert.ok(after.ok);
  assert.deepEqual(Object.keys(after.value.components), ['src/components/Card.astro']);
  // A component the file does not name plans no canvas change; neither does an unreadable file.
  const untouched = planMetadataChanges(root, { kind: 'component', path: 'src/pages/index.astro' });
  assert.ok(untouched.ok);
  assert.equal(
    untouched.value.some((candidate) => candidate.kind === 'componentCanvas'),
    false,
  );
  fs.writeFileSync(path.join(root, '.stacki/component-canvas.json'), '{broken');
  const unreadable = planMetadataChanges(root, { kind: 'component', path: 'src/components/Button.astro' });
  assert.ok(unreadable.ok);
  assert.equal(
    unreadable.value.some((candidate) => candidate.kind === 'componentCanvas'),
    false,
  );
});
