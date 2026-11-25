// Goal: frontmatter survives the round trip byte for byte — declarations
// before, between and after imports, every import form, and text that only
// looks like an import — while its declarations stay editable to bindings.
// Method: one interleaved frontmatter source is read and written through the
// built frontmatter and parser modules; tests edit imports and declarations and
// compare the written text with the expected source.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFrontmatter, writeFrontmatter } = require('#dist/shared/page/frontmatterSource.js');
const { parsePage, serializePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');
const { repoPath } = require('../../helpers/sources.js');

const SOURCE = `---

const heading = 'Before imports';
import Layout from '../layouts/Layout.astro';

const title = 'Between imports';

import Footer from '../components/Footer.astro';

const year = 2026;

---
<Layout title={title}>
  <p>{heading}</p>
  <Footer year={year} />
</Layout>
`;

test('source slots preserve frontmatter after real markup and import edits', () => {
  const model = parsePage(SOURCE).model;
  assert.equal(serializePage(model), SOURCE);
  model.nodes[0].props.title.value = 'heading';
  assert.equal(serializePage(model), SOURCE.replace('<Layout title={title}>', '<Layout title={heading}>'));

  model.imports[1].path = '../components/NewFooter.astro';
  assert.ok(serializePage(model).includes("const title = 'Between imports';\n\nimport Footer from '../components/NewFooter.astro';"));
  model.imports[1].name = 'NewFooter';
  assert.ok(serializePage(model).includes("import NewFooter from '../components/NewFooter.astro';"));
  model.imports.push({ name: 'Card', path: '../components/Card.astro' });
  const added = serializePage(model);
  assert.ok(added.indexOf('import Card') > added.indexOf('import NewFooter'));
  assert.ok(added.indexOf('import Card') < added.indexOf('const year'));
  model.imports = model.imports.filter((imp) => imp.name !== 'NewFooter');
  const removed = serializePage(model);
  assert.ok(!removed.includes('import NewFooter'));
  assert.ok(removed.indexOf('const title') < removed.indexOf('import Card'));
  assert.ok(removed.indexOf('import Card') < removed.indexOf('const year'));
  assert.equal(serializePage(parsePage(removed).model), removed, 'subsequent saves are stable');
});

test('declarations before and between imports ' + 'remain available and editable to bindings', async () => {
  const outfile = repoPath('node_modules/.stacki-test/frontmatter-bindings.bundle.js');
  await require('esbuild').build({
    entryPoints: [repoPath('src/editor/dataSuggest.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { parseDeclarations, findDeclaration } = require(outfile);
  const model = parsePage(SOURCE).model;
  assert.deepEqual([...parseDeclarations(model.extraFrontmatter).keys()], ['heading', 'title', 'year']);
  for (const name of ['heading', 'title']) {
    const declaration = findDeclaration(model.extraFrontmatter, name);
    assert.ok(declaration, `${name} is offered by the source editor`);
    model.extraFrontmatter =
      model.extraFrontmatter.slice(0, declaration.start) +
      declaration.statement.replace(/'[^']*'/, `'Edited ${name}'`) +
      model.extraFrontmatter.slice(declaration.end);
  }
  assert.equal(serializePage(model), SOURCE.replace("'Before imports'", "'Edited heading'").replace("'Between imports'", "'Edited title'"));

  const location = findDeclaration(model.extraFrontmatter, 'heading');
  model.extraFrontmatter = model.extraFrontmatter.slice(0, location.end) + '\nconst inserted = [1, 2, 3];' + model.extraFrontmatter.slice(location.end);
  const output = serializePage(model);
  assert.ok(output.indexOf('const inserted') < output.indexOf('import Layout'));
  assert.ok(output.indexOf('const title') < output.indexOf('import Footer'));
  assert.equal(serializePage(parsePage(output).model), output);
});

test('named declarations keep separate source positions and support member edits', () => {
  const raw = "import { Image as Picture, type ImageMetadata } from 'astro:assets';\nconst x = 1;\n" + "import { getImage } from 'astro:assets';\n";
  const model = readFrontmatter(raw);
  assert.equal(writeFrontmatter(model), raw);
  model.imports.push({
    name: 'PictureComponent',
    imported: 'Picture',
    path: 'astro:assets',
    named: true,
  });
  assert.equal(writeFrontmatter(model), raw.replace('ImageMetadata }', 'ImageMetadata, Picture as PictureComponent }'));
  model.imports = model.imports.filter((imp) => imp.name !== 'Picture');
  assert.equal(writeFrontmatter(model), raw.replace('Image as Picture, type ImageMetadata', 'type ImageMetadata, Picture as PictureComponent'));
  const getImage = model.imports.find((imp) => imp.name === 'getImage');
  getImage.path = 'other-assets';
  assert.ok(writeFrontmatter(model).includes("const x = 1;\nimport { getImage } from 'other-assets';"));
});

test('all import forms survive the shared code-editor read/write cycle', () => {
  const raw = `/** Component notes. */
import 'site/reset.css';
import type { Props } from './types';
import * as Icons from './icons';
import Default, { named as alias } from './mixed';
import { /* supported by Astro */ Icon } from './commented';
import data from './data.json' with { type: 'json' };
import { Image as Picture, type ImageMetadata } from 'astro:assets';
const title = 'Original';
`;
  assert.equal(writeFrontmatter(readFrontmatter(raw)), raw);
  const edited = raw.replace("'Original'", "'Changed'").replace('Image as Picture', 'Image as OptimizedPicture');
  const model = readFrontmatter(edited);
  assert.equal(writeFrontmatter(model), edited);
  assert.equal(model.imports.find((imp) => imp.name === 'OptimizedPicture').imported, 'Image');
  model.imports.find((imp) => imp.name === 'data').path = './updated.json';
  assert.equal(writeFrontmatter(model), edited.replace('./data.json', './updated.json'), 'import attributes survive a path edit');
});

test('import-looking strings, templates, regexes and comments remain code', () => {
  const raw = `// import Fake from 'fake';
/* import Other from 'other'; */
const example = "import Text from 'text';";
const pattern = /import Pattern from 'pattern'/;
const template = \`import Template from 'template'; \${\`import Nested from 'nested';\`}\`;
import Real from 'real';
`;
  const model = readFrontmatter(raw);
  assert.deepEqual(
    model.imports.map((imp) => imp.name),
    ['Real'],
  );
  assert.equal(writeFrontmatter(model), raw);
});

test('leading and trailing blank lines survive declaration and import changes', () => {
  for (const content of ['', '\n', '\n\n', '\nconst title = 1;\n\n']) {
    const source = `---\n${content}---\n<p>Body</p>\n`;
    const model = parsePage(source).model;
    assert.equal(serializePage(model), source);
    model.nodes[0].children[0].value = 'Updated';
    assert.equal(serializePage(model), source.replace('Body', 'Updated'));
  }
  const model = readFrontmatter('\nconst title = 1;\n\n');
  model.imports.push({ name: 'Card', path: './Card.astro' });
  assert.equal(writeFrontmatter(model), "\nimport Card from './Card.astro';\nconst title = 1;\n\n");
});

test('preview import rewrites preserve interleaved frontmatter', () => {
  const model = parsePage(
    "---\nconst heading = 'Heading';\nimport chunk from './chunk.html?raw';\n" + 'const year = 2026;\n---\n<Fragment set:html={chunk} />\n',
  ).model;
  model.nodes[0].chunkFile = '/project/chunk.html';
  const marked = serializePageMarked(model);
  assert.ok(marked.includes("const heading = 'Heading';\nimport chunk from './chunk.html?raw&avb=0';\nconst year = 2026;"));
});

test('rewriting declarations never moves an import into a template or function', () => {
  const model = readFrontmatter("const start = 1;\nimport A from 'a';\nconst end = 2;\n");
  for (const replacement of [
    'const wrapped = `\nconst start = 1;\nconst end = 2;\n`;',
    'function wrapped() {\nconst start = 1;\nconst end = 2;\n}',
    'const wrapped =\n[\n1,\n2,\n];',
  ]) {
    model.extraFrontmatter = replacement;
    const output = writeFrontmatter(model);
    assert.ok(output.includes(replacement));
    const at = output.indexOf('import A');
    const start = output.indexOf(replacement);
    assert.ok(at < start || at >= start + replacement.length, output);
    assert.deepEqual(
      readFrontmatter(output).imports.map((imp) => imp.name),
      ['A'],
    );
  }
});
