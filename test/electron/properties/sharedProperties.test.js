// Goal: a layout whose Props is `SeoProps & { theme?: … }` edits every prop it
// shows. Its own literal-union props (`theme`) are fully editable, and the
// members it takes from SeoProps in src/types.ts are listed with their tooltips
// and edited where they are declared, renames reaching every user and instance.
// Method: a small Astro project in a temporary folder (tsconfig `@/` alias, a
// shared types file, a layout and a head component using it, pages placing the
// layout), edited through updateComponentProperties with a recording writer so
// each edit is checked to be one batch, byte-stable outside its spans, and
// undone in one step. The negative space: an imported member type stays
// read-only, a computed read of the rest variable refuses only the rename, and
// a default on a component that forwards the prop in a rest is refused.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readComponentProperties } = require('#dist/electron/properties/propertyDefinitions.js');
const {
  inverseBatch,
  loadComponentProperties,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
} = require('#dist/electron/properties/componentProperties.js');
const { parseComponentProperties } = require('#dist/shared/properties/propertyEditing.js');
const { documentHost } = require('#dist/electron/documents/documentWrites.js');

const types = `/** Page metadata. */
export interface SeoProps {
  /** Page title. The site name is appended. */
  title?: string;
  /** Open Graph type. */
  type?: "website" | "article";
}
`;
const layout = `---
import type { SeoProps } from "@/types.ts";
import BaseHead from "@/components/BaseHead.astro";

type Props = SeoProps & {
  /** Theme for the whole page. */
  theme?: "inherit" | "light" | "dark" | "brand";
  overlap?: boolean;
};

const { theme = "inherit", overlap = false, ...seo } = Astro.props;
---
<html class={theme}><head><BaseHead {...seo} /></head><body data-overlap={overlap}><slot /></body></html>
`;
const head = `---
import type { SeoProps } from "@/types.ts";
type Props = SeoProps;
const { title, type = "website" } = Astro.props;
---
<title>{title}</title><meta property="og:type" content={type} />
`;
const page = `---
import BaseLayout from "@/layouts/BaseLayout.astro";
---
<BaseLayout title="Home" theme="dark"><p>title</p></BaseLayout>
`;

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function project(run, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-shared-')));
  const contents = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'src/types.ts': types,
    'src/layouts/BaseLayout.astro': layout,
    'src/components/BaseHead.astro': head,
    'src/pages/index.astro': page,
    ...files,
  };
  for (const [relative, text] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  try {
    run({ root, file: path.join(root, 'src/layouts/BaseLayout.astro'), headFile: path.join(root, 'src/components/BaseHead.astro'), read });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// One edit as the panel sends it, recording the batches it commits and the
// files each one changed (the edited component is always in the batch, as its
// revision witness, even when its bytes stay).
function edit(root, file, change) {
  const batches = [];
  const store = new PropertyUndoStore();
  const writer = {
    documents: documentHost().documents,
    noteWrite: () => {},
    onCommitted: (changes) =>
      batches.push({
        files: changes
          .filter((entry) => entry.before !== entry.after)
          .map((entry) => path.relative(root, entry.file).split(path.sep).join('/'))
          .sort(),
        token: store.record(inverseBatch(changes)),
      }),
  };
  const source = fs.readFileSync(file, 'utf8');
  const result = updateComponentProperties({ projectPath: root, file, source, change }, writer);
  return { result, batches, store, writer };
}

function propertyOf(root, file, name) {
  const property = value(loadComponentProperties({ projectPath: root, file })).properties.find((entry) => entry.name === name);
  assert.ok(property, `${name} is listed`);
  return property;
}

test('regression: an intersection with an imported type keeps the inline literal union editable', () => {
  // `SeoProps & {…}` used to make the whole contract incomplete, so `theme` read
  // "depends on a shared or computed type" and every field was read-only.
  const data = readComponentProperties(layout);
  const theme = data.properties.find((property) => property.name === 'theme');
  assert.deepEqual(theme.editing, { kind: 'editable' });
  assert.equal(theme.type, '"inherit" | "light" | "dark" | "brand"');
  assert.equal(theme.defaultValue, '"inherit"');
  assert.equal(theme.description, 'Theme for the whole page.');
});

test('the inline union is reordered, defaulted, extended, trimmed and renamed, one batch each, bytes kept elsewhere', () => {
  project(({ root, file, read }) => {
    const edits = [
      { type: '"light" | "inherit" | "dark" | "brand"', expect: /theme\?: "light" \| "inherit" \| "dark" \| "brand";/ },
      { defaultValue: '"dark"', expect: /theme = "dark"/ },
      { type: '"inherit" | "light" | "dark" | "brand" | "night"', expect: /\| "brand" \| "night";/ },
      { type: '"inherit" | "light" | "dark"', expect: /theme\?: "inherit" \| "light" \| "dark";\n/ },
    ];
    for (const { expect, ...fields } of edits) {
      const before = read('src/layouts/BaseLayout.astro');
      const theme = propertyOf(root, file, 'theme');
      const { result, batches } = edit(root, file, { kind: 'save', originalName: 'theme', property: { ...theme, ...fields } });
      value(result);
      assert.equal(batches.length, 1, 'one undo step');
      assert.deepEqual(batches[0].files, ['src/layouts/BaseLayout.astro']);
      const after = read('src/layouts/BaseLayout.astro');
      assert.match(after, expect);
      // Only the edited line differs.
      const changed = after.split('\n').filter((line, index) => line !== before.split('\n')[index]);
      assert.equal(changed.length, 1, JSON.stringify(changed));
      assert.equal(read('src/types.ts'), types);
    }
    const theme = propertyOf(root, file, 'theme');
    const { result, batches } = edit(root, file, { kind: 'save', originalName: 'theme', property: { ...theme, name: 'mode' } });
    value(result);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].files, ['src/layouts/BaseLayout.astro', 'src/pages/index.astro']);
    const after = read('src/layouts/BaseLayout.astro');
    assert.match(after, /mode\?: "inherit"/);
    assert.match(after, /const \{ mode = "dark", overlap = false, \.\.\.seo \}/);
    assert.match(after, /class=\{mode\}/);
    assert.match(read('src/pages/index.astro'), /<BaseLayout title="Home" mode="dark">/);
  });
});

