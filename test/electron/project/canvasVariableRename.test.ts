// Goal: renaming a variable in the Variables panel renames it where the component canvas reads it too: the project's
// canvas background and every frame background in `.stacki/component-canvas.json`. A file that names none of the
// renamed variables is not written, and one its parser refuses is left as it is rather than failing the rename.
// Method: a temporary project with a stylesheet and a canvas settings file, renamed through the real `renameVariables`,
// then read back through the shared parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameVariables } from '#dist/electron/project/cssVars.js';
import { parseComponentCanvasSource } from '#dist/shared/properties/componentCanvas.js';

function project(canvas: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-rename-')));
  fs.mkdirSync(path.join(root, 'src/styles'), { recursive: true });
  fs.mkdirSync(path.join(root, '.stacki'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/styles/base.css'), ':root {\n  --surface: #eee;\n  --surface-2: #ddd;\n}\n');
  fs.writeFileSync(path.join(root, '.stacki/component-canvas.json'), canvas);
  return root;
}

const CANVAS = `${JSON.stringify(
  {
    version: 1,
    background: 'var(--surface)',
    components: { 'src/components/Button.astro': { frames: { '': { background: 'var(--surface-2, var(--surface))' } } } },
  },
  undefined,
  2,
)}\n`;

test('a rename reaches the canvas backgrounds and leaves longer names alone', (context) => {
  const root = project(CANVAS);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = renameVariables(root, { renames: [{ from: '--surface', to: '--canvas' }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.paths?.some((file) => file.endsWith(path.join('.stacki', 'component-canvas.json'))));
  const parsed = parseComponentCanvasSource(fs.readFileSync(path.join(root, '.stacki/component-canvas.json'), 'utf8'));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.background, 'var(--canvas)');
  assert.equal(parsed.value.components['src/components/Button.astro']?.frames?.['']?.background, 'var(--surface-2, var(--canvas))');
});

test('a canvas file without the name, or one its parser refuses, is not written', (context) => {
  const untouched = project(CANVAS);
  context.after(() => fs.rmSync(untouched, { recursive: true, force: true }));
  const result = renameVariables(untouched, { renames: [{ from: '--accent', to: '--accent-2' }] });
  assert.equal(result.ok, true);
  const parsed = parseComponentCanvasSource(fs.readFileSync(path.join(untouched, '.stacki/component-canvas.json'), 'utf8'));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.background, 'var(--surface)');
  const broken = project('{"version":1,"background":"var(--surface)","components":"nope"}\n');
  context.after(() => fs.rmSync(broken, { recursive: true, force: true }));
  assert.equal(renameVariables(broken, { renames: [{ from: '--surface', to: '--canvas' }] }).ok, true);
  assert.equal(
    fs.readFileSync(path.join(broken, '.stacki/component-canvas.json'), 'utf8'),
    '{"version":1,"background":"var(--surface)","components":"nope"}\n',
  );
});
