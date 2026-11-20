// Goal: the "N fixes ready" planner describes exactly the fixes Apply makes: one description per fixable finding up to
// the cap, in the same order, each with its audit, file, element and a one-line change (a raw CSS value reads
// `padding: 0.9375rem` to `var(--space-m)`; markup shows only the tokens that differ); past the cap the count of the
// rest is reported, and the view's plan holds the very findings its `fixable` list holds, so the count, the list and
// Apply cannot diverge.
// Method: bundle the real planner and view with esbuild and call them on findings written here, valid ones and the
// edge cases: no fixes, exactly the cap, one past it, a fix that adds an attribute, one that renames, a long value,
// an ignored finding, and a finding without a fix (which the planner refuses, as a programmer error).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/fix-plan.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { planFixes, changeLine, differing, FIX_DESCRIPTIONS_MAX, CHANGE_CHARS_MAX } from './src/features/audits/fixPlan';",
      "export { auditView } from './src/features/audits/auditView';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { planFixes, changeLine, differing, FIX_DESCRIPTIONS_MAX, CHANGE_CHARS_MAX, auditView } = require(output);

let counter = 0;
function finding(check, extra) {
  counter += 1;
  return {
    id: `${check}:${counter}`,
    check,
    file: 'src/pages/index.astro',
    fileKind: 'page',
    element: { path: [0, counter], tag: 'img', line: counter },
    detail: '',
    source: 'static',
    fix: undefined,
    ...extra,
  };
}
const fixOf = (before, after, label = 'Add alt') => ({ label, before, after, file: 'src/pages/index.astro', edits: [] });
const fixable = (count) =>
  Array.from({ length: count }, (_, index) => finding('img-alt', { fix: fixOf(`<img src="/a${index}.png">`, `<img src="/a${index}.png" alt="">`) }));

test('no fixes make an empty plan', () => {
  const plan = planFixes([]);
  assert.deepEqual([plan.findings.length, plan.descriptions.length, plan.hiddenCount], [0, 0, 0]);
});

test('every fix up to the cap is described, in order, and none is hidden', () => {
  const findings = fixable(FIX_DESCRIPTIONS_MAX);
  const plan = planFixes(findings);
  assert.equal(plan.descriptions.length, FIX_DESCRIPTIONS_MAX);
  assert.equal(plan.hiddenCount, 0);
  assert.deepEqual(
    plan.descriptions.map((description) => description.id),
    findings.map((item) => item.id),
  );
});

test('one past the cap says how many more, and Apply still holds them all', () => {
  const findings = fixable(FIX_DESCRIPTIONS_MAX + 3);
  const plan = planFixes(findings);
  assert.equal(plan.descriptions.length, FIX_DESCRIPTIONS_MAX);
  assert.equal(plan.hiddenCount, 3);
  assert.equal(plan.findings.length, FIX_DESCRIPTIONS_MAX + 3);
  assert.equal(plan.findings, findings);
});

test('a description names the audit, the file, the element and the label', () => {
  const [only] = planFixes(fixable(1)).descriptions;
  assert.equal(only.check, 'img-alt');
  assert.equal(only.file, 'src/pages/index.astro');
  assert.equal(only.element.tag, 'img');
  assert.equal(only.label, 'Add alt');
});

test('markup changes show only the tokens that differ', () => {
  assert.deepEqual(differing('<h1 id="hero">', '<h1 id="hero-2">'), { before: 'hero', after: 'hero-2' });
  assert.deepEqual(differing('<img src="/a.png">', '<img src="/a.png" alt="">'), { before: '', after: 'alt=""' });
  assert.deepEqual(differing('<html>', '<html lang="en">'), { before: '', after: 'lang="en"' });
});

test('a raw value reads property: value to the variable', () => {
  const change = changeLine({ css: { property: 'padding', value: '0.9375rem' } }, fixOf('', '', 'Use var(--space-m)'));
  assert.deepEqual(change, { before: 'padding: 0.9375rem', after: 'var(--space-m)' });
});

test('a long change is clipped to the limit with an ellipsis', () => {
  const long = 'x'.repeat(CHANGE_CHARS_MAX * 2);
  const change = differing(`<p>${long}</p>`, `<p>${long}y</p>`);
  assert.ok(change.after.length <= CHANGE_CHARS_MAX);
  assert.ok(change.after.endsWith('…'));
});

test('a finding without a fix is a programmer error', () => {
  assert.throws(() => planFixes([finding('img-alt', {})]), /every planned finding has a fix/);
});

test('the view plans exactly its fixable findings and skips ignored ones', () => {
  const findings = fixable(3);
  const view = auditView({ findings, ignored: new Set([findings[1].id]), filter: 'all', search: '', showIgnored: false });
  assert.equal(view.fixable.length, 2);
  assert.equal(view.fixPlan.findings, view.fixable);
  assert.deepEqual(
    view.fixPlan.descriptions.map((description) => description.id),
    [findings[0].id, findings[2].id],
  );
});