test('a same-file alias keeps its options in the alias, and a shared alias warns', () => {
  const single = `---
type Theme = "light" | "dark";
type Props = { theme?: Theme; label?: string };
const { theme } = Astro.props;
---
`;
  const theme = readComponentProperties(single).properties.find((property) => property.name === 'theme');
  assert.equal(theme.type, '"light" | "dark"');
  assert.deepEqual(theme.editing, { kind: 'editable' });
  project(
    ({ root, read }) => {
      const file = path.join(root, 'src/components/Alias.astro');
      value(edit(root, file, { kind: 'save', originalName: 'theme', property: { ...theme, type: '"dark" | "light"' } }).result);
      const after = read('src/components/Alias.astro');
      assert.match(after, /type Theme = "dark" \| "light";/);
      assert.match(after, /theme\?: Theme;/, 'the member keeps its alias');
    },
    { 'src/components/Alias.astro': single },
  );
  const shared = single.replace('label?: string', 'accent?: Theme');
  const sharedTheme = readComponentProperties(shared).properties.find((property) => property.name === 'theme');
  assert.equal(sharedTheme.editing.kind, 'editable');
  assert.match(sharedTheme.editing.warning, /Theme is used 2 times in this file/);
});

test('an imported member type stays read-only with its note', () => {
  const source = `---
import type { Theme } from "./theme";
type Props = { label?: string } & { theme?: Theme };
const { theme, label } = Astro.props;
---
`;
  const data = readComponentProperties(source);
  const theme = data.properties.find((property) => property.name === 'theme');
  assert.deepEqual(theme.editing, {
    kind: 'restricted',
    reason: 'This prop depends on a shared or computed type that must be edited in source.',
    reasonRef: { key: 'props.contract.computedType' },
  });
  assert.equal(data.properties.find((property) => property.name === 'label').editing.kind, 'editable');
});

test('imported fields are listed with their JSDoc, where they are declared and who uses them', () => {
  project(({ root, file }) => {
    const data = value(loadComponentProperties({ projectPath: root, file }));
    assert.deepEqual(
      data.properties.map((property) => property.name),
      ['theme', 'overlap', 'title', 'type'],
    );
    const title = data.properties.find((property) => property.name === 'title');
    assert.equal(title.description, 'Page title. The site name is appended.');
    assert.deepEqual(title.editing, { kind: 'editable' });
    assert.deepEqual(title.shared, {
      typeName: 'SeoProps',
      path: 'src/types.ts',
      users: ['src/components/BaseHead.astro', 'src/layouts/BaseLayout.astro'].filter((user) => title.shared.users.includes(user)),
      instances: ['src/layouts/BaseLayout.astro', 'src/pages/index.astro'],
      defaults: [],
    });
    assert.equal(title.shared.users.length, 2);
    const type = data.properties.find((property) => property.name === 'type');
    assert.equal(type.type, '"website" | "article"');
    assert.deepEqual(type.shared.defaults, [{ path: 'src/components/BaseHead.astro', expression: '"website"' }]);
    // The share survives the IPC boundary.
    assert.deepEqual(parseComponentProperties(data), data);
  });
});

