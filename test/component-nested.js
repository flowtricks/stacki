// Components in folders, and the stylesheet for a project's variables.
//
//   node test/component-nested.js      (needs `npm run build:runtime` first)
//
// A component's folder is a path of plain words under src/components, made on the
// way — the first component creates src/components itself. Its name is also an
// import and a tag, so it must be unique across the whole tree, not just its own
// folder. Imports it carries are re-aimed from where the file now sits.
//
// The variables file is the other half: a project with no stylesheet gets
// src/styles/variables.css and the import that makes Astro ship it, once, in the
// frontmatter next to the imports already there, without disturbing line endings.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);}
};
const throws = (what, fn, pattern) => {
  try {
    fn();
    check(what, false, 'did not throw');
  } catch (error) {
    check(what, pattern.test(String(error.message)), error.message);
  }
};

const dist = (name) => require(path.join(__dirname, '..', 'dist', 'electron', name));
const { componentFile } = dist('componentFile.js');
const { withStylesheetImport, createVariablesFile } = dist('variablesFile.js');

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-nested-'));
const pagePath = path.join(project, 'src', 'pages', 'index.astro');
fs.mkdirSync(path.dirname(pagePath), { recursive: true });
const node = {
  id: 'a',
  kind: 'element',
  name: 'span',
  props: { class: { type: 'string', value: 'eyebrow' } },
  children: [{ id: 'b', kind: 'text', value: 'Hi' }],
};
const imports = [{ name: 'Icon', path: '../components/Icon.astro' }];
const withIcon = {
  ...node,
  children: [{ id: 'c', kind: 'component', name: 'Icon', props: {}, children: null }],
};
const make = (extra) => componentFile({ projectPath: project, pagePath, name: 'Eyebrow', nodes: [node], ...extra });

// Folders.
check('no folder: the root', make({}).rel === 'src/components/Eyebrow.astro', make({}).rel);
check('one folder', make({ folder: 'heading' }).rel === 'src/components/heading/Eyebrow.astro');
check(
  'folders inside folders',
  make({ folder: 'sections/hero' }).rel === 'src/components/sections/hero/Eyebrow.astro',
);
check('computing the file writes nothing', !fs.existsSync(path.join(project, 'src', 'components')));

// Imports are re-aimed from the new depth.
const moved = make({ folder: 'heading', nodes: [withIcon], imports });
check('a relative import is re-aimed from the folder', /\.\.\/Icon\.astro/.test(moved.text), moved.text);

// Folder safety.
for (const bad of ['..', '../x', 'a/../b', 'C:\\x', 'a b!', 'a/b/c/d/e/f']) {
  throws(`folder "${bad}" is refused`, () => make({ folder: bad }), /folder|deep|name/i);
}

// A leading slash is not an escape: it is read as a folder under src/components.
check('a leading slash stays inside', make({ folder: '/abs' }).rel === 'src/components/abs/Eyebrow.astro');

// Unique across the tree.
fs.mkdirSync(path.join(project, 'src', 'components', 'heading'), { recursive: true });
fs.writeFileSync(path.join(project, 'src', 'components', 'heading', 'Eyebrow.astro'), '<span />');
throws('same name, other folder, is a clash', () => make({ folder: 'cards' }), /already a component called Eyebrow/);
throws('and whatever the case', () => make({ name: 'EYEBROW', folder: 'cards' }), /already a component/);

// Stylesheet import.
const page = "---\nimport Base from '../layouts/Base.astro';\nconst a = 1;\n---\n<h1 />\n";
const once = withStylesheetImport(page, '../styles/variables.css');
check(
  'import lands after the existing imports',
  once.split('\n').slice(0, 4).join('|') ===
    "---|import Base from '../layouts/Base.astro';|import '../styles/variables.css';|const a = 1;",
  once,
);
check('idempotent', withStylesheetImport(once, '../styles/variables.css') === once);
check(
  'no frontmatter: one is made',
  withStylesheetImport('<h1 />\n', './v.css') === "---\nimport './v.css';\n---\n<h1 />\n",
);
check(
  'CRLF files stay CRLF',
  !/[^\r]\n/.test(withStylesheetImport(page.replace(/\n/g, '\r\n'), '../v.css')),
);
check('an unterminated frontmatter is left alone', withStylesheetImport('---\nconst a', './v.css') === '---\nconst a');

// The file, on a project with a layout.
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-vars-'));
fs.mkdirSync(path.join(app, 'src', 'layouts'), { recursive: true });
const layout = path.join(app, 'src', 'layouts', 'Base.astro');
fs.writeFileSync(layout, "---\nimport Nav from '../components/Nav.astro';\n---\n<slot />\n");
const touched = [];
const made = createVariablesFile(app, (file) => touched.push(path.basename(file)));
const cssPath = path.join(app, 'src', 'styles', 'variables.css');
const css = fs.readFileSync(cssPath, 'utf8');
check('the file has a :root with variables', /:root \{[^}]*--color-primary/.test(css), css);
check('the layout imports it', fs.readFileSync(layout, 'utf8').includes("import '../styles/variables.css';"));
check('it says which files it imported into', made.imported.join() === 'src/layouts/Base.astro', made.imported.join());
check('both writes were announced', touched.includes('variables.css') && touched.includes('Base.astro'), touched.join());
const again = createVariablesFile(app, () => {});
check('a second run changes nothing', again.imported.length === 0 && fs.readFileSync(cssPath, 'utf8') === css);

// No layout: the index page.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bare-'));
fs.mkdirSync(path.join(bare, 'src', 'pages'), { recursive: true });
const indexPath = path.join(bare, 'src', 'pages', 'index.astro');
fs.writeFileSync(indexPath, '<h1>Hi</h1>\n');
const viaIndex = createVariablesFile(bare, () => {});
check(
  'without a layout the index page imports it',
  viaIndex.imported.join() === 'src/pages/index.astro' &&
    fs.readFileSync(indexPath, 'utf8').includes("import '../styles/variables.css'"),
);

// An existing file without :root is added to, not replaced.
const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-partial-'));
fs.mkdirSync(path.join(partial, 'src', 'styles'), { recursive: true });
const partialCss = path.join(partial, 'src', 'styles', 'variables.css');
fs.writeFileSync(partialCss, '.x { color: red; }\n');
createVariablesFile(partial, () => {});
const kept = fs.readFileSync(partialCss, 'utf8');
check('existing css is kept and :root appended', kept.includes('.x { color: red; }') && kept.includes(':root'), kept);

for (const dir of [project, app, bare, partial]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`component-nested: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`component-nested: ${checked} checks passed`);
