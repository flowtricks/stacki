// Goal: insert useful component instances without changing component definitions.
// Methodology: use the real App, parser, and disk-edit pipeline for all eight
// presets, verify their imports and nested values, and undo each insertion back
// to the original page bytes. Pure cases cover partial libraries and aliases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { gesture, mountApp, tick, undo } = require('../../helpers/appGestures.js');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { safeSchema } = require('#dist/electron/properties/propDefaults.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const HEADING = 'Lorem ipsum dolor sit amet elit';
const PARAGRAPH =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ' +
  'ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in ' +
  'reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';
const NAMES = ['Heading', 'Paragraph', 'Button', 'ButtonWrapper', 'ContentWrapper', 'Grid', 'Slider', 'Card'];
const PAGE = '<main><!-- Preserve this existing content. --></main>\n';

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-instance-defaults-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, PAGE);
  const components = NAMES.map((name) => {
    const componentPath = path.join(root, 'src/components', `${name}.astro`);
    const source =
      name === 'Card'
        ? '---\ninterface Props { heading?: string; text?: string; }\n---\n<article />\n'
        : '---\ninterface Props { small?: number; medium?: number; }\n---\n<div><slot /></div>\n';
    fs.writeFileSync(componentPath, source);
    return { name, path: componentPath, folder: '', ...safeSchema(componentPath, root) };
  });
  return {
    root,
    file,
    components,
    scan: {
      pages: [{ name: 'index.astro', path: file, route: '/' }],
      pageFolders: [],
      layouts: [],
      components,
    },
  };
}

function componentsIn(node) {
  return (node.children ?? []).filter((child) => child.kind === 'component');
}

function checkCard(node) {
  assert.equal(node.name, 'Card');
  assert.deepEqual(node.props.heading, { type: 'string', value: HEADING });
  assert.deepEqual(node.props.text, { type: 'string', value: PARAGRAPH });
  assert.equal(node.children, undefined, 'Card copy belongs in its existing props');
}

function checkInstance(node, name, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax);
  assert.equal(node.name, name);
  const content = { Heading: HEADING, Paragraph: PARAGRAPH, Button: 'Button Text' }[name];
  if (content) {
    assert.equal(node.children.map((child) => child.value).join(''), content);
  } else if (name === 'Card') {
    checkCard(node);
  } else if (name === 'Grid' || name === 'Slider') {
    assert.deepEqual(node.props.small, { type: 'expr', value: name === 'Grid' ? '2' : '1.4' });
    if (name === 'Grid') {
      assert.deepEqual(node.props.medium, { type: 'expr', value: '3' });
    } else {
      assert.equal(node.props.medium, undefined);
    }
    const children = componentsIn(node);
    assert.equal(children.length, name === 'Grid' ? 3 : 2);
    children.forEach(checkCard);
  } else if (name === 'ButtonWrapper') {
    assert.equal(componentsIn(node).length, 1);
    checkInstance(componentsIn(node)[0], 'Button', depth + 1);
  } else {
    const children = componentsIn(node);
    assert.deepEqual(
      children.map((child) => child.name),
      ['Heading', 'Paragraph', 'ButtonWrapper'],
    );
    children.forEach((child) => checkInstance(child, child.name, depth + 1));
  }
}

test('instance defaults and imports save and undo together', async (context) => {
  const setup = fixture(context);
  const originals = setup.components.map((component) => fs.readFileSync(component.path, 'utf8'));
  const app = await mountApp(setup.root, { scan: setup.scan }, 'component-instances');
  context.after(app.unmount);
  const palette = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Components'));
  assert.ok(palette);
  await app.act(async () => {
    palette.click();
    await tick();
  });
  for (const name of NAMES) {
    await gesture(app, async () => {
      __panels.PalettePanel.onInsert(name);
      await tick();
    });
    const source = fs.readFileSync(setup.file, 'utf8');
    const parsed = parsePage(source, { locs: true });
    const instance = parsed.model.nodes.find((node) => node.kind === 'component');
    assert.ok(instance, `${name} was inserted`);
    checkInstance(instance, name);
    assert.ok(source.includes('<main><!-- Preserve this existing content. --></main>'));
    const expected =
      name === 'ContentWrapper'
        ? ['ContentWrapper', 'Heading', 'Paragraph', 'ButtonWrapper', 'Button']
        : name === 'ButtonWrapper'
          ? ['ButtonWrapper', 'Button']
          : name === 'Grid' || name === 'Slider'
            ? [name, 'Card']
            : [name];
    assert.deepEqual(parsed.model.imports.map((item) => item.name).sort(), expected.sort());
    await undo(app);
    assert.equal(fs.readFileSync(setup.file, 'utf8'), PAGE, `${name} is one undo step`);
  }
  assert.deepEqual(
    setup.components.map((component) => fs.readFileSync(component.path, 'utf8')),
    originals,
    'No component source, field, or default was edited',
  );
});

