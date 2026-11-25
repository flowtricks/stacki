import assert from 'node:assert/strict';
import test from 'node:test';
import { slotOptions } from '../src/features/settings/slotOptions';
import type { Project } from '../src/features/project/projectClient';

const project: Project = {
  name: 'Slots',
  pages: [],
  collections: [],
  assets: [],
  classes: [],
  components: [
    { name: 'Layout', file: 'src/layouts/Layout.astro', fields: [], slots: ['default', 'head'] },
    {
      name: 'Section',
      file: 'src/components/Section.astro',
      fields: [],
      slots: ['default', 'background'],
    },
  ],
};
const source = `---
import Layout from '../layouts/Layout.astro';
import Wrapper from '@/components/Section.astro';
---
<Layout><Wrapper><h2>Title</h2><div><p>Nested</p></div></Wrapper></Layout>`;
test('slot assignment reads the direct component or layout parent, including import aliases', () => {
  const options = (selected: string) => slotOptions(project, 'src/pages/index.astro', source, selected);
  assert.deepEqual(options('n0.0'), ['default', 'head']);
  assert.deepEqual(options('n0.0.0'), ['default', 'background']);
  assert.equal(options('n0.0.1.0'), undefined);
  assert.equal(options('layout'), undefined);
});
