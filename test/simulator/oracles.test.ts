// Goal: the hostile corpus's oracle scenarios are right, and the step-1
// reference planner agrees with them wherever it plans at all.
// Method: for every oracle step, (1) each hand-derived splice's expected bytes
// sit at its literal byte offset in the input file, (2) applying the splices
// reproduces the hand-written expected file byte for byte, (3) the expected
// file parses and shows the declared kinds at the declared paths, (4) the
// intent a client would author passes the contract, and (5) the reference
// planner either produces exactly the oracle's splices — the same ranges, not
// just the same kinds (plan §3.4: identical bytes at several ranges pass the
// witness, so only the exact range proves the right site) — or rejects with the
// pinned reason for operations planned at a later step.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import type { ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { encodeUtf8 } from '#dist/shared/core/span.js';
import { oracleIntent, oracleSplices } from './oracleIntent.ts';
import { ORACLE_SCENARIOS, type IntentClass } from './oracles.ts';
import { snapshotOf } from './project.ts';
import { planByIdentity } from './referencePlanner.ts';
import { applySplices } from '#dist/shared/engine/splice.js';

const FIXTURES = path.resolve('test/fixtures/editor-core');
const snapshotFile = (name: string) => snapshotOf(toFilePath(`/project/${name}`), encodeUtf8(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));

test('the corpus carries every hard intent class (tracker step 1 corpus gate)', () => {
  const classes = new Set(ORACLE_SCENARIOS.map((scenario) => scenario.intentClass));
  const required: readonly IntentClass[] = [
    'multi-span',
    'kind-changing',
    'multi-file',
    'frontmatter-slot',
    'wrong-site',
    'encoding',
    // Step 10: Markdown and MDX shapes.
    'markdown-list',
    'markdown-fence',
    'mdx-jsx',
    'markdown-gap',
  ];
  assert.deepEqual([...classes].sort(), [...required].sort());
  const multiFile = ORACLE_SCENARIOS.find((scenario) => scenario.intentClass === 'multi-file');
  assert.ok(multiFile !== undefined);
  assert.ok(new Set(multiFile.steps.map((step) => step.file)).size > 1, 'a multi-file gesture spans files');
});

for (const scenario of ORACLE_SCENARIOS) {
  test(`oracle: ${scenario.name}`, () => {
    for (const [index, step] of scenario.steps.entries()) {
      const input = snapshotFile(step.file);
      const expected = snapshotFile(step.expectedFile);
      const splices = oracleSplices(step);
      for (const splice of splices) {
        const found = input.bytes.subarray(splice.range.start, splice.range.end);
        assert.deepEqual(found, splice.expectedBytes, `${step.file}: witness at ${splice.range.start}`);
      }
      assert.deepEqual(applySplices(input.bytes, splices), expected.bytes, `${step.file}: result`);
      const projection = expected.projection;
      assert.equal(projection.tag, 'valid', `${step.expectedFile} parses`);
      if (projection.tag === 'valid') {
        for (const post of step.postKinds) {
          const node: ProjectedNode | undefined = projection.nodes.find((candidate) => candidate.path.join() === post.path.join());
          assert.equal(node?.kind, post.kind, `${step.expectedFile} at ${post.path.join('/')}`);
        }
      }
      const intent = oracleIntent(step, input, toIntentId(`oracle-${index}`));
      const planned = planByIdentity(input, intent);
      if (step.reference === 'agrees') {
        assert.ok(planned.ok, `reference planner plans ${step.file}`);
        assert.deepEqual(planned.value.splices, splices, `${step.file}: exact splices`);
      } else {
        assert.deepEqual(planned, { ok: false, error: step.reference });
      }
    }
  });
}

test('a stale oracle intent is refused, never re-targeted (identity mapping only)', () => {
  const [step] = ORACLE_SCENARIOS.find((scenario) => scenario.intentClass === 'wrong-site')?.steps ?? [];
  assert.ok(step !== undefined);
  const input = snapshotFile(step.file);
  const intent = oracleIntent(step, input, toIntentId('stale'));
  // A card inserted above moves every byte; step 2 maps or rejects, step 1 rejects.
  const shifted = snapshotOf(input.path, encodeUtf8(`<Card title="Old" />\n${fs.readFileSync(path.join(FIXTURES, step.file), 'utf8')}`));
  assert.deepEqual(planByIdentity(shifted, intent), { ok: false, error: 'anchor-moved' });
});

test('duplicate attribute names make a file source-invalid, as does a file that does not parse', () => {
  // A tag that writes one attribute twice is refused by the parser (0a1cb3e6: an edit could keep only one copy),
  // so the file never projects and no anchor can be ambiguous between the copies.
  const page = snapshotFile('conditional-template.astro');
  assert.equal(page.projection.tag, 'valid');
  if (page.projection.tag !== 'valid') {
    return;
  }
  const multi = page.projection.nodes.find((node) => node.capability === 'editable' && node.attributes.some((attribute) => attribute.name === 'data-x'));
  assert.ok(multi !== undefined, 'the fixture has an editable node with an expression attribute');
  const step = {
    file: 'conditional-template.astro',
    expectedFile: 'conditional-template.astro',
    anchor: { path: multi.path, kind: multi.kind },
    operation: () => ({
      tag: 'set-attribute' as const,
      name: 'class',
      value: { type: 'string' as const, value: 'c' },
    }),
    splices: [],
    postKinds: [],
    reference: 'source-invalid' as const,
  };
  const intent = oracleIntent(step, page, toIntentId('dup'));
  const text = fs.readFileSync(path.join(FIXTURES, 'conditional-template.astro'), 'utf8');
  const duplicated = snapshotOf(toFilePath('/project/duplicated.astro'), encodeUtf8(`${text}<p class="a" class="b">Duplicated class</p>\n`));
  assert.equal(duplicated.projection.tag, 'parse-error');
  assert.deepEqual(planByIdentity(duplicated, { ...intent, file: duplicated.path }), { ok: false, error: 'source-invalid' });
  const broken = snapshotFile('malformed.astro');
  assert.equal(broken.projection.tag, 'parse-error');
  assert.deepEqual(planByIdentity(broken, { ...intent, file: broken.path }), {
    ok: false,
    error: 'source-invalid',
  });
});
