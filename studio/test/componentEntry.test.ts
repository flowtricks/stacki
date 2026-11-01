import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../src/features/source/source';
import { openingSelection } from '../src/features/project/openingSelection';
import { componentAt } from '../src/features/project/componentEntry';
import type { Project } from '../src/features/project/projectClient';

test('component entry skips control flow, fragments and inert markup', () => {
  const parsed = parsePage(
    '---\nconst Tag = "h2"; const show = true;\n---\n<script>console.log(1)</script>\n{show && (<Fragment><Tag class="heading">Hello</Tag></Fragment>)}',
  );
  assert.ok(parsed.editable);
  const selected = openingSelection('src/components/Heading.astro', parsed.model.nodes);
  assert.equal(selected?.name, 'Tag');
  assert.ok(selected?.dynamicTag);
  assert.notEqual(selected?.id, 'layout');
});

test('layout entry selects body while pages retain their outer wrapper', () => {
  const layout = parsePage('<html><head><title>Site</title></head><body><main><slot /></main></body></html>');
  assert.ok(layout.editable);
  assert.equal(openingSelection('src/layouts/BaseLayout.astro', layout.model.nodes)?.name, 'body');
  const page = parsePage('---\nimport Layout from "@/layouts/BaseLayout.astro";\n---\n<Layout><h1>Hello</h1></Layout>');
  assert.ok(page.editable);
  assert.equal(openingSelection('src/pages/index.astro', page.model.nodes)?.id, 'layout');
  assert.equal(openingSelection('src/components/Empty.astro', []), undefined);
});

test('component entry resolves local import aliases instead of matching a duplicate filename', () => {
  const project: Project = {
    name: 'test',
    pages: [],
    collections: [],
    assets: [],
    classes: [],
    components: [
      { file: 'src/components/one/Card.astro', name: 'Card', fields: [], slots: [] },
      { file: 'src/components/two/Card.astro', name: 'Card', fields: [], slots: [] },
    ],
  };
  const parsed = parsePage('---\nimport Feature from "../components/two/Card.astro";\n---\n<Feature />');
  assert.ok(parsed.editable);
  const node = parsed.model.nodes.find((node) => node.name === 'Feature');
  assert.ok(node?.id);
  assert.equal(componentAt(project, 'src/pages/index.astro', parsed, node.id)?.file, 'src/components/two/Card.astro');
});
