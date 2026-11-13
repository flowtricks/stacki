// Goal: renaming a prop renames the local variable that reads it, everywhere that
// name means that binding and nowhere else, and instances across the site still
// follow, in one write and one undo step. A local that cannot take the new name
// blocks the whole rename, with the plan's own reason and nothing written. It
// never falls back to `{ perks: features }`.
//
// Method: real components go through main's real transaction over a temporary
// project on disk, and each result is compared byte for byte with the file it
// should be. The negative space is walked by kind: every sort of clash, then every
// refusal that is not about the name, each pinned by its message, each checked to
// have left every file as it was.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');
const { inverseBatch, PropertyUndoStore, revertComponentProperties, updateComponentProperties } = require('#dist/electron/properties/componentProperties.js');
const { documentHost } = require('#dist/electron/documents/documentWrites.js');

const writer = { documents: documentHost().documents, noteWrite: () => {} };

const PAGE = `---
import Pricing from '../components/Pricing.astro';
const features = ['the page has its own'];
---
<Pricing features={features} />
<Pricing {features} />
<Pricing {...{ features: [] }} />
`;

const component = (frontmatter, template) => `---\n${frontmatter}\n---\n${template}\n`;
const PROPS = 'interface Props {\n  features?: string[];\n}';

function renameSave(source, overrides = {}, from = 'features') {
  const property = readComponentProperties(source).properties.find((candidate) => candidate.name === from);
  assert.ok(property, `${from} is a prop of this source`);
  return { kind: 'save', originalName: from, property: { ...property, name: 'perks', ...overrides } };
}