test('partial libraries and occupied import names stay valid', async (context) => {
  const setup = fixture(context);
  const bundle = repoPath('node_modules/.stacki-test/component-instance-core.cjs');
  await esbuild.build({
    entryPoints: [repoPath('src/app/model/componentInstances.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { componentInstance, componentInstancePlacement } = require(bundle);
  const find = (name) => setup.components.find((component) => component.name === name);
  const grid = componentInstance(find('Grid'), setup.components);
  const other = componentInstance(find('Grid'), setup.components);
  assert.notEqual(grid.node.id, other.node.id);
  assert.equal(new Set(grid.node.children.map((child) => child.id)).size, 3);
  const partial = componentInstance(find('ContentWrapper'), [find('Heading')]);
  assert.deepEqual(
    partial.node.children.map((child) => child.name),
    ['Heading'],
  );
  const custom = {
    name: 'Custom',
    path: '/Custom.astro',
    folder: '',
    slots: ['default'],
    slotText: true,
  };
  assert.equal(componentInstance(custom, []).node.children[0].value, 'Text');
  assert.deepEqual(componentInstance({ ...custom, name: 'Card' }, []).node.props, {});
  assert.equal(componentInstance({ ...find('Heading'), slots: [] }, []).node.children, undefined);
  const model = parsePage(['---', "import Tile from '../components/Card.astro';", 'const Grid = 1;', '---', PAGE].join('\n'), { locs: true }).model;
  const resolved = grid.components.map((component) => ({
    component,
    paths: {
      relative: `../components/${component.name}.astro`,
      srcRelative: undefined,
    },
  }));
  const placed = componentInstancePlacement(model, grid, resolved);
  assert.equal(placed.node.name, 'Grid2');
  assert.ok(placed.node.children.every((child) => child.name === 'Tile'));
  assert.deepEqual(
    placed.imports.map((item) => item.name),
    ['Tile', 'Grid2'],
  );
  assert.throws(() => componentInstancePlacement(model, grid, []), /dependency is resolved/);
  assert.throws(
    () =>
      componentInstance(find('Heading'), [], {
        projectPath: setup.root,
        config: {
          version: 1,
          components: {
            'src/components/Heading.astro': {
              children: [{ component: 'src/components/Heading.astro' }],
            },
          },
        },
      }),
    /cycle/,
  );
});

test('project recipes preserve literal text and one-step undo', async (context) => {
  const setup = fixture(context);
  fs.mkdirSync(path.join(setup.root, '.stacki'));
  fs.writeFileSync(
    path.join(setup.root, '.stacki/components.json'),
    JSON.stringify({
      version: 1,
      components: {
        'src/components/ContentWrapper.astro': {
          children: [{ component: 'src/components/Heading.astro' }],
        },
        'src/components/Heading.astro': {
          props: { small: 4, hidden: false },
          text: 'Project <text> & {code}',
        },
      },
    }),
  );
  const app = await mountApp(setup.root, { scan: setup.scan }, 'project-component-defaults');
  context.after(app.unmount);
  const palette = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Components'));
  assert.ok(palette);
  await app.act(async () => {
    palette.click();
    await tick();
  });
  await gesture(app, async () => {
    __panels.PalettePanel.onInsert(path.join(setup.root, 'src/components/ContentWrapper.astro'));
    await tick();
  });
  const source = fs.readFileSync(setup.file, 'utf8');
  const parsed = parsePage(source, { locs: true });
  const wrapper = parsed.model.nodes.find((node) => node.kind === 'component');
  assert.equal(wrapper.name, 'ContentWrapper');
  assert.equal(wrapper.children[0].name, 'Heading');
  assert.equal(wrapper.children[0].children[0].value, 'Project <text> & {code}');
  assert.equal(wrapper.children[0].props.small.value, '4');
  assert.equal(wrapper.children[0].props.hidden.value, 'false');
  assert.equal(parsed.model.imports.length, 2);
  await undo(app);
  assert.equal(fs.readFileSync(setup.file, 'utf8'), PAGE);
});
