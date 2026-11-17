// Goal: creating a component writes it into the folder chosen below the components root, root by default; a nested folder that
// does not exist yet is listed for the caller to make and taken back by Undo once empty; a folder spelled in another case lands in
// the folder on disk; a name is taken only in the chosen folder; a folder that climbs out or starts at the disk is refused before
// anything is written; the imports that travel are re-aimed from the new file's own folder; and the page that receives the
// instance imports it by a path that is right from its own depth, relative or through the project's alias.
// Method: the built main modules (componentFile, discardComponentFile, componentImportPaths) on a temporary project per test;
// each creation is written the way the component:create handler writes it (folders first, then the file), and Undo runs
// discardComponentFile with the folders the creation reported, exactly as the renderer hands them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentFile, discardComponentFile } from '#dist/electron/documents/componentFile.js';
import { componentImportPaths } from '#dist/electron/properties/componentImports.js';
import { digestOf } from '#dist/electron/documents/atomicWrite.js';
import type { Digest } from '#dist/shared/core/brand.js';

const card = { id: 'a', kind: 'element', name: 'div', props: {}, children: [] };
const button = { id: 'b', kind: 'component', name: 'Button', props: {}, children: undefined };

function scratchProject(): { readonly root: string; readonly pagePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-folder-'));
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'pages', 'blog'), { recursive: true });
  return { root, pagePath: path.join(root, 'src', 'pages', 'index.astro') };
}

// What the component:create handler does with componentFile's answer.
function create(input: Parameters<typeof componentFile>[0]): ReturnType<typeof componentFile> & { readonly checksum: Digest } {
  const made = componentFile(input);
  fs.mkdirSync(path.dirname(made.path), { recursive: true });
  fs.writeFileSync(made.path, made.text, 'utf8');
  return { ...made, checksum: digestOf(fs.readFileSync(made.path)) };
}