// A project holding `source` as a component and PAGE as a page using it.
function inProject(source, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-local-rename-'));
  const file = path.join(root, 'src/components/Pricing.astro');
  const page = path.join(root, 'src/pages/index.astro');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(file, source);
  fs.writeFileSync(page, PAGE);
  try {
    return run({ root, file, page, read: () => fs.readFileSync(file, 'utf8'), readPage: () => fs.readFileSync(page, 'utf8') });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}

function renamed(source, overrides) {
  return inProject(source, ({ root, file, read }) => {
    const result = updateComponentProperties({ projectPath: root, file, source, change: renameSave(source, overrides) }, writer);
    assert.equal(result.ok, true, JSON.stringify(result));
    return read();
  });
}

function refusal(source, overrides) {
  return inProject(source, ({ root, file, read, readPage }) => {
    const result = updateComponentProperties({ projectPath: root, file, source, change: renameSave(source, overrides) }, writer);
    assert.equal(result.ok, false, 'The rename is refused');
    assert.equal(read(), source, 'The component is untouched');
    assert.equal(readPage(), PAGE, 'The instances are untouched');
    // The reference beside the English sentence is pinned in one place (the keys the editor words a rename with).
    assert.equal(typeof result.error.messageRef?.key, 'string', 'The refusal carries a message reference');
    const { messageRef: _messageRef, ...english } = result.error;
    return english;
  });
}

test('a destructured prop renames in the frontmatter, the template and the .map head', () => {
  const source = component(
    `${PROPS}\nconst { features } = Astro.props;\nconst count = features.length;\nconst first = features[0];`,
    '<p class={features.length > 1 ? "many" : "one"}>{count} {first}</p>\n<ul>{features.map((feature) => <li>{feature}</li>)}</ul>',
  );
  assert.equal(
    renamed(source),
    component(
      'interface Props {\n  perks?: string[];\n}\nconst { perks } = Astro.props;\nconst count = perks.length;\nconst first = perks[0];',
      '<p class={perks.length > 1 ? "many" : "one"}>{count} {first}</p>\n<ul>{perks.map((feature) => <li>{feature}</li>)}</ul>',
    ),
  );
});

test('what only looks like the name stays: keys, members, strings, comments and text', () => {
  const source = component(
    `${PROPS}\nconst { features } = Astro.props;\n// features of the plan.\nconst label = 'features';\nconst other = { features: 1 }.features;`,
    '<h2 title="features">features</h2>\n<p>{features.length}</p>',
  );
  assert.equal(
    renamed(source),
    component(
      "interface Props {\n  perks?: string[];\n}\nconst { perks } = Astro.props;\n// features of the plan.\nconst label = 'features';\nconst other = { features: 1 }.features;",
      '<h2 title="features">features</h2>\n<p>{perks.length}</p>',
    ),
  );
});

test('an inner binding of the old name is its own variable, and stays', () => {
  const source = component(`${PROPS}\nconst { features } = Astro.props;\nconst size = (features) => features.length;`, '<p>{size(features)}</p>');
  const written = renamed(source);
  assert.match(written, /const size = \(features\) => features\.length;/);
  assert.match(written, /<p>\{size\(perks\)\}<\/p>/);
});

test('an aliased prop keeps its alias: only the key changes', () => {
  const source = component(`${PROPS}\nconst { features: list } = Astro.props;`, '<p>{list.length}</p>');
  assert.equal(renamed(source), component('interface Props {\n  perks?: string[];\n}\nconst { perks: list } = Astro.props;', '<p>{list.length}</p>'));
});

test('an alias is not checked against what its key clashes with, since no local changes', () => {
  const source = component(`${PROPS}\nconst { features: list } = Astro.props;\nconst perks = 1;`, '<p>{list.length} {perks}</p>');
  assert.match(renamed(source), /const \{ perks: list \} = Astro\.props;\nconst perks = 1;/);
});

test('a default is kept, and a default changed in the same save lands', () => {
  const source = component(`${PROPS}\nconst { features = [] } = Astro.props;`, '<p>{features.length}</p>');
  assert.equal(renamed(source), component('interface Props {\n  perks?: string[];\n}\nconst { perks = [] } = Astro.props;', '<p>{perks.length}</p>'));
  assert.match(renamed(source, { defaultValue: "['a']" }), /const \{ perks = \['a'\] \} = Astro\.props;/);
});

test('shorthand keeps what it passes: the key stays and the value is the new name', () => {
  const source = component(
    `import Card from './Card.astro';\n${PROPS}\nconst { features } = Astro.props;\nconst data = { features };`,
    '<Card {features} />\n<Card features={features} />\n<Card {...{ features }} />',
  );
  const written = renamed(source);
  assert.match(written, /const data = \{ features: perks \};/);
  assert.match(written, /<Card features=\{perks\} \/>\n<Card features=\{perks\} \/>\n<Card \{\.\.\.\{ features: perks \}\} \/>/);
});

test('a component that renders itself passes the new name to the new name', () => {
  const source = component(`import Pricing from './Pricing.astro';\n${PROPS}\nconst { features } = Astro.props;`, '<Pricing {features} />');
  assert.match(renamed(source), /<Pricing perks=\{perks\} \/>/);
});

test('Astro.props reads, the Props key and types that name the key all follow', () => {
  const source = component(
    `interface Props {\n  /** Listed. */\n  features?: string[];\n}\ntype Item = Props['features'];\nconst { features } = Astro.props;\nconst direct = Astro.props.features;\nconst computed = Astro.props['features'];`,
    '<p>{features.length} {Astro.props.features}</p>',
  );
  assert.equal(
    renamed(source),
    component(
      `interface Props {\n  /** Listed. */\n  perks?: string[];\n}\ntype Item = Props["perks"];\nconst { perks } = Astro.props;\nconst direct = Astro.props.perks;\nconst computed = Astro.props["perks"];`,
      '<p>{perks.length} {Astro.props.perks}</p>',
    ),
  );
});

test('a prop only read through Astro.props has no local, and the name is free to clash', () => {
  const source = component(`${PROPS}\nconst perks = Astro.props.features;`, '<p>{perks}</p>');
  assert.match(renamed(source), /const perks = Astro\.props\.perks;/);
});

test('an inline type annotation renames its key with the binding', () => {
  const source = component('const { features }: { features: string[] } = Astro.props;', '<p>{features.length}</p>');
  assert.equal(renamed(source), component('const { perks }: { perks: string[] } = Astro.props;', '<p>{perks.length}</p>'));
});

test('instance attributes still rename across the site, and the page’s own variable stays', () => {
  const source = component(`${PROPS}\nconst { features } = Astro.props;`, '<p>{features.length}</p>');
  inProject(source, ({ root, file, readPage }) => {
    assert.equal(updateComponentProperties({ projectPath: root, file, source, change: renameSave(source) }, writer).ok, true);
    assert.equal(
      readPage(),
      PAGE.replace('<Pricing features={features} />', '<Pricing perks={features} />')
        .replace('<Pricing {features} />', '<Pricing perks={features} />')
        .replace('{...{ features: [] }}', '{...{ perks: [] }}'),
    );
  });
});

test('the name clashing with what the file holds blocks the rename, and nothing is written', () => {
  const cases = [
    ['a declaration', `${PROPS}\nconst { features } = Astro.props;\nconst perks = 1;`, '<p>{features} {perks}</p>', '“perks” already exists in this file.'],
    [
      'an import',
      `import perks from './perks.js';\n${PROPS}\nconst { features } = Astro.props;`,
      '<p>{features} {perks}</p>',
      '“perks” already exists in this file.',
    ],
    ['a read with no declaration', `${PROPS}\nconst { features } = Astro.props;`, '<p>{features} {perks}</p>', '“perks” already exists in this file.'],
  ];
  for (const [name, frontmatter, template, message] of cases) {
    assert.deepEqual(refusal(component(frontmatter, template)), { code: 'name', message }, name);
  }
});

test('a global blocks the rename: the file would stop reading it', () => {
  const source = component(`${PROPS}\nconst { features } = Astro.props;`, '<p>{features}</p>');
  assert.deepEqual(refusal(source, { name: 'URL' }), { code: 'name', message: '“URL” already exists in this file.' });
});

test('an inner binding that would capture the name blocks the rename', () => {
  const message = '“perks” is already a name inside a loop or function that reads “features”, so it would read that instead.';
  const inFrontmatter = component(`${PROPS}\nconst { features } = Astro.props;\nconst size = (perks) => features.length + perks;`, '<p>{size(1)}</p>');
  assert.deepEqual(refusal(inFrontmatter), { code: 'name', message });
  const inTemplate = component(`${PROPS}\nconst { features } = Astro.props;`, '{[1].map((perks) => <p>{features.length} {perks}</p>)}');
  assert.deepEqual(refusal(inTemplate), { code: 'name', message });
});

test('a reserved word blocks the rename, though a key could hold it: there is no silent alias', () => {
  const source = component(`${PROPS}\nconst { features } = Astro.props;`, '<p>{features}</p>');
  assert.deepEqual(refusal(source, { name: 'class' }), { code: 'name', message: '“class” is a reserved word in JavaScript. Pick another name.' });
});

test('another prop of that name keeps the definition’s own reason', () => {
  const source = component(
    'interface Props {\n  features?: string[];\n  perks?: string;\n}\nconst { features, perks } = Astro.props;',
    '<p>{features} {perks}</p>',
  );
  assert.deepEqual(refusal(source), { code: 'duplicate', message: 'A property named perks already exists.' });
});

test('a refusal not about the name is the plan’s, with the plan’s reason', () => {
  const syntax = component(`${PROPS}\nconst { features } = Astro.props;\nconst = 1;`, '<p>{features}</p>');
  assert.deepEqual(refusal(syntax), { code: 'name', message: 'The frontmatter has a syntax error, so this can’t be renamed safely. Fix it first.' });
  const tag = component(`${PROPS}\nconst { features } = Astro.props;`, '<features.Icon />');
  assert.deepEqual(refusal(tag), { code: 'name', message: '“features” is used as a tag, <features>, so it can’t be renamed here. Rename it in the code.' });
  const unreadable = component(`${PROPS}\nconst { features } = Astro.props;`, '<div {features.length}></div>');
  assert.deepEqual(refusal(unreadable), { code: 'name', message: 'This code can’t be read to rename it safely: features.length. Rename it in the code.' });
});

test('a template the parser cannot represent refuses, and says what it found', () => {
  const source = component(`${PROPS}\nconst { features } = Astro.props;`, '<div><p>{features}</div>');
  const error = refusal(source);
  assert.equal(error.code, 'name');
  assert.match(error.message, /^This component can’t be read to rename “features” safely\./);
});

test('a save that does not rename leaves the local alone, and reads nothing of the plan', () => {
  // This file would be refused by a rename: nothing but a rename may reach the plan.
  const source = component(`${PROPS}\nconst { features } = Astro.props;`, '<features.Icon />');
  const edited = editPropertyDefinition(source, renameSave(source, { name: 'features', description: 'Tip.' }));
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.match(edited.value, /const \{ features \} = Astro\.props;/);
});

test('a rename and its instances are one batch: one undo restores every file, and redo returns them', () => {
  const source = component(`${PROPS}\nconst { features = [] } = Astro.props;`, '<ul>{features.map((item) => <li>{item}</li>)}</ul>');
  inProject(source, ({ root, file, read, readPage }) => {
    const store = new PropertyUndoStore();
    const tokens = [];
    const batches = [];
    const recording = {
      ...writer,
      onCommitted: (changes) => {
        batches.push(changes);
        tokens.push(store.record(inverseBatch(changes)));
      },
    };
    assert.equal(updateComponentProperties({ projectPath: root, file, source, change: renameSave(source) }, recording).ok, true);
    assert.equal(tokens.length, 1, 'One undo step');
    assert.equal(batches[0].filter((change) => change.file === fs.realpathSync(file)).length, 1, 'The component is written once');
    const after = { component: read(), page: readPage() };
    assert.match(after.component, /\{ perks = \[\] \}/);
    assert.notEqual(after.page, PAGE);

    const undone = revertComponentProperties(tokens[0], store, writer);
    assert.equal(undone.ok, true);
    assert.equal(read(), source, 'The variable is back in the component');
    assert.equal(readPage(), PAGE, 'And the attributes on the page');

    assert.equal(revertComponentProperties(undone.value.undo, store, writer).ok, true);
    assert.equal(read(), after.component);
    assert.equal(readPage(), after.page);
  });
});

test('line endings, a byte-order mark and wide characters keep their places', () => {
  const source = component(`${PROPS}\nconst { features } = Astro.props;`, '<p>😀 é {features.length}</p>').replace(/\n/g, '\r\n');
  assert.equal(
    renamed(`\uFEFF${source}`),
    `\uFEFF${component('interface Props {\n  perks?: string[];\n}\nconst { perks } = Astro.props;', '<p>😀 é {perks.length}</p>').replace(/\n/g, '\r\n')}`,
  );
});