test('an edit to a shared field writes src/types.ts, one batch, nothing else', () => {
  project(({ root, file, read }) => {
    const title = propertyOf(root, file, 'title');
    const { result, batches } = edit(root, file, {
      kind: 'save',
      originalName: 'title',
      property: { ...title, description: 'The page name.', required: true },
    });
    const updated = value(result);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].files, ['src/types.ts']);
    assert.equal(
      read('src/types.ts'),
      types.replace('/** Page title. The site name is appended. */\n  title?: string;', '/** The page name. */\n  title: string;'),
    );
    assert.equal(read('src/layouts/BaseLayout.astro'), layout);
    assert.equal(updated.properties.find((property) => property.name === 'title').description, 'The page name.');
    const type = propertyOf(root, file, 'type');
    value(edit(root, file, { kind: 'save', originalName: 'type', property: { ...type, type: '"article" | "website"' } }).result);
    assert.match(read('src/types.ts'), /type\?: "article" \| "website";/);
  });
});

test('a shared rename rewrites the type, every user and every instance as one undo step', () => {
  project(({ root, file, read }) => {
    const before = {
      types: read('src/types.ts'),
      layout: read('src/layouts/BaseLayout.astro'),
      head: read('src/components/BaseHead.astro'),
      page: read('src/pages/index.astro'),
    };
    const title = propertyOf(root, file, 'title');
    const { result, batches, store, writer } = edit(root, file, { kind: 'save', originalName: 'title', property: { ...title, name: 'heading' } });
    value(result);
    assert.equal(batches.length, 1, 'one batch');
    assert.deepEqual(batches[0].files, ['src/components/BaseHead.astro', 'src/pages/index.astro', 'src/types.ts']);
    // The preview the form shows lists every file the batch wrote.
    const preview = new Set([title.shared.path, ...title.shared.users, ...title.shared.instances]);
    for (const written of batches[0].files) {
      assert.ok(preview.has(written), `${written} was in the preview`);
    }
    assert.match(read('src/types.ts'), /heading\?: string;/);
    assert.match(read('src/components/BaseHead.astro'), /const \{ heading, type = "website" \}/);
    assert.match(read('src/components/BaseHead.astro'), /<title>\{heading\}<\/title>/);
    assert.match(read('src/pages/index.astro'), /<BaseLayout heading="Home" theme="dark"><p>title<\/p>/);
    assert.equal(read('src/layouts/BaseLayout.astro'), before.layout, 'the forwarding spread renames itself');
    value(revertComponentProperties(batches[0].token, store, writer));
    assert.deepEqual(
      {
        types: read('src/types.ts'),
        layout: read('src/layouts/BaseLayout.astro'),
        head: read('src/components/BaseHead.astro'),
        page: read('src/pages/index.astro'),
      },
      before,
    );
  });
});

test('a rename that cannot be followed is refused alone; other edits still apply', () => {
  const computed = layout.replace('<slot />', '<slot />{seo[Astro.url.pathname]}');
  project(
    ({ root, file, read }) => {
      const title = propertyOf(root, file, 'title');
      const refused = edit(root, file, { kind: 'save', originalName: 'title', property: { ...title, name: 'heading' } }).result;
      assert.equal(refused.ok, false);
      assert.match(refused.error.message, /src\/layouts\/BaseLayout\.astro: seo is read with a computed key/);
      assert.equal(read('src/types.ts'), types, 'nothing written');
      value(edit(root, file, { kind: 'save', originalName: 'title', property: { ...title, description: 'Still editable.' } }).result);
      assert.match(read('src/types.ts'), /Still editable/);
    },
    { 'src/layouts/BaseLayout.astro': computed },
  );
});

test('a shared default is the destructuring component’s own', () => {
  project(({ root, file, headFile, read }) => {
    const title = propertyOf(root, file, 'type');
    const refused = edit(root, file, { kind: 'save', originalName: 'type', property: { ...title, defaultValue: '"article"' } }).result;
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'default');
    assert.match(refused.error.message, /src\/components\/BaseHead\.astro \("website"\)/);
    const headType = propertyOf(root, headFile, 'type');
    assert.equal(headType.defaultValue, '"website"');
    const { batches } = edit(root, headFile, { kind: 'save', originalName: 'type', property: { ...headType, defaultValue: '"article"' } });
    assert.deepEqual(batches[0].files, ['src/components/BaseHead.astro']);
    assert.match(read('src/components/BaseHead.astro'), /type = "article"/);
    assert.equal(read('src/types.ts'), types);
  });
});

test('deleting a shared field is refused with where to do it', () => {
  project(({ root, file }) => {
    const refused = edit(root, file, { kind: 'remove', name: 'title' }).result;
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /declared in SeoProps \(src\/types\.ts\)/);
  });
});
