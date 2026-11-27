// Goal: `.stacki/component-canvas.json` is tracked with the project, so a teammate on 1.4.20 reads what this version
// writes. That version must open it, keep drawing what it understands, and give the newer settings back unharmed from
// every way it rewrites the file.
//
// Method: 1.4.20's own parser and writers, bundled from its release commit (test/fixtures/componentCanvas-1.4.20), read
// a file this version wrote with every newer setting in it; it is edited and written by that code, then read back by
// this version's parser. The negative space pins why layouts sit at the top level: 1.4.20 refuses a whole file over an
// unknown key of a component's.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  CANVAS_LEVEL,
  EMPTY_CANVAS_FILE,
  PROJECT_ROOT,
  parseComponentCanvasFile,
  parseComponentCanvasSource,
  relinkComponentCanvas,
  serializeComponentCanvas,
  withLevelArrangement,
  withRootEdit,
  type ComponentCanvasFile,
} from '#dist/shared/properties/componentCanvas.js';

type Current = typeof import('#dist/shared/properties/componentCanvas.js');
// The older module has the same shapes for everything these calls touch.
type Older = Pick<
  Current,
  | 'parseComponentCanvasSource'
  | 'serializeComponentCanvas'
  | 'canvasRoot'
  | 'withRootEdit'
  | 'withSplit'
  | 'withFrameEdit'
  | 'relinkComponentCanvas'
  | 'relinkCanvasAssets'
  | 'dropComponentCanvas'
  | 'renameCanvasVariables'
>;
const load = createRequire(path.resolve('package.json'));
const OLDER_CALLS: readonly (keyof Older)[] = [
  'parseComponentCanvasSource',
  'serializeComponentCanvas',
  'canvasRoot',
  'withRootEdit',
  'withSplit',
  'withFrameEdit',
  'relinkComponentCanvas',
  'relinkCanvasAssets',
  'dropComponentCanvas',
  'renameCanvasVariables',
];
const isOlder = (value: unknown): value is Older =>
  typeof value === 'object' && value !== null && OLDER_CALLS.every((name) => typeof Reflect.get(value, name) === 'function');
const loaded: unknown = load(path.resolve('test/fixtures/componentCanvas-1.4.20/generated/componentCanvas.cjs'));
assert.ok(isOlder(loaded), 'the 1.4.20 bundle has every call this test makes');
const older: Older = loaded;

const button = 'src/components/Button.astro';
const card = 'src/components/Card.astro';
const levels = { groups: ['variant=main'], stacked: true };

// What this version writes after a person arranged levels over an older single value, and set a component to no class.
function written(): ComponentCanvasFile {
  const start = parseComponentCanvasFile({
    version: 1,
    classes: ['theme-dark'],
    components: { [button]: { split: ['variant'], arrange: 'column' } },
  });
  const arranged = withLevelArrangement(start, button, 'variant=main', 'wrap', levels);
  const alone = withLevelArrangement(arranged, card, CANVAS_LEVEL, 'row', levels);
  return withRootEdit(alone, { kind: 'component', file: button }, { kind: 'classes', value: [] });
}

const layoutsOf = (source: string): unknown => {
  const document: unknown = JSON.parse(source);
  assert.ok(typeof document === 'object' && document !== null);
  return Reflect.get(document, 'levelLayouts');
};

function read(source: string): ComponentCanvasFile {
  const parsed = older.parseComponentCanvasSource(source);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.message);
  return parsed.value;
}

test('1.4.20 opens a file with the newer settings and draws what it knows', () => {
  const file = read(serializeComponentCanvas(written()));
  assert.equal(file.components[button]?.arrange, 'column', 'its own layout value is as it left it');
  assert.deepEqual(older.canvasRoot(file, button).classes, [], 'a component set to no class has none there too');
  assert.deepEqual(older.canvasRoot(file, card).classes, ['theme-dark']);
});

test('1.4.20 gives the newer layouts back unchanged from every way it writes the file', () => {
  const source = serializeComponentCanvas(written());
  const file = read(source);
  const component = { kind: 'component', file: button } as const;
  const edits: Readonly<Record<string, (held: ComponentCanvasFile) => ComponentCanvasFile>> = {
    'saved untouched': (held) => held,
    'a project class': (held) => older.withRootEdit(held, PROJECT_ROOT, { kind: 'classes', value: ['theme-brand'] }),
    'a component background': (held) => older.withRootEdit(held, component, { kind: 'background', value: '#000' }),
    'a split': (held) => older.withSplit(held, button, ['variant', 'emphasis']),
    'a frame size': (held) => older.withFrameEdit(held, button, '', { kind: 'field', field: 'width', value: 400 }),
    'a renamed variable': (held) => older.renameCanvasVariables(held, (name) => name + '-new'),
    'a moved asset': (held) => older.relinkCanvasAssets(held, 'src/assets/a.png', 'src/assets/b.png'),
    'a renamed component': (held) => older.relinkComponentCanvas(held, button, 'src/components/Action.astro'),
    'a deleted component': (held) => older.dropComponentCanvas(held, (name) => name === button),
  };
  for (const [what, edit] of Object.entries(edits)) {
    const rewritten = older.serializeComponentCanvas(edit(file));
    assert.deepEqual(layoutsOf(rewritten), layoutsOf(source), what);
    assert.ok(parseComponentCanvasSource(rewritten).ok, `${what}: this version reads it back`);
  }
});

test('layouts move with a component this version renames', () => {
  const moved = relinkComponentCanvas(written(), button, 'src/components/Action.astro');
  assert.deepEqual(layoutsOf(serializeComponentCanvas(moved)), {
    'src/components/Action.astro': { [CANVAS_LEVEL]: 'column', 'variant=main': 'wrap' },
    [card]: { [CANVAS_LEVEL]: 'row' },
  });
});

test('1.4.20 refuses a whole file over an unknown key of a component’s, and only warns of a top-level one', () => {
  const inside = JSON.stringify({ version: 1, components: { [button]: { layouts: { [CANVAS_LEVEL]: 'row' } } } });
  const refused = older.parseComponentCanvasSource(inside);
  assert.equal(refused.ok, false);
  assert.ok(older.parseComponentCanvasSource(JSON.stringify({ version: 1, components: {}, levelLayouts: {} })).ok);
  assert.equal(serializeComponentCanvas(EMPTY_CANVAS_FILE), older.serializeComponentCanvas(EMPTY_CANVAS_FILE), 'nothing set: the same bytes');
});
