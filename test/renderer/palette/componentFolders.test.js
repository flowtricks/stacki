// Components in folders, and folders in folders.
//
//   node test/renderer/palette/componentFolders.test.js
//
// A project the size of a design system does not keep forty components in one
// folder. It keeps `Form/Fieldset.astro`, and then `Form/Fields/Input.astro`,
// and then — because someone has to hold the line somewhere and it will not be
// today — `Form/Fields/Advanced/Combobox.astro`.
//
// The scan walks, so depth costs it nothing. The two places that then have to
// say something about the folder are the panel, which groups by it, and the
// search, which has to be able to find a component by where it lives as well as
// by what it is called. `form input` is how a person says which Input.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// The scan main.js does over src: walk for .astro, and call the folder the path
// from the root it was found under. Repeated here because it lives inside an
// ipc handler in a file that cannot be required outside Electron — so what is
// checked is that a walk of a real tree with folders inside folders produces
// the records the panel and the search are written against.
// A walk of a project's folders stops at this depth: real source trees are a few folders
// deep, so anything deeper is a loop or a runaway, not a project.
const WALK_LIMITS = { directoryDepthMax: 32 };
const listAstroFiles = (directory) => {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const out = [];
  const walk = (folder, depth = 0) => {
    assert.ok(depth <= WALK_LIMITS.directoryDepthMax, 'walk: directory depth limit');
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.astro')) {
        out.push(full);
      }
    }
  };
  walk(directory);
  return out;
};
const toPosix = (filePath) => filePath.split(path.sep).join('/');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-folders-'));
  const write = (rel) => {
    const full = path.join(directory, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '---\n---\n<div><slot /></div>\n');
  };
  write('src/components/Card.astro');
  write('src/components/Form/Fieldset.astro');
  write('src/components/Form/Fields/Input.astro');
  write('src/components/Form/Fields/Advanced/Combobox.astro');
  write('src/components/Form/Layout/Row.astro');
  write('src/layouts/marketing/Landing.astro');

  const source = path.join(directory, 'src');
  const componentsDirectory = path.join(source, 'components');
  const components = listAstroFiles(componentsDirectory).map((filePath) => ({
    path: filePath,
    name: path.basename(filePath, '.astro'),
    folder: toPosix(path.relative(componentsDirectory, path.dirname(filePath))),
  }));
  const layouts = listAstroFiles(path.join(source, 'layouts')).map((filePath) => ({
    path: filePath,
    name: path.basename(filePath, '.astro'),
    folder: toPosix(path.relative(source, path.dirname(filePath))),
    isLayout: true,
  }));

  const folderOf = (name) => components.concat(layouts).find((component) => component.name === name)?.folder;

  // --- the scan ------------------------------------------------------------------
  check('every component is found, however deep', components.length === 5, String(components.length));
  check('one at the root has no folder', folderOf('Card') === '', JSON.stringify(folderOf('Card')));
  check('one a folder down says so', folderOf('Fieldset') === 'Form', folderOf('Fieldset'));
  check('two down says both', folderOf('Input') === 'Form/Fields', folderOf('Input'));
  check('three down says all three', folderOf('Combobox') === 'Form/Fields/Advanced', folderOf('Combobox'));
  check('and a layout reads from src', folderOf('Landing') === 'layouts/marketing', folderOf('Landing'));

  // --- the panel's grouping -------------------------------------------------------
  //
  // A group per folder, the ungrouped ones first, the rest in path order — so a
  // folder's own components sit above the folders inside it rather than
  // scattered through the list.
  const groupsOf = (list) => {
    const byFolder = new Map();
    for (const component of list) {
      const key = component.folder || '';
      if (!byFolder.has(key)) {
        byFolder.set(key, []);
      }
      byFolder.get(key).push(component);
    }
    return [...byFolder.entries()].sort(([left], [right]) => (left === '' ? -1 : right === '' ? 1 : left.localeCompare(right)));
  };
  const headings = groupsOf(components).map(([folder]) => folder);
  check('the root comes first', headings[0] === '', JSON.stringify(headings));
  check(
    'and each folder is its own group, named by its path',
    headings.join(' | ') === ' | Form | Form/Fields | Form/Fields/Advanced | Form/Layout',
    headings.join(' | '),
  );

  // --- searching by where it lives --------------------------------------------------
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'component-folders.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/palette/insertRank.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { rankInsertItems } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
  const found = (query) => rankInsertItems(components, query).map((item) => item.name);

  check('a component is found by its name', found('combobox').join() === 'Combobox', found('combobox').join());
  check('by the folder it is in', found('advanced').join() === 'Combobox', found('advanced').join());
  // Still being typed, `fields` is a beginning — and Fieldset begins that way,
  // so it is offered. Finished, it is the folder and Fieldset is not in it.
  check('a folder further up the path, while it is being typed', found('fields').sort().join() === 'Combobox,Fieldset,Input', found('fields').join());
  check('and once the word is finished, only what is in it', found('fields ').sort().join() === 'Combobox,Input', found('fields ').join());
  check('and by the top of it', found('form').sort().join() === 'Combobox,Fieldset,Input,Row', found('form').join());
  check('folder then name names one of them', found('form input').join() === 'Input', found('form input').join());
  check('and so does a folder inside a folder', found('fields advanced').join() === 'Combobox', found('fields advanced').join());
  check('every segment of the path can be said', found('form fields advanced combobox').join() === 'Combobox', found('form fields advanced combobox').join());
  check('a folder that is not on the path finds nothing', found('layout input').length === 0, found('layout input').join());

  // The panel and the palette ask the same question of the same list.
  const panel = fs.readFileSync(repoPath('src/features/palette/PalettePanel.tsx'), 'utf8');
  check(
    'the components panel searches by that rule too',
    /rankInsertItems\(props\.components, query\)/.test(panel),
    'the panel has its own idea of what matches',
  );
  const model = fs.readFileSync(repoPath('src/features/palette/paletteModel.ts'), 'utf8');
  check('and still groups what comes back by folder', /const folder = component\.folder;/.test(model), 'the grouping went with it');

  fs.rmSync(directory, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\ncomponent-folders: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`component-folders: ${checked} passed  [folders, and folders inside them]`);
})();
