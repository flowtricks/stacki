// Lifting a block of a page out into a component of its own.
//
//   node test/create-component.js
//
// Two halves, and the first one is the whole safety of the feature.
//
// refusals   A block that reads a loop's item, a const from the frontmatter,
//            or Astro.props is finished by the page around it. Extract it and
//            the new file compiles, renders `undefined`, and says nothing —
//            at build time, on a page nobody had open. Every reference that
//            survives the check is a silent bug shipped, so the check is
//            tested against real parsed pages rather than hand-built nodes.
//
// round trip What the component file is written from is the subtree plus the
//            imports it still uses. Serialize it, parse it back, and the
//            markup has to be the same markup — a block that changes shape on
//            the way out is a page that changes shape on the way back in.
//
// The import relocation (a page's `../components/X.astro` re-aimed from
// src/components/) is main.js's, because only that process has Node's path
// rules; what is checked here is the half that decides WHICH imports travel.

const path = require('path');
const { pathToFileURL } = require('url');
const { parsePage, serializePage } = require('../electron/astroParser.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The node at a path of child indices, the way the navigator addresses one.
const at = (nodes, ...trail) => {
  let cur = { children: nodes };
  for (const i of trail) cur = cur.children[i];
  return cur;
};

(async () => {
  const {
    codeInSubtree,
    externalNeeds,
    componentNamesIn,
    suggestedComponentName,
    frontmatterBindings,
  } = await import(
    pathToFileURL(path.join(__dirname, '..', 'src', 'componentExtract.js')).href
  );

  // --- what the frontmatter declares --------------------------------------

  {
    const fm = [
      'const title = "Home";',
      'let count = 3;',
      'function slugify(s) { return s; }',
      'const { heading, items = [] } = Astro.props;',
      'const [first, second] = list;',
      '// const commented = 1;',
    ].join('\n');
    const names = frontmatterBindings(fm);
    for (const n of ['title', 'count', 'slugify', 'heading', 'items', 'first', 'second']) {
      check(`${n} is a page binding`, names.includes(n));
    }
    check('a commented-out declaration is not', !names.includes('commented'));
  }

  // --- refusals -------------------------------------------------------------

  const page = (body, fm = '') => {
    const parsed = parsePage(`---\n${fm}\n---\n${body}`);
    if (!parsed.editable) throw new Error(`test page did not parse:\n${body}`);
    return parsed.model;
  };

  const needsOf = (model, node, loopVars = []) =>
    externalNeeds({
      node,
      code: codeInSubtree(node),
      loopVars,
      frontmatter: model.extraFrontmatter,
    });

  {
    // A card inside a loop, reading the loop's item.
    const model = page(
      '{posts.map((post) => (\n  <article class="card">\n    <h2>{post.title}</h2>\n  </article>\n))}',
      'const posts = [];'
    );
    const loop = at(model.nodes, 0);
    const card = loop.children.find((n) => n.kind === 'element');
    check('the loop parsed', !!card, JSON.stringify(loop.kind));
    if (card) {
      const needs = needsOf(model, card, ['post']);
      check('a block reading the loop item is refused', needs.includes('post'), JSON.stringify(needs));
    }
  }

  {
    const model = page('<h1>{title}</h1>', 'const title = "Home";');
    const needs = needsOf(model, at(model.nodes, 0));
    check('a block reading a frontmatter const is refused', needs.includes('title'), JSON.stringify(needs));
  }

  {
    // The interpolation is inside a text node, not a prop — the reading that
    // codeText skips and this one must not.
    const model = page('<p>Hello {name}, welcome</p>', 'const name = "you";');
    const needs = needsOf(model, at(model.nodes, 0));
    check('including one interpolated mid-sentence', needs.includes('name'), JSON.stringify(needs));
  }

  {
    const model = page('<div class="a" data-x={Astro.props.x}>hi</div>');
    const needs = needsOf(model, at(model.nodes, 0));
    check('a block reading Astro.props is refused', needs.includes('Astro.props'), JSON.stringify(needs));
  }

  {
    // `const Tag = as` then `<Tag>` — a frontmatter binding used as an element,
    // which appears nowhere in any expression.
    const model = page('<Tag class="box">text</Tag>', 'const Tag = "div";');
    const needs = needsOf(model, at(model.nodes, 0));
    check('a block built on a dynamic tag is refused', needs.includes('Tag'), JSON.stringify(needs));
  }

  {
    const model = page(
      '<section class="hero">\n  <h1>Static</h1>\n  <p>Nothing from outside</p>\n</section>',
      'const unrelated = 1;'
    );
    const needs = needsOf(model, at(model.nodes, 0));
    check('a self-contained block is not refused', needs.length === 0, JSON.stringify(needs));
  }

  {
    // The near miss the whole `readsVar` shape exists for.
    const model = page('<p>{services.length}</p>', 'const services = [];');
    const needs = needsOf(model, at(model.nodes, 0), ['service']);
    check('`services` is not read as the loop item `service`', !needs.includes('service'), JSON.stringify(needs));
  }

  // --- which imports travel -------------------------------------------------

  {
    const model = page(
      '<div class="wrap">\n  <Button label="Go" />\n</div>\n<Footer />',
      "import Button from '../components/Button.astro';\nimport Footer from '../components/Footer.astro';\nimport Card from '../components/Card.astro';"
    );
    const wrap = at(model.nodes, 0);
    const placed = componentNamesIn(wrap);
    check('the block takes the component it places', placed.has('Button'));
    check('and not one it merely sits beside', !placed.has('Footer'));
    check('nor one the page never places', !placed.has('Card'));
  }

  // --- the round trip -------------------------------------------------------

  {
    const body =
      '<section class="hero">\n  <h1>Title</h1>\n  <Button label="Go" />\n</section>';
    const model = page(body, "import Button from '../components/Button.astro';");
    const node = at(model.nodes, 0);
    const carried = model.imports.filter((i) => componentNamesIn(node).has(i.name));

    const source = serializePage({
      imports: carried,
      nodes: [node],
      hadFrontmatter: carried.length > 0,
    });

    check('the component file keeps the import its markup needs', /import Button from/.test(source), source);
    const back = parsePage(source);
    check('and parses back', back.editable === true, JSON.stringify(back.reason));
    if (back.editable) {
      const before = serializePage({ imports: [], nodes: [node], hadFrontmatter: false });
      const after = serializePage({ imports: [], nodes: back.model.nodes, hadFrontmatter: false });
      check('as the same markup it went out as', before === after, `${before}\n---\n${after}`);
    }
  }

  {
    // A component with no imports acquires no frontmatter block. Writing `---`
    // twice at the top of a file that needs neither is a diff for nothing.
    const model = page('<div class="plain">text</div>');
    const source = serializePage({
      imports: [],
      nodes: [at(model.nodes, 0)],
      hadFrontmatter: false,
    });
    check('a component needing nothing gets no frontmatter', !source.startsWith('---'), source);
  }

  // --- the suggested name ---------------------------------------------------

  {
    const model = page('<section class="hero-card wide">x</section>\n<footer>y</footer>');
    check(
      'the name is suggested from the first class',
      suggestedComponentName(at(model.nodes, 0)) === 'HeroCard',
      suggestedComponentName(at(model.nodes, 0))
    );
    const footer = model.nodes.find((n) => n.name === 'footer');
    check(
      'and from the tag when there is no class',
      suggestedComponentName(footer) === 'Footer',
      suggestedComponentName(footer)
    );
  }

  // --- the dialog that names it --------------------------------------------
  //
  // Naming the component is the only step where the user can be wrong, and the
  // dialog is what stops a wrong name from reaching the file system: a taken
  // name, a lowercase one, an empty field. All three are held by the same
  // `validate`, and all three are one keystroke from being confirmed anyway if
  // Return does not respect it.
  await dialogChecks();

  if (failures.length) {
    console.error(`create-component: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`create-component: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function dialogChecks() {
  const fs = require('fs');
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'confirm-dialog.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'ConfirmDialog.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const { ConfirmHost, confirmDialog } = require(bundlePath);

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(ConfirmHost)));

  let answered;
  const taken = new Set(['Hero']);
  await act(async () => {
    confirmDialog({
      title: 'Create a component',
      confirmLabel: 'Create',
      input: {
        label: 'Component name',
        defaultValue: 'HeroCard',
        validate: (v) => {
          if (!v) return 'A component needs a name.';
          if (!/^[A-Z][A-Za-z0-9]*$/.test(v)) return 'Starts with a capital.';
          if (taken.has(v)) return `There is already a component called ${v}.`;
          return null;
        },
      },
    }).then((a) => {
      answered = a;
    });
  });

  const field = () => dom.window.document.querySelector('.confirm-field input');
  const confirmBtn = () => dom.window.document.querySelector('.modal-footer button.primary');
  const problem = () => dom.window.document.querySelector('.confirm-field-problem');

  check('the field is there', !!field());
  check('carrying the suggested name', field()?.value === 'HeroCard', field()?.value);
  check('and holding focus, not a button', dom.window.document.activeElement === field());
  check('with the confirm open', confirmBtn() && !confirmBtn().disabled);

  const type = async (value) => {
    await act(async () => {
      const el = field();
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  await type('Hero');
  check('a name already taken closes the confirm', confirmBtn()?.disabled === true);
  check('and says which', /already a component called Hero/.test(problem()?.textContent || ''), problem()?.textContent);

  await type('hero');
  check('so does a lowercase one', confirmBtn()?.disabled === true);

  await type('');
  check('so does an empty field', confirmBtn()?.disabled === true);
  check('quietly, before anything has been typed', !problem(), problem()?.textContent);

  // Return is the fast path out of this dialog, and the one that would skip a
  // disabled button without ever touching it.
  await act(async () => {
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
  });
  check('and Return does not confirm past it', answered === undefined, JSON.stringify(answered));

  await type('HeroCard');
  check('a good name opens it again', confirmBtn()?.disabled === false);
  await act(async () => {
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
  });
  check('and Return answers with it', answered?.value === 'HeroCard', JSON.stringify(answered));
}
