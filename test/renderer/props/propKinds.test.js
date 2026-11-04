// Goal: the instance panel's choices for props whose value only code can give
// (src/features/props/propKinds.ts): an action always gets the read-only
// "Set in code" row, `any` and the like get it while unset, an object prop is
// edited as its fields only when they are simple, a mixed choice writes
// `flag={true}` rather than `flag="true"`, and `url` names a link.
//
// Methodology: the module is bundled with esbuild and its pure functions are
// called on fields shaped as the scan sends them. Every answer is paired with
// the nearby case that must answer differently. The mounted panel is covered
// end to end by the prop zoo (test/renderer/props/propZoo.test.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before } = require('node:test');
const { repoPath } = require('../../helpers/sources.js');

let kinds;
before(async () => {
  const esbuild = require('esbuild');
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const out = path.join(directory, 'prop-kinds.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/props/propKinds.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  kinds = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
});

test('an action is always set in code; an opaque value only while unset', () => {
  const action = { codeKind: 'function' };
  const opaque = { codeKind: 'opaque' };
  assert.equal(kinds.codeRowKind(action, undefined), 'action');
  assert.equal(kinds.codeRowKind(action, { type: 'expr', value: '() => 1' }), 'action');
  assert.equal(kinds.codeRowKind(opaque, undefined), 'code');
  assert.equal(kinds.codeRowKind(opaque, { type: 'expr', value: '{ a: 1 }' }), undefined);
  assert.equal(kinds.codeRowKind({}, undefined), undefined);
  assert.equal(kinds.codeRowKind({ codeKind: 'object' }, undefined), undefined);
});

test('the code row shows the value set, else the default', () => {
  assert.equal(kinds.codeRowValue({ default: '(item) => String(item)' }, undefined), '(item) => String(item)');
  assert.equal(kinds.codeRowValue({ default: '(item) => String(item)' }, { type: 'expr', value: '(x) => x' }), '(x) => x');
  assert.equal(kinds.codeRowValue({}, { type: 'string', value: 'a "b"' }), '"a \\"b\\""');
  assert.equal(kinds.codeRowValue({}, { type: 'bare' }), 'true');
  assert.equal(kinds.codeRowValue({}, undefined), undefined);
  assert.equal(kinds.codeRowValue({ default: 3 }, undefined), '3');
});

test('an object is edited as fields only when they are simple', () => {
  assert.equal(kinds.objectSeed({ default: '{ dense: false }' }, ''), '{ dense: false }');
  assert.equal(kinds.objectSeed({}, '{ dense: true }'), '{ dense: true }');
  assert.equal(
    kinds.objectSeed(
      {
        shape: [
          { name: 'label', type: 'string' },
          { name: 'count', type: 'number' },
          { name: 'open', type: 'boolean' },
        ],
      },
      '',
    ),
    '{ label: "", count: 0, open: false }',
  );
  // Negative space: a nested object, a call or a member of another kind stays in code.
  assert.equal(kinds.objectSeed({}, "{ link: { href: '/' } }"), undefined);
  assert.equal(kinds.objectSeed({ default: 'makeConfig()' }, ''), undefined);
  assert.equal(
    kinds.objectSeed(
      {
        shape: [
          { name: 'label', type: 'string' },
          { name: 'link', type: 'code' },
        ],
      },
      '',
    ),
    undefined,
  );
  assert.equal(kinds.objectSeed({ shape: [{ name: 'label', type: 'string' }], shapeIsList: true }, ''), undefined);
  assert.equal(kinds.objectSeed({}, ''), undefined);
});

test('a mixed choice writes its non-word options as expressions', () => {
  const flag = { options: ['true', 'false', 'auto'], expressionOptions: ['true', 'false'] };
  assert.deepEqual(kinds.optionAttr(flag, 'true'), { type: 'expr', value: 'true' });
  assert.deepEqual(kinds.optionAttr(flag, 'auto'), { type: 'string', value: 'auto' });
  assert.deepEqual(kinds.optionAttr({ numeric: true }, '3'), { type: 'expr', value: '3' });
  assert.deepEqual(kinds.optionAttr({}, 'sm'), { type: 'string', value: 'sm' });
  assert.throws(() => kinds.optionAttr({}, ''), /Assertion failed: optionAttr/);
  assert.equal(kinds.optionValue({ numeric: true }, '3'), 3);
  assert.equal(kinds.optionValue({ expressionOptions: ['0'] }, '0'), 0);
  assert.equal(kinds.optionValue(flag, 'true'), undefined);
  assert.equal(kinds.optionValue(flag, 'auto'), 'auto');
  assert.equal(kinds.previewsOptions(flag), false);
  assert.equal(kinds.previewsOptions({ expressionOptions: ['0', '1'] }), true);
  assert.equal(kinds.previewsOptions({}), true);
});

test('href, url and link names are links, for text props only', () => {
  assert.equal(kinds.isLinkProp({ name: 'url', type: 'string' }), true);
  assert.equal(kinds.isLinkProp({ name: 'pageUrl', type: 'other' }), true);
  assert.equal(kinds.isLinkProp({ name: 'href', type: 'string' }), true);
  assert.equal(kinds.isLinkProp({ name: 'urlPattern', type: 'string' }), false);
  assert.equal(kinds.isLinkProp({ name: 'url', type: 'number' }), false);
  assert.equal(kinds.isLinkProp({ name: 'label', type: 'string' }), false);
});
