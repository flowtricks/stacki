// Goal: rootComponent names the component a template opens with, so the insert palette can follow
// a section that reaches <section> through another component, and rootTag keeps its meaning.
// Methodology: feed real-shaped component sources, covering the root being a plain element, a
// component, a destructured tag prop, a variable and nothing at all, then pin that rootTag
// answers the same as before on every one of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rootComponent, rootTag } from '#dist/electron/parse/astroParser.js';
import { safeSchema } from '#dist/electron/properties/propDefaults.js';

const withFrontmatter = (frontmatter: string, template: string): string => `---\n${frontmatter}\n---\n${template}`;

test('a root that is another component is named', () => {
  assert.equal(rootComponent(withFrontmatter('import Section from "./Section.astro";', '<Section class="hero"><slot /></Section>')), 'Section');
  assert.equal(rootComponent('<Container><h1>Hi</h1></Container>'), 'Container');
});

test('wrappers Astro strips are skipped to reach the root', () => {
  assert.equal(rootComponent('<Fragment><Card /></Fragment>'), 'Card');
  assert.equal(rootComponent('<style>.a { color: red }</style><Card />'), 'Card');
});

test('a plain element root has no root component', () => {
  assert.equal(rootComponent('<section class="hero"><Card /></section>'), undefined);
  assert.equal(rootComponent('<div><Card /></div>'), undefined);
});

test('a capitalised name that holds a tag is not a component', () => {
  const alias = withFrontmatter('const { tag: Tag = "h2" } = Astro.props;', '<Tag><slot /></Tag>');
  assert.equal(rootComponent(alias), undefined);
  const variable = withFrontmatter('const Tag = isLink ? "a" : "button";', '<Tag><slot /></Tag>');
  assert.equal(rootComponent(variable), undefined);
});

test('negative space: no template, an empty source and a closing tag alone name nothing', () => {
  assert.equal(rootComponent(''), undefined);
  assert.equal(rootComponent(withFrontmatter('const a = 1;', '')), undefined);
  assert.equal(rootComponent('</Card>'), undefined);
  assert.equal(rootComponent('<slot />'), undefined);
});

test('rootTag answers as it did on every one of those shapes', () => {
  assert.deepEqual(rootTag('<section class="hero"><Card /></section>'), { tag: 'section' });
  assert.equal(rootTag(withFrontmatter('import Section from "./Section.astro";', '<Section><slot /></Section>')), undefined);
  assert.deepEqual(rootTag(withFrontmatter('const { tag: Tag = "h2" } = Astro.props;', '<Tag><slot /></Tag>')), { prop: 'tag', tag: 'h2' });
  assert.deepEqual(rootTag(withFrontmatter('const Tag = isLink ? "a" : "button";', '<Tag><slot /></Tag>')), { options: ['a', 'button'] });
  assert.equal(rootTag(''), undefined);
});

test('the project scan reads it from the file, and an unreadable file gives undefined', () => {
  const directory = path.join(process.cwd(), 'node_modules', '.stacki-test', 'root-component');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'Hero.astro');
  fs.writeFileSync(file, withFrontmatter('import Section from "./Section.astro";', '<Section class="hero"><slot /></Section>'));
  assert.equal(safeSchema(file, directory).rootComponent, 'Section');
  assert.equal(safeSchema(path.join(directory, 'Missing.astro'), directory).rootComponent, undefined);
});
