// Goal: Studio and Desktop use the same inherited titles while preserving route identities.
// Method: scan a temporary alias-based wrapper, validate the HTTP payload and edit live props.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject } from '../src/features/project/projectServer';
import { parseProject } from '../src/features/project/projectClient';
import { livePageTitles, projectPageLabel } from '../src/features/project/pageLabels';
import { parsePage } from '../src/features/source/source';
import { LIMITS } from '../vendor/stacki/shared/core/limits';

const file = 'src/pages/resources.astro';
const source = (props: string) => `---
import Resources from '@/components/Resources.astro';
---
<Resources ${props}><p>Page content</p></Resources>`;

test('Studio scans inherited titles and retains them when live overrides are removed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-page-titles-'));
  try {
    await mkdir(path.join(root, 'src/pages'), { recursive: true });
    await mkdir(path.join(root, 'src/components'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/*'] } },
      }),
    );
    await writeFile(path.join(root, file), source(''));
    await writeFile(
      path.join(root, 'src/components/Resources.astro'),
      `---
import Layout from './Base.astro';
---
<Layout title="The Church Resources"><slot /></Layout>`,
    );
    const project = parseProject(await scanProject(root));
    assert.equal(projectPageLabel(project, file), 'The Church Resources');
    assert.equal(project.pageMetadata?.[0]?.path, file);
    for (const [props, title] of [
      ['', 'The Church Resources'],
      ['title="Worship Team"', 'Worship Team'],
      ['title={dynamic}', 'resources'],
      ['title=""', 'resources'],
    ]) {
      const parsed = parsePage(source(props ?? ''));
      assert.ok(parsed.editable);
      const updated = livePageTitles(project, file, {
        editable: true,
        nodes: parsed.model.nodes,
      });
      assert.equal(projectPageLabel(updated, file), title);
      assert.deepEqual(updated.pages, project.pages);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Studio validates optional title metadata before exposing labels', () => {
  const project = {
    name: 'Site',
    pages: [file],
    collections: [],
    assets: [],
    classes: [],
    components: [],
  };
  assert.deepEqual(parseProject(project).pageMetadata, []);
  const page = { path: file, name: 'resources.astro', route: '/resources' };
  for (const title of [42, {}, [], null, 'x'.repeat(LIMITS.ipcFieldCharsMax + 1)]) {
    assert.throws(() => parseProject({ ...project, pageMetadata: [{ ...page, title }] }));
    assert.throws(() => parseProject({ ...project, pageMetadata: [{ ...page, inheritedTitle: title }] }));
  }
  assert.throws(() => parseProject({ ...project, pageMetadata: {} }));
});

test('Studio uses shared collection template display names', () => {
  const template = 'src/pages/spiritual-development-courses/[slug].astro';
  const project = parseProject({
    name: 'Site',
    pages: [template],
    collections: [],
    assets: [],
    classes: [],
    components: [],
  });
  assert.equal(projectPageLabel(project, template), 'Spiritual Development Courses Template');
  assert.deepEqual(project.pages, [template]);
});