test('with no folder chosen the component goes in the components root, as before', () => {
  const project = scratchProject();
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card] });
  assert.equal(made.rel, 'src/components/Div.astro');
  assert.deepEqual(made.folders, [], 'no folder is made for the root');
  const empty = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Other', nodes: [card], folder: '' });
  assert.equal(empty.rel, 'src/components/Other.astro', "'' is the root too");
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('a chosen existing nested folder holds the component and makes no folder', () => {
  const project = scratchProject();
  fs.mkdirSync(path.join(project.root, 'src', 'components', 'Global', 'Layout'), { recursive: true });
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Global/Layout' });
  assert.equal(made.rel, 'src/components/Global/Layout/Div.astro');
  assert.deepEqual(made.folders, []);
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('a new nested folder is created on disk and Undo removes the file and every folder it made', () => {
  const project = scratchProject();
  fs.mkdirSync(path.join(project.root, 'src', 'components', 'Global'), { recursive: true });
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Global/Layout/Hero' });
  const layout = path.join(project.root, 'src', 'components', 'Global', 'Layout');
  assert.equal(made.rel, 'src/components/Global/Layout/Hero/Div.astro');
  assert.deepEqual(made.folders, [layout, path.join(layout, 'Hero')], 'only the levels that were missing, outermost first');
  assert.equal(fs.existsSync(made.path), true, 'the file is on disk');
  const outcome = discardComponentFile({ projectPath: project.root, path: made.path, checksum: made.checksum, force: false, folders: made.folders });
  assert.equal(outcome, 'deleted');
  assert.equal(fs.existsSync(made.path), false, 'Undo removes the file');
  assert.equal(fs.existsSync(layout), false, 'and the folders it made');
  assert.equal(fs.existsSync(path.join(project.root, 'src', 'components', 'Global')), true, 'but never a folder that was there before');
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('Undo keeps a made folder that holds something else since', () => {
  const project = scratchProject();
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Form/Fields' });
  const form = path.join(project.root, 'src', 'components', 'Form');
  fs.writeFileSync(path.join(form, 'Input.astro'), '<input />\n', 'utf8');
  const outcome = discardComponentFile({ projectPath: project.root, path: made.path, checksum: made.checksum, force: false, folders: made.folders });
  assert.equal(outcome, 'deleted');
  assert.equal(fs.existsSync(path.join(form, 'Fields')), false, 'the emptied inner folder goes');
  assert.equal(fs.existsSync(path.join(form, 'Input.astro')), true, 'the outer folder keeps what was put in it');
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('Undo of an edited component keeps the file and its folders', () => {
  const project = scratchProject();
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Form' });
  fs.appendFileSync(made.path, '<p>edited</p>\n', 'utf8');
  const outcome = discardComponentFile({ projectPath: project.root, path: made.path, checksum: made.checksum, force: false, folders: made.folders });
  assert.equal(outcome, 'edited');
  assert.equal(fs.existsSync(made.path), true);
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('Undo refuses folders outside the component folder or not holding the component', () => {
  const project = scratchProject();
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Form' });
  const pages = path.join(project.root, 'src', 'pages');
  assert.throws(
    () => discardComponentFile({ projectPath: project.root, path: made.path, checksum: made.checksum, force: false, folders: [pages] }),
    /Only a folder made for a component/,
  );
  const root = path.join(project.root, 'src', 'components');
  assert.throws(
    () => discardComponentFile({ projectPath: project.root, path: made.path, checksum: made.checksum, force: false, folders: [root] }),
    /Only a folder made for a component/,
    'never the components root itself',
  );
  const sibling = path.join(root, 'Other');
  fs.mkdirSync(sibling);
  assert.throws(
    () => discardComponentFile({ projectPath: project.root, path: made.path, checksum: made.checksum, force: false, folders: [sibling] }),
    /Only the folders holding the component/,
  );
  assert.equal(fs.existsSync(made.path), true, 'a refused Undo deletes nothing');
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('a folder typed in another case lands in the folder on disk', () => {
  const project = scratchProject();
  fs.mkdirSync(path.join(project.root, 'src', 'components', 'forms'), { recursive: true });
  const made = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Forms/Fields' });
  assert.equal(made.rel, 'src/components/forms/Fields/Div.astro', 'the existing level keeps its spelling, the new one is made');
  assert.deepEqual(made.folders, [path.join(project.root, 'src', 'components', 'forms', 'Fields')]);
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('a name is taken only in the chosen folder, compared without case', () => {
  const project = scratchProject();
  create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder: 'Form' });
  assert.throws(
    () => componentFile({ projectPath: project.root, pagePath: project.pagePath, name: 'DIV', nodes: [card], folder: 'Form' }),
    /already a component called Div \(src\/components\/Form\/Div\.astro\)/,
  );
  const elsewhere = create({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card] });
  assert.equal(elsewhere.rel, 'src/components/Div.astro', 'the same name in another folder is allowed');
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('a folder that climbs out, starts at the disk or has an empty level is refused before anything is written', () => {
  const project = scratchProject();
  for (const folder of ['../pages', '/etc', 'Form//Fields', 'Form/..', 'Fo|rm']) {
    assert.throws(
      () => componentFile({ projectPath: project.root, pagePath: project.pagePath, name: 'Div', nodes: [card], folder }),
      /is not a folder under src\/components/,
      folder,
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(project.root, 'src', 'components')), [], 'nothing was written');
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('the imports that travel are re-aimed from the nested folder', () => {
  const project = scratchProject();
  const made = componentFile({
    projectPath: project.root,
    pagePath: project.pagePath,
    name: 'Div',
    nodes: [button],
    imports: [{ name: 'Button', path: '../components/Button.astro' }],
    folder: 'Global/Layout',
  });
  assert.match(made.text, /import Button from '\.\.\/\.\.\/Button\.astro'/);
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('the page that receives the instance imports it by a path right from its own depth', () => {
  const project = scratchProject();
  const target = path.join(project.root, 'src', 'components', 'Global', 'Layout', 'Div.astro');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '<div />\n', 'utf8');
  const top = componentImportPaths({ pagePath: project.pagePath, targetPath: target, projectPath: project.root });
  assert.equal(top.relative, '../components/Global/Layout/Div.astro');
  assert.equal(top.srcRelative, 'components/Global/Layout/Div.astro');
  const nested = componentImportPaths({
    pagePath: path.join(project.root, 'src', 'pages', 'blog', 'post.astro'),
    targetPath: target,
    projectPath: project.root,
  });
  assert.equal(nested.relative, '../../components/Global/Layout/Div.astro');
  const layout = componentImportPaths({ pagePath: path.join(project.root, 'src', 'layouts', 'Base.astro'), targetPath: target, projectPath: project.root });
  assert.equal(layout.relative, '../components/Global/Layout/Div.astro');
  const sibling = componentImportPaths({
    pagePath: path.join(project.root, 'src', 'components', 'Global', 'Card.astro'),
    targetPath: target,
    projectPath: project.root,
  });
  assert.equal(sibling.relative, './Layout/Div.astro');
  fs.rmSync(project.root, { recursive: true, force: true });
});

test('a project that imports through an alias gets the alias, the same from every depth', () => {
  const project = scratchProject();
  fs.writeFileSync(path.join(project.root, 'tsconfig.json'), '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }', 'utf8');
  const target = path.join(project.root, 'src', 'components', 'Global', 'Layout', 'Div.astro');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '<div />\n', 'utf8');
  const top = componentImportPaths({ pagePath: project.pagePath, targetPath: target, projectPath: project.root });
  const nested = componentImportPaths({
    pagePath: path.join(project.root, 'src', 'pages', 'blog', 'post.astro'),
    targetPath: target,
    projectPath: project.root,
  });
  assert.equal(top.relative, '@/components/Global/Layout/Div.astro');
  assert.equal(nested.relative, '@/components/Global/Layout/Div.astro');
  fs.rmSync(project.root, { recursive: true, force: true });
});
