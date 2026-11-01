// Pin the migration's state lifecycles and limits. Bundle renderer source with
// esbuild, then exercise real exports with valid values and values at the bounds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

// The DOM answers "none" with null. The fakes below that stand in for DOM APIs
// return the platform's own value, read from JSON because our code never writes one.
const PLATFORM_NULL = JSON.parse('null');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-renderer-leaves-'));
const load = (file) => {
  const output = path.join(directory, `${path.basename(file, '.ts')}.cjs`);
  esbuild.buildSync({
    entryPoints: [repoPath(file)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  return require(output);
};

try {
  const { requestAsset, onAssetRequest, clearAssetRequest, getPendingAsset } = load('src/ui/assetPick.ts');
  const first = [];
  const second = [];
  const unsubscribe = onAssetRequest((request) => first.push(request));
  onAssetRequest((request) => second.push(request));
  unsubscribe(); // A stale listener must never unsubscribe its replacement.
  const request = { mediaKind: 'image', current: '', onPick() {} };
  requestAsset(request);
  assert.equal(getPendingAsset(), request);
  clearAssetRequest();
  assert.deepEqual(first, []);
  assert.deepEqual(second, [request, undefined]);
  assert.equal(getPendingAsset(), undefined);

  const { setDrag, getDrag, clearDrag } = load('src/editor/dragState.ts');
  setDrag({ kind: 'component', name: 'Card' });
  assert.deepEqual(getDrag(), { kind: 'component', name: 'Card' });
  clearDrag();
  assert.equal(getDrag(), undefined);

  const { renamedAttr } = load('src/editor/attrOrder.ts');
  const value = { type: 'expr', value: 'someCall()', metadata: 'preserve' };
  const node = { props: { old: value }, attrOrder: ['old'] };
  const renamed = renamedAttr(node, 'old', 'new');
  assert.equal(renamed.props.new, value);
  assert.deepEqual(renamed.attrOrder, ['new']);
  assert.deepEqual(node, { props: { old: value }, attrOrder: ['old'] }, 'the node is not edited');
  const tooLong = 'x'.repeat(8193);
  assert.throws(() => renamedAttr(renamed, 'new', tooLong), /Attribute name exceeds limit/);

  const { checkStatement } = load('src/features/props/jsCheck.ts');
  assert.equal(checkStatement(' '.repeat(1_000_000)).ok, true);
  assert.deepEqual(checkStatement(' '.repeat(1_000_001)), {
    ok: false,
    message: 'This statement exceeds the editor size limit.',
  });
  const { componentNameError } = load('src/features/palette/componentName.ts');
  assert.equal(componentNameError('Card', Array(10_000).fill('Other')), undefined);
  assert.throws(() => componentNameError('Card', Array(10_001).fill('Other')), /scan limit/);

  const { onePerPlace } = load('src/features/preview/outlineBoxes.ts');
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(onePerPlace([box, { ...box }, { x: 1, y: 1, w: 2, h: 2 }]), [box]);
  assert.deepEqual(onePerPlace(Array.from({ length: 20_000 }, () => ({ ...box }))), [box]);
  assert.throws(() => onePerPlace(Array(20_001).fill(box)), /Outline box count exceeds limit/);

  const { rankInsertItems } = load('src/features/palette/insertRank.ts');
  assert.equal(rankInsertItems(Array(10_000).fill({ name: 'Card' }), '').length, 10_000);
  assert.throws(() => rankInsertItems(Array(10_001).fill({ name: 'Card' }), ''), /item count/);
  const { elementClasses } = load('src/editor/classNames.ts');
  assert.throws(
    () =>
      elementClasses({
        props: { class: { type: 'expr', value: 'x'.repeat(1_000_001) } },
      }),
    /Class expression exceeds size limit/,
  );

  const { decideTerminalPaste } = load('src/features/terminal/terminalPaste.ts');
  const item = { type: 'text/plain', kind: 'string', getAsFile: () => PLATFORM_NULL };
  assert.deepEqual(decideTerminalPaste([item], 'hello', undefined, 'posix'), { kind: 'text' });
  assert.throws(() => decideTerminalPaste(Array(10_001).fill(item), '', undefined, 'posix'), /item count/);
  const { findWithParent, isInlineRun } = load('src/editor/treeSelection.ts');
  const cycle = { id: 'cycle', kind: 'element', name: 'span', children: [] };
  cycle.children.push(cycle);
  assert.throws(() => findWithParent([cycle], 'missing'), /Tree traversal exceeds depth limit/);
  assert.throws(() => isInlineRun([cycle]), /Tree traversal exceeds depth limit/);
  const leaf = { id: 'text', kind: 'text', value: 'hello' };
  assert.equal(isInlineRun(Array(20_000).fill(leaf)), true);
  assert.throws(() => isInlineRun(Array(20_001).fill(leaf)), /Tree traversal exceeds node limit/);
  const { liveClassesById } = load('src/editor/liveClasses.ts');
  assert.throws(() => liveClassesById({}, [cycle]), /Tree traversal exceeds depth limit/);
  const { propsForExtraction } = load('src/editor/extractProps.ts');
  assert.throws(() => propsForExtraction(cycle, ['title']), /Tree traversal exceeds depth limit/);
  const { evaluate } = load('src/features/variables/fluid.ts');
  assert.equal(evaluate('(2rem + 16px) * 2', 0), 6);
  assert.equal(evaluate('('.repeat(66) + '1' + ')'.repeat(66), 0), undefined);
  assert.equal(evaluate('1'.repeat(1_000_001), 0), undefined);

  console.log('renderer-leaves: state replacement, cancellation, metadata and limits passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
