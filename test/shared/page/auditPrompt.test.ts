// Goal: the "Fix with AI" prompt states every finding with its file, line,
// element path, reason and reference, groups findings by file, says when a fix
// in a component changes every use, quotes Stacki's project rules, and stays
// bounded; bulk hand-offs split into bounded parts. Grouping and ordering of
// findings is pinned alongside, since the prompt and the panel share it.
// Method: build findings with `auditFinding`, render prompts, and pin the
// lines that matter and the context the task carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_PROMPT_FINDINGS_MAX, STACKI_PROJECT_RULES, auditPrompt, promptBatches } from '#dist/shared/page/auditPrompt.js';
import { auditFinding, findingId, groupedFindings, safeFixes, uniqueFindings, type AuditFinding } from '#dist/shared/page/auditFindings.js';

const finding = (over: Pick<AuditFinding, 'check' | 'file'> & Partial<Pick<AuditFinding, 'fileKind' | 'source' | 'detail'>>): AuditFinding =>
  auditFinding({
    fileKind: 'page',
    element: { path: [0, 2], tag: 'img', line: 12 },
    detail: 'src="/a.png"',
    source: 'static',
    fix: undefined,
    ...over,
  });

test('one finding: its title, where, why and reference, and the project rules', () => {
  const task = auditPrompt([finding({ check: 'img-alt', file: 'src/pages/index.astro' })], 'acme');
  assert.equal(task.title, 'Fix: Missing alt text');
  assert.match(task.prompt, /Astro project "acme"/);
  assert.match(task.prompt, /## src\/pages\/index\.astro\n/);
  assert.match(task.prompt, /1\. Missing alt text — src="\/a\.png"/);
  assert.match(task.prompt, /Where: <img> on line 12, element path 0\.2/);
  assert.match(task.prompt, /Reference: WCAG 2\.2 SC 1\.1\.1/);
  for (const rule of STACKI_PROJECT_RULES) {
    assert.ok(task.prompt.includes(rule), rule);
  }
  assert.deepEqual(task.context.files, ['src/pages/index.astro']);
  assert.deepEqual(task.context.nodeRefs, [{ file: 'src/pages/index.astro', path: [0, 2] }]);
  assert.equal(task.context.findingIds.length, 1);
});

test('several files: one section each, components say a fix changes every use', () => {
  const task = auditPrompt(
    [
      finding({ check: 'link-name', file: 'src/pages/b.astro' }),
      finding({ check: 'contrast', file: 'src/components/Card.astro', fileKind: 'component', source: 'rendered' }),
    ],
    'acme',
  );
  assert.equal(task.title, 'Fix 2 audit findings');
  assert.ok(task.prompt.indexOf('## src/components/Card.astro') < task.prompt.indexOf('## src/pages/b.astro'), 'sections sorted by file');
  assert.match(task.prompt, /a component: a fix here changes every page that uses it/);
  assert.match(task.prompt, /seen in the rendered page/);
});

test('hand-offs are bounded and split into parts', () => {
  assert.throws(() => auditPrompt([], 'acme'), /at least one/);
  const many = Array.from({ length: AUDIT_PROMPT_FINDINGS_MAX * 2 + 1 }, (_, index) => finding({ check: 'img-alt', file: `src/pages/p${index}.astro` }));
  assert.throws(() => auditPrompt(many, 'acme'), /bounded/);
  const parts = promptBatches(many);
  assert.deepEqual(
    parts.map((part) => part.length),
    [AUDIT_PROMPT_FINDINGS_MAX, AUDIT_PROMPT_FINDINGS_MAX, 1],
  );
});

test('findings group by priority, order by file and path, and dedupe preferring static', () => {
  const high = finding({ check: 'img-alt', file: 'src/pages/b.astro' });
  const low = finding({ check: 'link-text', file: 'src/pages/a.astro' });
  const groups = groupedFindings([low, high]);
  assert.deepEqual([...groups.keys()], ['high', 'medium', 'low']);
  assert.deepEqual(groups.get('high'), [high]);
  assert.deepEqual(groups.get('low'), [low]);
  const rendered = finding({ check: 'img-alt', file: 'src/pages/b.astro', source: 'rendered' });
  assert.equal(rendered.id, high.id);
  assert.deepEqual(uniqueFindings([rendered, high]), [high]);
  assert.deepEqual(safeFixes([high]), []);
  assert.equal(findingId({ check: 'robots', file: 'public/robots.txt', element: undefined, detail: 'x' }), 'robots|public/robots.txt|-|x');
  assert.equal(finding({ check: 'img-alt', file: 'f', detail: 'x'.repeat(500) }).detail.length, 240);
});
