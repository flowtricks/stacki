// Goal: `stacki components rename "Accordion Cards"` normalizes exactly like the Rename dialog: AccordionCards in a PascalCase project,
// accordion-cards in a dashed one (the import identifier stays AccordionCards, and the tags and imports are rewritten to it), the plan
// says the name was normalized, and a name with a character that cannot be kept is refused with the character named and nothing written.
// Method: generated projects, the real command runner in plan and apply mode, whole-tree comparison for the refusal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import '#dist/electron/handlers/cliComponentCommands.js';
import { runCommand, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { makeProject, readText, removeProjects } from '../../helpers/cliProject.ts';
import { snapshotTree } from '../../helpers/cliTree.ts';

afterEach(() => removeProjects());

const request = (root: string, name: string, apply: 'apply' | 'plan'): RunRequest => ({
  words: ['components', 'rename'],
  args: { path: 'src/components/Card.astro', name },
  project: root,
  role: { role: undefined },
  apply,
  yes: 'no',
  waitSeconds: 0,
});

const PAGE = "---\nimport Card from '../components/Card.astro';\n---\n<Card />\n";

test('a spaced name becomes PascalCase in a PascalCase project, with a note, and rewrites imports and tags', async () => {
  const root = makeProject({ 'src/components/Card.astro': '<div />\n', 'src/components/Hero.astro': '<p />\n', 'src/pages/index.astro': PAGE });
  const plan = await runCommand(request(root, 'Accordion Cards', 'plan'));
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.ok(plan.notes.some((note) => note.includes('normalized from "Accordion Cards"')));
  const applied = await runCommand(request(root, 'Accordion Cards', 'apply'));
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.ok(fs.existsSync(path.join(root, 'src/components/AccordionCards.astro')));
  const page = readText(root, 'src/pages/index.astro') ?? '';
  assert.match(page, /import AccordionCards from '\.\.\/components\/AccordionCards\.astro';/);
  assert.match(page, /<AccordionCards \/>/);
});

test('in a dashed project the file is dashed and the identifier stays PascalCase', async () => {
  const root = makeProject({
    'src/components/Card.astro': '<div />\n',
    'src/components/hero-banner.astro': '<p />\n',
    'src/components/site-footer.astro': '<p />\n',
    'src/pages/index.astro': PAGE,
  });
  const applied = await runCommand(request(root, 'Accordion Cards', 'apply'));
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.ok(fs.existsSync(path.join(root, 'src/components/accordion-cards.astro')));
  const page = readText(root, 'src/pages/index.astro') ?? '';
  assert.match(page, /import AccordionCards from '\.\.\/components\/accordion-cards\.astro';/);
  assert.match(page, /<AccordionCards \/>/);
});

test('a name with a character that cannot be kept is refused, naming it, and nothing is written', async () => {
  const root = makeProject({ 'src/components/Card.astro': '<div />\n', 'src/pages/index.astro': PAGE });
  const before = snapshotTree(root);
  const result = await runCommand(request(root, 'Card 🙂', 'apply'));
  assert.ok(!result.ok);
  assert.match(JSON.stringify(result), /🙂/);
  assert.deepEqual(snapshotTree(root), before);
});
