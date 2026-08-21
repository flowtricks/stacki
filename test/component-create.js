// Making a component out of what's selected.
//
//   node test/component-create.js
//
// The Components panel can turn the selected element into a component: it asks
// for a name, writes src/components/<Name>.astro, and leaves `<Name />` on the
// page where the element was. Two halves, both easy to get quietly wrong.
//
// The NAME is three things at once — a filename, an import identifier, and a
// tag. A lowercase tag is an HTML element to Astro, so `<card />` renders a
// literal <card> and the component never appears; a name that collides with an
// existing component makes an import that means two files. So what is typed is
// not what is saved: "Component name" is written down as ComponentName.
//
// The FILE has to hold everything that piece needed. The markup moves rather
// than being copied, so an extracted card that holds a <Button> renders an
// error unless Button's import travels with it — re-aimed, because a relative
// path was written from the page's folder and the new file is somewhere else.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  // ── The name ──────────────────────────────────────────────────────────────
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const namesBundle = path.join(buildDir, 'component-name.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'componentName.js')],
    outfile: namesBundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { toComponentName, componentNameError } = require(namesBundle);

  const named = (input, want) =>
    check(`"${input}" is saved as ${want}`, toComponentName(input) === want, toComponentName(input));
  named('Component name', 'ComponentName');
  named('project card', 'ProjectCard');
  named('Card', 'Card');
  // Casing already inside a word is the author's, not something to flatten.
  named('buttonArrow', 'ButtonArrow');
  named('ButtonArrow', 'ButtonArrow');
  named('my-cool_card', 'MyCoolCard');
  named('  spaced   out  ', 'SpacedOut');
  named('card 2', 'Card2');
  named('héro card', 'HeroCard'); // accents come off rather than splitting the word
  named('', '');

  const taken = ['Button', 'ProjectCard', 'BaseLayout'];
  const err = (input, expect, why) => {
    const got = componentNameError(input, taken);
    check(why, expect ? !!got && expect.test(got) : got === null, JSON.stringify(got));
  };
  err('Card', null, 'a fresh name is fine');
  err('card', null, 'and so is one that only needs capitalising');
  err('', /name/i, 'an empty name is refused');
  err('   ', /name/i, 'and so is a blank one');
  err('!!!', /letters/i, 'so is one with nothing usable in it');
  err('2col', /number/i, "a name can't start with a number");
  err('Button', /already/i, 'a name already in use is refused');
  // The conversion happens first, so the collision is with what would be SAVED.
  err('project card', /already/i, 'including one that only collides once converted');
  err('BUTTON', /already/i, 'and one that differs only in case — same file on a Mac');
  err('Fragment', /Astro/i, "Astro's own tag is refused");
  check(
    'and the refusal names the component already there',
    /ProjectCard/.test(componentNameError('project card', taken) || ''),
    componentNameError('project card', taken)
  );

  // ── What it reads from the page ───────────────────────────────────────────
  // Markup pulled out of a page leaves its scope behind: `{title}` in a page
  // reads the page's title, and in Card.astro it reads nothing at all. The
  // values it was reading are exactly the props the component wants.
  const propsBundle = path.join(buildDir, 'extract-props.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'extractProps.js')],
    outfile: propsBundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { propsForExtraction, propsDestructure } = require(propsBundle);

  const el = (name, props, children) => ({ id: name, kind: 'element', name, props: props || {}, children: children || [] });
  const scope = ['title', 'items', 'show', 'count', 'post', 'link'];
  const reads = (node, want, why) => {
    const got = propsForExtraction(node, scope);
    check(why, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  };

  reads(el('h2', {}, [{ id: 'e', kind: 'expr', value: 'title' }]), ['title'], 'an expression names a prop');
  reads(el('a', { href: { type: 'expr', value: 'link' } }), ['link'], 'and so does an expression prop');
  reads(
    el('p', {}, [{ id: 't', kind: 'text', value: 'You have {count} of them' }]),
    ['count'],
    'and a hole in a text run'
  );
  reads(
    el('div', {}, [{ id: 'c', kind: 'cond', test: 'show', children: [] }]),
    ['show'],
    'and a condition'
  );
  reads(
    el('ul', {}, [{ id: 'm', kind: 'map', head: 'items.map((item) => (', children: [el('li', {}, [{ id: 'x', kind: 'expr', value: 'item.name' }])] }]),
    ['items'],
    "a loop's data is a prop"
  );
  check(
    "but the item it binds is not — it travels with the markup",
    !propsForExtraction(
      el('ul', {}, [{ id: 'm', kind: 'map', head: 'items.map((item) => (', children: [el('li', {}, [{ id: 'x', kind: 'expr', value: 'item' }])] }]),
      [...scope, 'item']
    ).includes('item'),
    JSON.stringify(propsForExtraction(el('ul', {}, [{ id: 'm', kind: 'map', head: 'items.map((item) => (', children: [el('li', {}, [{ id: 'x', kind: 'expr', value: 'item' }])] }]), [...scope, 'item']))
  );
  // The other way round: extracting from INSIDE a loop, the item is a value the
  // page has at that spot, and the instance can pass it straight back in.
  reads(el('li', {}, [{ id: 'x', kind: 'expr', value: 'item.name' }]), [], 'a name not in scope is not a prop');
  check(
    'an ancestor loop item is, since the instance sits inside that loop',
    JSON.stringify(propsForExtraction(el('li', {}, [{ id: 'x', kind: 'expr', value: 'item.name' }]), [...scope, 'item'])) === '["item"]',
    JSON.stringify(propsForExtraction(el('li', {}, [{ id: 'x', kind: 'expr', value: 'item.name' }]), [...scope, 'item']))
  );

  reads(el('h2', {}, [{ id: 'e', kind: 'expr', value: 'post.data.title' }]), ['post'], 'a chain is one prop, its root');
  reads(el('h2', {}, [{ id: 'e', kind: 'expr', value: 'Math.max(1, 2)' }]), [], 'a global is not a prop');
  reads(el('h2', { class: { type: 'string', value: 'title' } }), [], 'nor is a word that only looks like one');
  reads(el('h2', {}, [{ id: 'e', kind: 'expr', value: '"title"' }]), [], 'nor one inside a string');
  reads(
    el('div', {}, [
      { id: 'a', kind: 'expr', value: 'count' },
      { id: 'b', kind: 'expr', value: 'title' },
      { id: 'c', kind: 'expr', value: 'count' },
    ]),
    ['count', 'title'],
    'each is named once, in the order the markup reads them'
  );
  reads(el('div', {}, []), [], 'markup that reads nothing needs no props');

  check(
    'the destructure is what Astro (and this app) reads back as the interface',
    propsDestructure(['title', 'items']) === 'const { title, items } = Astro.props;',
    propsDestructure(['title', 'items'])
  );
  check('and there is none without props', propsDestructure([]) === '', propsDestructure([]));

  // ── The file ──────────────────────────────────────────────────────────────
  const { componentFile } = require(path.join(__dirname, '..', 'electron', 'componentFile.js'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-comp-'));
  fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  const pagePath = path.join(project, 'src', 'pages', 'index.astro');
  const write = (result) => {
    fs.mkdirSync(path.dirname(result.path), { recursive: true });
    fs.writeFileSync(result.path, result.text, 'utf8');
    return result;
  };

  const card = {
    id: 'a',
    kind: 'element',
    name: 'article',
    props: { class: { type: 'string', value: 'project-card' } },
    children: [
      { id: 'b', kind: 'element', name: 'h2', props: {}, children: [{ id: 'c', kind: 'text', value: 'Title' }] },
      { id: 'd', kind: 'component', name: 'Button', props: { label: { type: 'string', value: 'Go' } }, children: null },
    ],
  };
  const imports = [
    { name: 'Button', path: '../components/Button.astro' },
    { name: 'Hero', path: '../components/Hero.astro' },
    { name: 'clsx', path: 'clsx' },
    { name: 'Icon', path: '@/components/Icon.astro' },
  ];

  const made = componentFile({ projectPath: project, pagePath, name: 'ProjectCard', nodes: [card], imports });
  check(
    'the file lands in src/components under its own name',
    made.rel === 'src/components/ProjectCard.astro',
    made.rel
  );
  check('the markup comes across', /<article class="project-card">/.test(made.text), made.text);
  check('all of it', /<h2>Title<\/h2>/.test(made.text) && /<Button label="Go"/.test(made.text), made.text);
  check(
    'the import it needs comes with it',
    /import Button from '\.\/Button\.astro'/.test(made.text),
    made.text
  );
  check(
    're-aimed from the new file rather than copied from the page',
    !/\.\.\/components\/Button/.test(made.text),
    made.text
  );
  check(
    "an import it doesn't use is left behind",
    !/Hero/.test(made.text),
    made.text
  );

  // Aliases and packages mean the same thing from anywhere — copied as written.
  const withAlias = componentFile({
    projectPath: project,
    pagePath,
    name: 'Aliased',
    nodes: [{ id: 'x', kind: 'component', name: 'Icon', props: {}, children: null }],
    imports,
  });
  check(
    'an alias import is copied exactly as written',
    /import Icon from '@\/components\/Icon\.astro'/.test(withAlias.text),
    withAlias.text
  );

  // A page in a subfolder: the relative path has further to travel.
  const deep = componentFile({
    projectPath: project,
    pagePath: path.join(project, 'src', 'pages', 'blog', 'post.astro'),
    name: 'FromDeep',
    nodes: [{ id: 'y', kind: 'component', name: 'Button', props: {}, children: null }],
    imports: [{ name: 'Button', path: '../../components/Button.astro' }],
  });
  check(
    'a path written from a nested page still points at the same file',
    /import Button from '\.\/Button\.astro'/.test(deep.text),
    deep.text
  );

  // The props it was told to take: a destructure off Astro.props, which is both
  // Astro's convention and what this app's own props panel reads back.
  const withProps = componentFile({
    projectPath: project,
    pagePath,
    name: 'Titled',
    nodes: [{ id: 'h', kind: 'element', name: 'h2', props: {}, children: [{ id: 'e', kind: 'expr', value: 'title' }] }],
    imports: [],
    props: ['title', 'items'],
  });
  check(
    'the component takes its props off Astro.props',
    /const \{ title, items \} = Astro\.props;/.test(withProps.text),
    withProps.text
  );
  check('above the markup that reads them', withProps.text.indexOf('Astro.props') < withProps.text.indexOf('<h2'), withProps.text);
  check(
    'and the props panel can read them back',
    (() => {
      const { parsePropSchema } = require(path.join(__dirname, '..', 'electron', 'astroParser.js'));
      const schema = parsePropSchema(withProps.text);
      return schema.some((f) => f.name === 'title') && schema.some((f) => f.name === 'items');
    })(),
    ''
  );
  // Anything that isn't a name can't be written into a destructure.
  const junkProps = componentFile({
    projectPath: project,
    pagePath,
    name: 'Junk',
    nodes: [{ id: 'd', kind: 'element', name: 'div', props: {}, children: [] }],
    props: ['ok', 'not a name', '', 'post.data'],
  });
  check(
    'only real names reach the destructure',
    /const \{ ok \} = Astro\.props;/.test(junkProps.text),
    junkProps.text
  );

  // Nothing to import → no empty frontmatter block on top of the file.
  const plain = componentFile({
    projectPath: project,
    pagePath,
    name: 'Plain',
    nodes: [{ id: 'z', kind: 'element', name: 'div', props: {}, children: [] }],
    imports,
  });
  check('a component that needs no imports gets no ---', !plain.text.startsWith('---'), plain.text);
  check('and is still the markup', /<div><\/div>|<div>\s*<\/div>/.test(plain.text), plain.text);

  // ── What it refuses ───────────────────────────────────────────────────────
  const refuses = (what, run, expect) => {
    let message = null;
    try { run() } catch (e) { message = String(e.message || e) }
    check(what, !!message && expect.test(message), message === null ? 'no error' : message);
  };
  refuses(
    'a lowercase name never reaches the disk — Astro would read it as an HTML tag',
    () => componentFile({ projectPath: project, pagePath, name: 'card', nodes: [card] }),
    /capital/i
  );
  refuses(
    'nor does a name with a space still in it',
    () => componentFile({ projectPath: project, pagePath, name: 'Project Card', nodes: [card] }),
    /capital/i
  );
  refuses(
    'and there has to be something to make it from',
    () => componentFile({ projectPath: project, pagePath, name: 'Empty', nodes: [] }),
    /nothing/i
  );

  write(made);
  refuses(
    'a second component of the same name is refused',
    () => componentFile({ projectPath: project, pagePath, name: 'ProjectCard', nodes: [card] }),
    /already/i
  );
  refuses(
    'and so is one that differs only in case — the same file on a Mac',
    () => componentFile({ projectPath: project, pagePath, name: 'Projectcard', nodes: [card] }),
    /already/i
  );
  check(
    'the refusal names the file that is already there',
    /ProjectCard/.test((() => { try { componentFile({ projectPath: project, pagePath, name: 'Projectcard', nodes: [card] }) } catch (e) { return e.message } })()),
    ''
  );

  // ── It round-trips ────────────────────────────────────────────────────────
  // The file it writes is a file the app can open again: parsed back, it is the
  // same element it was cut from.
  const { parsePage } = require(path.join(__dirname, '..', 'electron', 'astroParser.js'));
  const reparsed = parsePage(fs.readFileSync(made.path, 'utf8'));
  const root = reparsed.model.nodes.find((n) => n.kind === 'element');
  check('the written file parses back', !!root, JSON.stringify(reparsed.model.nodes));
  check('as the same element', root?.name === 'article', root?.name);
  check('with its classes', root?.props?.class?.value === 'project-card', JSON.stringify(root?.props));
  check('and its children', (root?.children || []).length === 2, JSON.stringify((root?.children || []).map((c) => c.name)));
  check(
    'and the import is one the file itself declares',
    reparsed.model.imports.some((i) => i.name === 'Button'),
    JSON.stringify(reparsed.model.imports)
  );

  fs.rmSync(project, { recursive: true, force: true });

  // ── Where a component is used ─────────────────────────────────────────────
  // The palette says "23 instances"; the list behind that number has to be the
  // same 23, found the same way, or the popup is missing something the count
  // promised and nothing says which of them is lying.
  {
    const { componentUsage, countIn } = require(path.join(__dirname, '..', 'electron', 'componentUsage.js'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-usage-'));
    const put = (rel, text) => {
      const abs = path.join(proj, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
      return abs;
    };
    const selfPath = put('src/components/Section.astro', '<section><slot /></section>\n');
    put('src/pages/index.astro', '<Section />\n<Section>\n  <p>hi</p>\n</Section>\n');
    put('src/pages/blog/post.astro', '<Section class="x" />\n');
    put('src/layouts/Base.astro', '<Section />\n<Section />\n<Section />\n');
    put('src/components/Hero.astro', '<div>no instances here</div>\n');
    // A component's own code talks about itself. Lumos's Card.astro warns
    // `'[lumos] <Card variant="…">'` three times in its frontmatter, and
    // counting the file's text as a whole read those as three more cards.
    put(
      'src/components/Talker.astro',
      '---\nconsole.warn("[lib] <Section variant=\'a\'> needs a parent");\n---\n<Section />\n'
    );
    // Markdown pages render components too, and the palette counts them.
    put('src/pages/notes.md', '---\ntitle: Notes\n---\n\n<Section />\n');
    // A tag is a local binding, not a filename. Every page in a Lumos project
    // says `import Layout from "@/layouts/BaseLayout.astro"` and writes
    // `<Layout>`, so counting `<BaseLayout` found none of them and the palette
    // reported 0 instances of a layout used on every page.
    put('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
    put('src/layouts/BaseLayout.astro', '<html><slot /></html>\n');
    put('src/pages/aliased.astro', '---\nimport Layout from "@/layouts/BaseLayout.astro";\n---\n<Layout><p>hi</p></Layout>\n');
    put('src/pages/relative.astro', '---\nimport Shell from "../layouts/BaseLayout.astro";\n---\n<Shell />\n<Shell />\n');
    // And a file that means a DIFFERENT component by the same name.
    put('src/pages/decoy-import.astro', '---\nimport Section from "../components/other/Section.astro";\n---\n<Section />\n');
    put('src/components/other/Section.astro', '<div />\n');
    // Names that merely start the same are not this component.
    put('src/pages/decoys.astro', '<SectionList />\n<MySection />\n</Section>\n');

    const found = componentUsage({ projectPath: proj, name: 'Section', exclude: selfPath });
    const byRel = Object.fromEntries(found.files.map((f) => [f.rel, f]));
    check('every file holding one is listed', found.files.length === 5, JSON.stringify(found.files.map((f) => f.rel)));
    check(
      'a name written in the frontmatter is code talking, not an instance',
      byRel['src/components/Talker.astro']?.count === 1,
      JSON.stringify(byRel['src/components/Talker.astro'])
    );
    check(
      'a markdown page counts — it renders components too',
      byRel['src/pages/notes.md']?.count === 1,
      JSON.stringify(byRel['src/pages/notes.md'])
    );
    check('with how many each holds', byRel['src/pages/index.astro']?.count === 2, JSON.stringify(byRel['src/pages/index.astro']));
    check('the total is the number the palette shows', found.total === 8, String(found.total));
    check(
      'a page is known to be a page, a layout a layout',
      byRel['src/pages/blog/post.astro']?.kind === 'page' && byRel['src/layouts/Base.astro']?.kind === 'layout',
      JSON.stringify(found.files)
    );
    check('the busiest file leads', found.files[0].rel === 'src/layouts/Base.astro', found.files[0].rel);
    check("a file with none of them isn't listed", !byRel['src/components/Hero.astro'], 'Hero listed');
    check('and neither is the component itself', !byRel['src/components/Section.astro'], 'listed itself');
    check(
      'a longer name that starts the same is a different component',
      !byRel['src/pages/decoys.astro'],
      JSON.stringify(byRel['src/pages/decoys.astro'])
    );
    check('a closing tag is not an instance', countIn('</Section>', 'Section') === 0, String(countIn('</Section>', 'Section')));
    check(
      'and neither is a mention up in the frontmatter',
      countIn('---\nconst a = "<Section />";\n---\n<Section />\n', 'Section') === 1,
      String(countIn('---\nconst a = "<Section />";\n---\n<Section />\n', 'Section'))
    );
    // The number in the palette and this list come from the same function, so
    // they cannot drift apart — which is the whole point of sharing it.
    check(
      'the palette counts with this same function',
      /instancesIn\(text, \{ file, targetPath: comp\.path/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')),
      'project:scan counts instances its own way again'
    );
    check('an unused component says so plainly', componentUsage({ projectPath: proj, name: 'Hero' }).files.length === 0, '');

    // The layout every page uses under another name.
    const layout = componentUsage({
      projectPath: proj,
      name: 'BaseLayout',
      exclude: path.join(proj, 'src/layouts/BaseLayout.astro'),
    });
    const layoutBy = Object.fromEntries(layout.files.map((f) => [f.rel, f.count]));
    check(
      'a component imported under another name still counts',
      layoutBy['src/pages/aliased.astro'] === 1,
      JSON.stringify(layout.files)
    );
    check(
      'however the import is written — alias or relative path',
      layoutBy['src/pages/relative.astro'] === 2,
      JSON.stringify(layout.files)
    );
    check('and the total is what the palette will show', layout.total === 3, String(layout.total));
    check(
      'a file that means a different component by that name is not counted',
      !byRel['src/pages/decoy-import.astro'],
      JSON.stringify(byRel['src/pages/decoy-import.astro'])
    );

    fs.rmSync(proj, { recursive: true, force: true });
  }

  // ── The panel ─────────────────────────────────────────────────────────────
  // The button is only live when there's something to act on, and the field
  // shows what the name will actually be before it's committed to.
  {
    const panelBundle = path.join(buildDir, 'palette-panel.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'PalettePanel.jsx')],
      outfile: panelBundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      logLevel: 'silent',
    });

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.Element = dom.window.Element;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.IS_REACT_ACT_ENVIRONMENT = true;

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = require('react');
    const PalettePanel = require(panelBundle).default;

    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    const created = [];
    const opened = [];
    let instancesHere = [];
    let usageAnswer = { files: [] };
    let request = 0;
    const render = (createFrom) =>
      act(async () => {
        root.render(
          React.createElement(PalettePanel, {
            createRequest: request,
            components: [
              { path: '/p/src/components/Button.astro', name: 'Button', folder: '', instances: 2 },
              { path: '/p/src/components/ProjectCard.astro', name: 'ProjectCard', folder: '', instances: 0 },
            ],
            devUrl: null,
            onInsert: () => {},
            onDragBegin: () => {},
            createFrom,
            onCreateComponent: (name, options) => created.push({ name, ...options }),
            onUsage: async () => usageAnswer,
            pageInstances: () => instancesHere,
            onOpenUsage: (entry) => opened.push(entry.rel),
            onSelectInstance: (id) => opened.push(`node:${id}`),
          })
        );
        await new Promise((r) => setTimeout(r, 10));
      });

    const makeButton = () =>
      [...container.querySelectorAll('.panel-header button')].pop();

    await render({ reason: 'Select an element on the canvas first.' });
    check('with nothing selected the button is dead', makeButton()?.disabled === true, String(makeButton()?.disabled));
    // Its own tooltip, after the pointer rests on it — on the wrapper, since a
    // disabled button fires no pointer events and that's exactly when someone
    // needs telling why.
    const hover = async () => {
      const anchor = container.querySelector('.tip-anchor');
      await act(async () => {
        anchor.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        await new Promise((r) => setTimeout(r, 560));
      });
    };
    const tip = () => dom.window.document.querySelector('.rail-tooltip.below');
    check('nothing appears the instant it is hovered', !tip(), tip()?.textContent);
    await hover();
    check(
      'resting on it says what to do instead',
      /select an element/i.test(tip()?.textContent || ''),
      tip()?.textContent
    );

    await render({ name: 'ProjectCard', label: '<article>', props: [] });
    check('with an element selected it is live', makeButton()?.disabled === false, String(makeButton()?.disabled));
    await hover();
    check(
      'and the tooltip names the shortcut that does the same thing',
      /new component/i.test(tip()?.textContent || '') && /⌘⇧A/.test(tip()?.textContent || ''),
      tip()?.textContent
    );
    await act(async () => { makeButton().click(); await new Promise((r) => setTimeout(r, 10)) });

    const field = () => dom.window.document.querySelector('.modal input');
    const createBtn = () =>
      [...dom.window.document.querySelectorAll('.modal-footer button')].find((b) => /Create/.test(b.textContent));
    check('the name is asked for', !!field(), 'no dialog');
    check(
      'prefilled with the name the element already goes by',
      field()?.value === 'ProjectCard',
      field()?.value
    );
    // …which is a name already taken, so it cannot be committed as it stands.
    check('a name already in use blocks Create', createBtn()?.disabled === true, String(createBtn()?.disabled));
    check(
      'and says so',
      /already/i.test(dom.window.document.querySelector('.modal .error-text')?.textContent || ''),
      dom.window.document.querySelector('.modal .error-text')?.textContent
    );

    const type = async (value) => {
      const el = field();
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 5));
      });
    };

    await type('Component name');
    check('a typed name is left as typed while typing', field()?.value === 'Component name', field()?.value);
    check(
      'but the dialog shows what it will be saved as',
      /ComponentName\.astro/.test(dom.window.document.querySelector('.modal .hint-text')?.textContent || ''),
      dom.window.document.querySelector('.modal .hint-text')?.textContent
    );
    check('and it can be created', createBtn()?.disabled === false, String(createBtn()?.disabled));

    await act(async () => { createBtn().click(); await new Promise((r) => setTimeout(r, 10)) });
    check('creating passes the converted name', created[0]?.name === 'ComponentName', JSON.stringify(created));
    check('and the dialog closes', !dom.window.document.querySelector('.modal'), 'still open');

    // ── The offer ───────────────────────────────────────────────────────────
    // A piece that reads the page can take those values as props, and does
    // unless you say otherwise.
    created.length = 0;
    await render({ name: 'Card', label: '<article>', props: ['title', 'items'] });
    await act(async () => { makeButton().click(); await new Promise((r) => setTimeout(r, 10)) });
    const offer = () => dom.window.document.querySelector('.modal .check-row');
    check('the values it reads are offered as props', !!offer(), 'no offer');
    check(
      'named, so you can see what it will take',
      /title/.test(offer()?.textContent || '') && /items/.test(offer()?.textContent || ''),
      offer()?.textContent
    );
    check('taken by default', offer()?.querySelector('input')?.checked === true, 'unchecked');
    await act(async () => { createBtn().click(); await new Promise((r) => setTimeout(r, 10)) });
    check('so creating takes them', created[0]?.withProps === true, JSON.stringify(created));

    // Turned off, the markup moves as it is — the old behaviour, on purpose.
    created.length = 0;
    await act(async () => { makeButton().click(); await new Promise((r) => setTimeout(r, 10)) });
    await act(async () => {
      offer().querySelector('input').click();
      await new Promise((r) => setTimeout(r, 5));
    });
    check('and it can be turned off', offer()?.querySelector('input')?.checked === false, 'still checked');
    await act(async () => { createBtn().click(); await new Promise((r) => setTimeout(r, 10)) });
    check('which is passed through', created[0]?.withProps === false, JSON.stringify(created));

    // ── The shortcut ────────────────────────────────────────────────────────
    // ⌘⇧A brings this panel up and asks for the name in one press. It arrives
    // as a bumped number rather than a flag, so pressing it again after
    // cancelling asks again.
    await render({ name: 'Card', label: '<article>', props: [] });
    check('nothing is open to start with', !dom.window.document.querySelector('.modal'), 'a dialog was open');
    request += 1;
    await render({ name: 'Card', label: '<article>', props: [] });
    check('the shortcut asks for the name', !!dom.window.document.querySelector('.modal'), 'no dialog');
    await act(async () => {
      [...dom.window.document.querySelectorAll('.modal-footer button')]
        .find((b) => /Cancel/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 5));
    });
    check('cancelling closes it', !dom.window.document.querySelector('.modal'), 'still open');
    request += 1;
    await render({ name: 'Card', label: '<article>', props: [] });
    check('and pressing it again asks again', !!dom.window.document.querySelector('.modal'), 'no dialog');
    await act(async () => {
      [...dom.window.document.querySelectorAll('.modal-footer button')]
        .find((b) => /Cancel/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 5));
    });
    request += 1;
    await render({ reason: 'Select an element on the canvas first.' });
    check(
      'with nothing selected it asks nothing',
      !dom.window.document.querySelector('.modal'),
      'asked for a name with nothing to name'
    );

    // The press itself is bound in the app, which this can only read.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
    const binding = appSource.slice(appSource.indexOf("e.key.toLowerCase() === 'a'") - 200, appSource.indexOf("e.key.toLowerCase() === 'a'") + 400);
    check('⌘⇧A is bound', /mod && e\.shiftKey[\s\S]*'a'/.test(binding), binding.slice(0, 120));
    check('to the Components panel', /setLeftTab\('components'\)/.test(binding), binding);
    check('and to the request this panel answers', /setCreateRequest/.test(binding), binding);

    // ── The instance count ──────────────────────────────────────────────────
    // "23 instances" is half a question — 23 WHERE — so it opens the other half.
    instancesHere = [{ id: 'n1' }, { id: 'n2' }];
    usageAnswer = {
      files: [
        { rel: 'src/pages/about.astro', path: '/p/src/pages/about.astro', kind: 'page', count: 4 },
        { rel: 'src/components/Hero.astro', path: '/p/src/components/Hero.astro', kind: 'component', count: 1 },
      ],
    };
    await render({ reason: 'Select an element on the canvas first.' });
    const countButton = () =>
      [...container.querySelectorAll('.palette-instances')].find((b) => /2 instances/.test(b.textContent));
    check('the count is a control, not just text', !!countButton(), 'no button');
    check(
      'and a component nothing uses has nothing to open',
      [...container.querySelectorAll('.palette-instances')].find((b) => /0 instances/.test(b.textContent))?.disabled === true,
      'enabled with no instances'
    );

    await act(async () => {
      countButton().click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const popup = () => dom.window.document.querySelector('.instances-popup');
    check('clicking it opens the list', !!popup(), 'no popup');
    const rowText = () => [...popup().querySelectorAll('.instances-row')].map((r) => r.textContent.trim());
    check(
      'the instances on the open file come first, one row each',
      rowText().slice(0, 2).every((t) => /Button/.test(t)),
      rowText().join(' | ')
    );
    check(
      'then the other files, named and counted',
      rowText().some((t) => /about/.test(t) && /4/.test(t)) && rowText().some((t) => /Hero/.test(t)),
      rowText().join(' | ')
    );
    check(
      'a page reads as its route, not its path',
      rowText().some((t) => t.startsWith('about')),
      rowText().join(' | ')
    );

    // Each row is a way in.
    await act(async () => {
      [...popup().querySelectorAll('.instances-row')].find((r) => /about/.test(r.textContent)).click();
      await new Promise((r) => setTimeout(r, 10));
    });
    check('clicking a file opens it', opened.join(',') === 'src/pages/about.astro', opened.join(','));
    check('and the popup gets out of the way', !popup(), 'still open');

    opened.length = 0;
    await act(async () => {
      countButton().click();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      popup().querySelectorAll('.instances-row')[0].click();
      await new Promise((r) => setTimeout(r, 10));
    });
    check('clicking an instance on this page selects it', opened.join(',') === 'node:n1', opened.join(','));

    // ── Where the popup opens ───────────────────────────────────────────────
    // Against the row that was clicked. It used to be pushed up by a fixed
    // amount to keep it on screen, which for a row near the bottom of a long
    // palette left it floating half a screen away from the thing it was about.
    {
      // jsdom lays nothing out, so the two measurements the placement needs are
      // supplied: how tall the popup is, and where the row is.
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() { return this.classList?.contains('instances-popup') ? 200 : 0 },
      });
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() { return this.classList?.contains('instances-popup') ? 260 : 0 },
      });
      dom.window.innerHeight = 768;
      dom.window.innerWidth = 1200;
      const openAt = async (rect) => {
        const btn = countButton();
        btn.getBoundingClientRect = () => ({ ...rect, right: rect.left + 80, width: 80, height: rect.bottom - rect.top });
        await act(async () => {
          btn.click();
          await new Promise((r) => setTimeout(r, 20));
        });
        return popup();
      };
      const close = () =>
        act(async () => {
          popup()?.querySelector('.instances-head button').click();
          await new Promise((r) => setTimeout(r, 5));
        });

      usageAnswer = { files: [{ rel: 'src/pages/a.astro', path: '/p/a', kind: 'page', count: 1 }] };
      await render({ reason: 'Select an element on the canvas first.' });

      const high = await openAt({ left: 20, top: 90, bottom: 103 });
      check('a row with room below opens below it', high.style.top === '109px', high.style.top);
      check('and lines up with the row', high.style.left === '20px', high.style.left);
      await close();

      const low = await openAt({ left: 20, top: 700, bottom: 713 });
      // 200 tall, ending 6px above a row that starts at 700.
      check(
        'a row near the bottom opens directly above it instead',
        low.style.top === '494px',
        `${low.style.top} — should end just above the row, not float away from it`
      );
      await close();

      // A window that reports no size at all (a hidden or not-yet-laid-out
      // view) can't be fitted into; the row is still where the popup goes.
      dom.window.innerHeight = 0;
      dom.window.innerWidth = 0;
      const blind = await openAt({ left: 20, top: 700, bottom: 713 });
      check('with no viewport to speak of it stays on its row', blind.style.top === '719px', blind.style.top);
      await close();
      dom.window.innerHeight = 768;
      dom.window.innerWidth = 1200;
    }

    // A lookup that FAILED is not a component that is used nowhere. The first
    // version of this swallowed the error into an empty list, and the popup
    // calmly said "not used anywhere yet" about a component used six times.
    usageAnswer = { error: 'no such handler' };
    await render({ reason: 'Select an element on the canvas first.' });
    await act(async () => {
      countButton().click();
      await new Promise((r) => setTimeout(r, 20));
    });
    check(
      "a failed look says it failed",
      /couldn’t read the project/i.test(popup()?.textContent || ''),
      popup()?.textContent
    );
    check(
      'and never that the component is unused',
      !/not used anywhere/i.test(popup()?.textContent || ''),
      popup()?.textContent
    );
    await act(async () => {
      popup().querySelector('.instances-head button').click();
      await new Promise((r) => setTimeout(r, 10));
    });

    // Nothing anywhere is a sentence, not an empty box.
    instancesHere = [];
    usageAnswer = { files: [] };
    await render({ reason: 'Select an element on the canvas first.' });
    await act(async () => {
      countButton().click();
      await new Promise((r) => setTimeout(r, 20));
    });
    check(
      'a component used nowhere says so',
      /not used anywhere/i.test(popup()?.textContent || ''),
      popup()?.textContent
    );
    await act(async () => {
      popup().querySelector('.instances-head button').click();
      await new Promise((r) => setTimeout(r, 10));
    });
    check('and it closes', !popup(), 'still open');

    // Nothing read from the page → nothing to offer.
    await render({ name: 'Plain', label: '<div>', props: [] });
    await act(async () => { makeButton().click(); await new Promise((r) => setTimeout(r, 10)) });
    check(
      'markup that reads nothing is asked nothing',
      !dom.window.document.querySelector('.modal .check-row'),
      'offered props for markup with none'
    );
    await act(async () => {
      [...dom.window.document.querySelectorAll('.modal-footer button')]
        .find((b) => /Cancel/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 5));
    });

    await act(async () => { root.unmount() });
  }

  if (failures.length) {
    console.error(`\ncomponent-create: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`component-create: ${checked} passed  [names, file, round trip, panel]`);
})();
