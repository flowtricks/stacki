// Goal: component contracts remain valid and renames update only their own usages.
// Method: edit real Astro source and temporary project files, then exercise malformed
// input, source conflicts, ambiguous spreads, unicode positions, and failed writes.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');
const { renameComponentOptionValues, renameComponentReferences } = require('#dist/electron/properties/propertyRename.js');
const {
  inverseBatch,
  loadComponentProperties,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
} = require('#dist/electron/properties/componentProperties.js');
const { applySourceEdits } = require('#dist/electron/properties/propertySyntax.js');
const { documentHost } = require('#dist/electron/documents/documentWrites.js');

// Every batch write goes through the document actors (plan §3.3, step 5).
const writer = { documents: documentHost().documents, noteWrite: () => {} };

// Fail the `failAt`-th replace of a batch at its rename — the moment a save
// either lands or does not — calling `before(targets)` first with the targets
// replaced so far. Only the write protocol's own temporary files count.
function failNthReplace(failAt, message, run, before = () => {}) {
  const rename = fs.renameSync;
  const targets = [];
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (path.basename(from).startsWith('.stacki-write-')) {
      attempts += 1;
      if (attempts === failAt) {
        before(targets);
        throw new Error(message);
      }
      rename(from, to);
      targets.push(to);
      return undefined;
    }
    return rename(from, to);
  };
  try {
    run(targets);
  } finally {
    fs.renameSync = rename;
  }
}
const { parseComponentProperties, parsePropertyChange, parsePropertiesResult, PROPERTY_LIMITS } = require('#dist/shared/properties/propertyEditing.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

const source = `---
import type { ImageMetadata } from 'astro';
interface Props {
  /** Title shown above the card. */
  title?: string;
  readonly variant: 'solid' | 'outline';
  image?: ImageMetadata;
}
const { title = 'Hello', variant = 'solid', ...rest } = Astro.props;
---
<h1>{title} {Astro.props.title}</h1>
<slot />
<style>h1 { color: red; }</style>`;
const property = {
  name: 'title',
  type: 'string',
  required: false,
  readonly: false,
  defaultValue: '"New title"',
  description: 'New description',
};
const save = (overrides = {}) => ({
  kind: 'save',
  originalName: 'title',
  property: { ...property, ...overrides },
});
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function project(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-properties-'));
  const component = path.join(root, 'src/components/Card.astro');
  const page = path.join(root, 'src/pages/index.astro');
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(component, source);
  fs.writeFileSync(
    page,
    `---\nimport Alias from '../components/Card.astro';\n` +
      `import Other from '../components/Other.astro';\nconst title = 'page';\n---\n` +
      `<Alias title={title}/><Other title="untouched"/><p>title</p>`,
  );
  try {
    run({ root, component, page });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}

test('reads exact types, docs, defaults, readonly and required flags', () => {
  const data = readComponentProperties(source);
  assert.equal(data.advanced, false);
  assert.deepEqual(
    data.properties.map((field) => field.name),
    ['title', 'variant', 'image'],
  );
  assert.equal(data.properties[0].description, 'Title shown above the card.');
  assert.equal(data.properties[0].defaultValue, "'Hello'");
  assert.equal(data.properties[1].readonly, true);
  assert.equal(data.properties[1].required, true);
  assert.equal(data.properties[2].type, 'ImageMetadata');
});

test('edits defaults and flags without losing imports, rest props, slots or styles', () => {
  const output = value(editPropertyDefinition(source, save({ required: true, readonly: true })));
  assert.match(output, /readonly title: string/);
  assert.match(output, /title = "New title"/);
  assert.match(output, /\.\.\.rest/);
  assert.match(output, /import type/);
  assert.equal(output.slice(output.indexOf('<slot')), source.slice(source.indexOf('<slot')));
  assert.match(output, /const _stackiDefault0 = title/);
  assert.match(output, /<h1>\{title\} \{_stackiDefault0\}/);
  assert.equal(readComponentProperties(output).properties[0].description, 'New description');
});

test('adds fields to components with and without a Props type or frontmatter', () => {
  for (const original of [
    '<slot />',
    '---\nconst { title = "Hello" } = Astro.props;\n---\n<h1>{title}</h1>',
    '---\ntype Props = { title: string };\n---\n<h1/>',
  ]) {
    const output = value(
      editPropertyDefinition(original, {
        kind: 'save',
        originalName: '',
        property: {
          ...property,
          name: 'count',
          type: 'number',
          defaultValue: '3',
        },
      }),
    );
    const fields = readComponentProperties(output).properties;
    assert.equal(fields.find((field) => field.name === 'count').defaultValue, '3');
    assert.match(output, /count\?: number/);
    if (original.includes('title')) {
      assert(fields.some((field) => field.name === 'title'));
    }
  }
});

test('reorders fields and literal options while preserving their docs and defaults', () => {
  const output = value(
    editPropertyDefinition(source, {
      kind: 'order',
      names: ['image', 'variant', 'title'],
    }),
  );
  assert.deepEqual(
    readComponentProperties(output).properties.map((field) => field.name),
    ['image', 'variant', 'title'],
  );
  assert.match(output, /Title shown above the card/);
  const reordered = value(
    editPropertyDefinition(source, {
      kind: 'options',
      name: 'variant',
      type: "'outline' | 'solid'",
    }),
  );
  assert.match(reordered, /readonly variant: 'outline' \| 'solid'/);
  assert.match(reordered, /variant = 'solid'/);
  assert.equal(editPropertyDefinition(source, { kind: 'order', names: ['title', 'title'] }).ok, false);
});

test('invalid syntax, duplicate fields and complex contracts refuse destructive edits', () => {
  for (const change of [save({ name: 'variant' }), save({ type: 'string; const x = 1' }), save({ type: '{broken' }), save({ defaultValue: '{broken' })]) {
    assert.equal(editPropertyDefinition(source, change).ok, false);
  }
  for (const type of [
    'type Props = { kind: "a" } | { kind: "b" };',
    'interface Props<Value> extends Base { title: Value }',
    'import type { Props } from "./types";',
  ]) {
    const complex = `---\n${type}\n---\n<slot/>`;
    assert.equal(readComponentProperties(complex).advanced, true);
    assert.equal(editPropertyDefinition(complex, save()).ok, false);
  }
  assert.equal(editPropertyDefinition(source, { kind: 'source', frontmatter: 'const = ' }).ok, false);
  const output = value(
    editPropertyDefinition(source, {
      kind: 'source',
      frontmatter: 'type Props = { value: string } | { value: number };',
    }),
  );
  assert.match(output, /value: number/);
  assert.match(output, /<slot \/>/);
});

test('rename keeps lexical aliases, and updates direct and computed Astro.props references', () => {
  const output = value(editPropertyDefinition(source, save({ name: 'heading', defaultValue: '' })));
  const renamed = value(renameComponentReferences(output, new Set(), { from: 'title', to: 'heading' }, 'definition'));
  assert.match(renamed, /heading: title/);
  assert.match(renamed, /\{title\} \{Astro.props.heading\}/);
  const computed = value(renameComponentReferences('<p>{Astro.props["title"]}</p>', new Set(), { from: 'title', to: 'heading' }, 'definition'));
  assert.match(computed, /Astro.props\["heading"\]/);
});

test('rename handles expressions, shorthand, literal spreads, comments and UTF-8', () => {
  const original = `<!-- <Card title="keep"/> -->😀 é <Card {title} />` + `<Card {...{title: 'x', nested: { title: 3 }}} /><Other title="keep"/>`;
  const output = value(renameComponentReferences(original, new Set(['Card']), { from: 'title', to: 'heading' }, 'consumer'));
  assert.match(output, /<!-- <Card title="keep"\/> -->/);
  assert.match(output, /😀 é <Card heading=\{title\}/);
  assert.match(output, /heading: 'x', nested: \{ title: 3 \}/);
  assert.match(output, /<Other title="keep"/);
  for (const invalid of ['<Card {...data}/>', '<Card title="a" heading="b"/>']) {
    assert.equal(renameComponentReferences(invalid, new Set(['Card']), { from: 'title', to: 'heading' }, 'consumer').ok, false);
  }
  assert.equal(renameComponentReferences('<p>{Astro.props[key]}</p>', new Set(), { from: 'title', to: 'heading' }, 'definition').ok, false);
});

test('option rename updates static values on only the resolved component prop', () => {
  const original =
    '<!-- <Card variant="solid"/> -->😀 ' +
    '<Card variant="solid" other="solid" />' +
    '<Card variant={ready ? "solid" : "outline"} />' +
    '<Card {...{variant: `solid`, other: "solid"}} />' +
    '<Other variant="solid" />';
  const output = value(renameComponentOptionValues(original, new Set(['Card']), 'variant', [{ from: "'solid'", to: "'filled'" }]));
  assert.match(output, /<!-- <Card variant="solid"\/> -->/);
  assert.match(output, /😀 <Card variant="filled" other="solid"/);
  assert.match(output, /ready \? 'filled' : "outline"/);
  assert.match(output, /variant: 'filled', other: "solid"/);
  assert.match(output, /<Other variant="solid"/);
  assert.equal(renameComponentOptionValues('<Card {...props} />', new Set(['Card']), 'variant', [{ from: "'solid'", to: "'filled'" }]).ok, false);
});

test('project-wide rename follows import aliases and does not touch unrelated components', () => {
  project(({ root, component, page }) => {
    const result = updateComponentProperties(
      {
        projectPath: root,
        file: component,
        source,
        change: save({ name: 'heading' }),
      },
      writer,
    );
    assert.equal(value(result).properties[0].name, 'heading');
    const content = fs.readFileSync(page, 'utf8');
    assert.match(content, /<Alias heading=\{title\}/);
    assert.match(content, /<Other title="untouched"/);
    assert.match(content, /<p>title<\/p>/);
  });
});

test('project-wide option rename updates every static instance value and the default', () => {
  project(({ root, component, page }) => {
    fs.writeFileSync(
      page,
      `---\nimport Alias from '../components/Card.astro';\n` +
        `import Other from '../components/Other.astro';\nconst ready = true;\n---\n` +
        `<Alias variant="solid"/><Alias variant={ready ? 'solid' : 'outline'}/>` +
        `<Other variant="solid"/>`,
    );
    const variant = readComponentProperties(source).properties.find((field) => field.name === 'variant');
    const result = updateComponentProperties(
      {
        projectPath: root,
        file: component,
        source,
        change: {
          kind: 'save',
          originalName: 'variant',
          property: {
            ...variant,
            type: "'filled' | 'outline'",
            defaultValue: "'filled'",
          },
          optionRenames: [{ from: "'solid'", to: "'filled'" }],
        },
      },
      writer,
    );
    assert.equal(value(result).properties.find((field) => field.name === 'variant').type, "'filled' | 'outline'");
    assert.match(fs.readFileSync(component, 'utf8'), /variant = 'filled'/);
    const content = fs.readFileSync(page, 'utf8');
    assert.match(content, /<Alias variant="filled"/);
    assert.match(content, /ready \? 'filled' : 'outline'/);
    assert.match(content, /<Other variant="solid"/);
  });
});

test('failed option rename writes restore the component and its instances', () => {
  project(({ root, component, page }) => {
    const beforePage = `---\nimport Alias from '../components/Card.astro';\n---\n` + `<Alias variant="solid"/>`;
    fs.writeFileSync(page, beforePage);
    const variant = readComponentProperties(source).properties.find((field) => field.name === 'variant');
    failNthReplace(2, 'Simulated option write failure', () => {
      const result = updateComponentProperties(
        {
          projectPath: root,
          file: component,
          source,
          change: {
            kind: 'save',
            originalName: 'variant',
            property: {
              ...variant,
              type: "'filled' | 'outline'",
              defaultValue: "'filled'",
            },
            optionRenames: [{ from: "'solid'", to: "'filled'" }],
          },
        },
        writer,
      );
      assert.equal(result.ok, false);
      assert.match(result.error.message, /restored/);
      assert.equal(fs.readFileSync(component, 'utf8'), source);
      assert.equal(fs.readFileSync(page, 'utf8'), beforePage);
    });
  });
});

test('source conflicts and unresolved spreads leave every project file untouched', () => {
  project(({ root, component, page }) => {
    const before = fs.readFileSync(page, 'utf8');
    const request = {
      projectPath: root,
      file: component,
      source,
      change: save({ name: 'heading' }),
    };
    assert.equal(updateComponentProperties({ ...request, source: source + '\n' }, writer).ok, false);
    fs.writeFileSync(page, before + '<Alias {...props}/>');
    assert.equal(updateComponentProperties(request, writer).ok, false);
    assert.equal(fs.readFileSync(component, 'utf8'), source);
    assert.equal(fs.readFileSync(page, 'utf8'), before + '<Alias {...props}/>');
  });
});

test('failed writes restore all files already written', () => {
  project(({ root, component, page }) => {
    const before = fs.readFileSync(page, 'utf8');
    failNthReplace(2, 'Simulated disk failure', () => {
      const result = updateComponentProperties(
        {
          projectPath: root,
          file: component,
          source,
          change: save({ name: 'heading' }),
        },
        writer,
      );
      assert.equal(result.ok, false);
      assert.match(result.error.message, /restored/);
      assert.equal(fs.readFileSync(component, 'utf8'), source);
      assert.equal(fs.readFileSync(page, 'utf8'), before);
    });
  });
});

// Plan §3.3: rollback restores a file only while it still holds the bytes the
// batch wrote. The file written first is changed by "another program" in the
// middle of the batch, then the next write fails.
test('rollback leaves a file another program changed and names it', () => {
  project(({ root, component, page }) => {
    const canonicalComponent = fs.realpathSync.native(component);
    const canonicalPage = fs.realpathSync.native(page);
    const before = new Map([
      [canonicalComponent, source],
      [canonicalPage, fs.readFileSync(page, 'utf8')],
    ]);
    const external = (targets) => fs.writeFileSync(targets[0], 'EXTERNAL');
    failNthReplace(
      2,
      'Simulated disk failure',
      (replaced) => {
        const result = updateComponentProperties({ projectPath: root, file: component, source, change: save({ name: 'heading' }) }, writer);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'rollback');
        assert.match(result.error.message, /changed by another program, left as is: /);
        assert.ok(result.error.message.includes(path.basename(replaced[0])), result.error.message);
        assert.equal(fs.readFileSync(replaced[0], 'utf8'), 'EXTERNAL');
        const untouched = replaced[0] === canonicalComponent ? canonicalPage : canonicalComponent;
        assert.equal(fs.readFileSync(untouched, 'utf8'), before.get(untouched));
      },
      external,
    );
  });
});

test('a read-back mismatch is a write-race that rolls back instead of asserting', () => {
  project(({ root, component, page }) => {
    const canonicalComponent = fs.realpathSync.native(component);
    const canonicalPage = fs.realpathSync.native(page);
    const before = new Map([
      [canonicalComponent, source],
      [canonicalPage, fs.readFileSync(page, 'utf8')],
    ]);
    const rename = fs.renameSync;
    const replaced = [];
    fs.renameSync = (from, to) => {
      rename(from, to);
      replaced.push(to);
      if (replaced.length === 2) {
        fs.writeFileSync(to, 'RACER'); // another writer lands right after ours
      }
    };
    try {
      const result = updateComponentProperties({ projectPath: root, file: component, source, change: save({ name: 'heading' }) }, writer);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'write-race');
      assert.match(result.error.message, /changes restored/);
      assert.equal(fs.readFileSync(replaced[0], 'utf8'), before.get(replaced[0]));
      // The other writer keeps its bytes.
      assert.equal(fs.readFileSync(replaced[1], 'utf8'), 'RACER');
    } finally {
      fs.renameSync = rename;
    }
  });
});

test('composite props trace their own declarations and literal defaults', () => {
  const composite = `---
type Unrelated = { element: number };
type Tag = { /** Render tag. */ element?: "button" } | { element: "link" };
type Props = { render?: boolean } & Tag;
type AllProps = { element?: "button" | "link"; extra?: string };
const { element = "button", render = true, extra } = Astro.props as AllProps;
---
<div />`;
  const data = readComponentProperties(composite);
  assert.equal(data.advanced, true);
  const element = data.properties.find((field) => field.name === 'element');
  assert.equal(element.type, '"button" | "link"');
  assert.equal(element.defaultValue, '"button"');
  assert.deepEqual(element.origin.declarations, [
    { label: 'Tag.element', expression: '"button"', line: 3 },
    { label: 'Tag.element', expression: '"link"', line: 3 },
  ]);
  assert.deepEqual(element.origin.defaultValue, {
    label: 'Astro.props.element',
    expression: '"button"',
    line: 6,
  });
  assert.equal(data.properties.find((field) => field.name === 'extra').origin.declarations[0].label, 'AllProps.extra');
  assert.deepEqual(parseComponentProperties(data), data);
});

test('source tracing terminates cycles and avoids inventing generic or imported sources', () => {
  for (const declaration of [
    'type Props = Props & { title?: string };',
    'type Base = { title?: number }; type Props = Omit<Base, "title">;',
    'import type { Props } from "./shared";',
  ]) {
    const data = readComponentProperties(`---\n${declaration}\n` + 'const { title = "Hello" } = Astro.props;\n---\n<div />');
    const title = data.properties.find((field) => field.name === 'title');
    assert.equal(title.origin.declarations.length, declaration.startsWith('type Props') ? 1 : 0);
    assert.equal(title.origin.defaultValue.expression, '"Hello"');
  }
});

test('source metadata rejects malformed and oversized inputs at the contract boundary', () => {
  const data = readComponentProperties(source);
  const origin = data.properties[0].origin;
  for (const invalid of [
    jsonNull,
    {},
    { declarations: {} },
    {
      declarations: Array(PROPERTY_LIMITS.fieldsMax + 1).fill(origin.declarations[0]),
    },
    ...[0, -1, 1.5, '2', PROPERTY_LIMITS.sourceCharsMax + 1].map((line) => ({
      declarations: [{ label: 'Props.title', expression: 'string', line }],
    })),
    { declarations: [{ label: '', expression: 'string', line: 1 }] },
    { declarations: [{ label: 'Props.title', expression: false, line: 1 }] },
    { declarations: [], defaultValue: { label: 'Astro.props.title', line: 1 } },
  ]) {
    assert.throws(() =>
      parseComponentProperties({
        ...data,
        properties: [{ ...data.properties[0], origin: invalid }],
      }),
    );
  }
});

const compositeCard = `---
import type { HTMLAttributes } from 'astro/types';
type Theme = "inherit" | "light" | "dark";
type Base = HTMLAttributes<"div"> & {
  /** Small text above the heading. */
  eyebrow?: string;
  theme?: Theme;
  variant?: "default" | "cover" | "stacked";
  unused?: string;
};
type Props = Base & (
  | { variant?: "default"; image?: never }
  | { variant: "cover"; image?: string }
  | { variant: "stacked"; image?: string; theme?: never }
);
type AllProps = Base & { image?: string };
type Caption = Base["eyebrow"];
type RuntimeCaption = AllProps["eyebrow"];
type Selected = Pick<Base, "eyebrow">;
type Other = { eyebrow: number };
type OtherCaption = Other["eyebrow"];
const { eyebrow, theme = "inherit", variant = "default", image, ...rest } = Astro.props as AllProps;
---
<div>{eyebrow} {Astro.props.eyebrow}</div>`;

test('common props remain editable while variant restrictions stay specific to each prop', () => {
  const data = readComponentProperties(compositeCard);
  assert.equal(data.advanced, true);
  const eyebrow = data.properties.find((field) => field.name === 'eyebrow');
  assert.deepEqual(eyebrow.editing, { kind: 'editable' });
  assert.equal(eyebrow.description, 'Small text above the heading.');
  assert.deepEqual(eyebrow.conditions, []);
  const image = data.properties.find((field) => field.name === 'image');
  assert.equal(image.editing.kind, 'restricted');
  assert.deepEqual(image.conditions, ['variant = "default": not allowed', 'variant = "cover": optional', 'variant = "stacked": optional']);
  const theme = data.properties.find((field) => field.name === 'theme');
  assert.equal(theme.editing.kind, 'restricted');
  assert.equal(theme.conditions.at(-1), 'variant = "stacked": not allowed');
  assert.equal(
    editPropertyDefinition(compositeCard, {
      kind: 'save',
      originalName: 'image',
      property: { ...image, editing: { kind: 'editable' } },
    }).ok,
    false,
  );
  assert.deepEqual(parseComponentProperties(data), data);
});

test('common declaration edits preserve variants, runtime assertions and unrelated types', () => {
  const eyebrow = readComponentProperties(compositeCard).properties.find((property) => property.name === 'eyebrow');
  const changed = value(
    editPropertyDefinition(compositeCard, {
      kind: 'save',
      originalName: 'eyebrow',
      property: {
        ...eyebrow,
        type: '"Small" | "Large"',
        defaultValue: '"Small"',
        required: true,
        readonly: true,
        description: 'New tooltip',
      },
    }),
  );
  assert.match(changed, /readonly eyebrow: "Small" \| "Large"/);
  assert.match(changed, /eyebrow = "Small"/);
  assert.match(changed, /New tooltip/);
  const variants = (text) => text.slice(text.indexOf('type Props'), text.indexOf('type AllProps'));
  assert.equal(variants(changed), variants(compositeCard));
  assert.match(changed, /Astro.props as AllProps/);
  assert.match(changed, /type Other = \{ eyebrow: number \}/);
  const reread = readComponentProperties(changed).properties.find((property) => property.name === 'eyebrow');
  assert.equal(reread.required, true);
  assert.equal(reread.readonly, true);
  assert.equal(reread.description, 'New tooltip');
  assert.equal(reread.editing.kind, 'editable');
  const removed = value(editPropertyDefinition(compositeCard, { kind: 'remove', name: 'unused' }));
  assert.doesNotMatch(removed, /unused\?:/);
  assert.equal(variants(removed), variants(compositeCard));
});

test('renaming a common prop updates its instances, ' + 'runtime binding and related type references', () => {
  project(({ root, component, page }) => {
    fs.writeFileSync(component, compositeCard);
    fs.writeFileSync(page, '---\nimport Card from "../components/Card.astro";\n---\n' + '<Card eyebrow="Hello"/><Card eyebrow="Again"/>');
    const eyebrow = readComponentProperties(compositeCard).properties.find((property) => property.name === 'eyebrow');
    const updated = value(
      updateComponentProperties(
        {
          projectPath: root,
          file: component,
          source: compositeCard,
          change: {
            kind: 'save',
            originalName: 'eyebrow',
            property: { ...eyebrow, name: 'kicker' },
          },
        },
        writer,
      ),
    );
    assert.equal(updated.properties.find((property) => property.name === 'kicker').editing.kind, 'editable');
    const after = fs.readFileSync(component, 'utf8');
    assert.match(after, /kicker: eyebrow/);
    assert.match(after, /Astro.props.kicker/);
    assert.match(after, /Base\["kicker"\]/);
    assert.match(after, /AllProps\["kicker"\]/);
    assert.match(after, /Pick<Base, "kicker">/);
    assert.match(after, /Other\["eyebrow"\]/);
    assert.match(after, /\{eyebrow\}/);
    assert.equal(fs.readFileSync(page, 'utf8').match(/kicker=/g).length, 2);
  });
});

test('ambiguous common declarations remain restricted without flattening their contracts', () => {
  for (const declaration of [
    'type Props = { eyebrow?: string } & { eyebrow?: "narrow" };',
    'type Props = Base; type Base = Props & { eyebrow?: string };',
    'type Base<T> = { eyebrow?: T }; type Props = Base<string>;',
    'export type Base = { eyebrow?: string }; type Props = Base;',
    'import type { Shared } from "./shared"; type Props = Shared & { eyebrow?: string };',
    'import type { HTMLAttributes } from "./shared"; ' + 'type Props = HTMLAttributes & { eyebrow?: string };',
    'import type { Omit } from "./shared"; ' +
      'import type { HTMLAttributes } from "astro/types"; ' +
      'type Props = Omit<HTMLAttributes<"div">, "eyebrow"> & { eyebrow?: string };',
    'type Props = { eyebrow?: string }; type AllProps = { eyebrow?: string };',
  ]) {
    const assertion = declaration.includes('type AllProps') ? ' as AllProps' : '';
    const source = `---\n${declaration}\nconst { eyebrow } = Astro.props${assertion};\n---\n`;
    const eyebrow = readComponentProperties(source).properties.find((property) => property.name === 'eyebrow');
    assert.equal(eyebrow.editing.kind, 'restricted', declaration);
    assert.equal(
      editPropertyDefinition(source, {
        kind: 'save',
        originalName: 'eyebrow',
        property: { ...eyebrow, description: 'Changed' },
      }).ok,
      false,
    );
  }
});

test('common props support aliased Astro attribute imports without changing their aliases', () => {
  const source = compositeCard
    .replace('import type { HTMLAttributes }', 'import type { HTMLAttributes as Attributes }')
    .replace('HTMLAttributes<"div">', 'Attributes<"div">');
  const eyebrow = readComponentProperties(source).properties.find((field) => field.name === 'eyebrow');
  assert.equal(eyebrow.editing.kind, 'editable');
  const output = value(
    editPropertyDefinition(source, {
      kind: 'save',
      originalName: 'eyebrow',
      property: { ...eyebrow, description: 'Changed' },
    }),
  );
  assert.match(output, /type Base = Attributes<"div">/);
  assert.match(output, /Changed/);
});

test('inherited Astro attributes can be declared locally and edited', () => {
  const source = `---
import type { HTMLAttributes } from "astro/types";
type Props = HTMLAttributes<"div"> & {
  render?: boolean;
};
const { render = true, class: className, ...rest } = Astro.props;
---
<div class={className} {...rest} />`;
  const inherited = readComponentProperties(source).properties.find((field) => field.name === 'class');
  assert.equal(inherited.editing.kind, 'override');
  const output = value(
    editPropertyDefinition(source, {
      kind: 'save',
      originalName: 'class',
      property: {
        ...inherited,
        type: 'string',
        required: true,
        readonly: true,
        defaultValue: '"eyebrow"',
        description: 'Classes for the outer element.',
      },
    }),
  );
  assert.match(output, /readonly class: string/);
  assert.match(output, /Classes for the outer element\./);
  assert.match(output, /class: className = "eyebrow"/);
  const reread = readComponentProperties(output).properties.find((field) => field.name === 'class');
  assert.equal(reread.editing.kind, 'editable');
  assert.equal(reread.defaultValue, '"eyebrow"');
  assert.equal(
    editPropertyDefinition(source, {
      kind: 'save',
      originalName: 'class',
      property: { ...inherited, name: 'className' },
    }).ok,
    false,
  );
  assert.equal(editPropertyDefinition(source, { kind: 'remove', name: 'class' }).ok, false);
});

test('props remain editable through omitted Astro attribute inheritance', () => {
  const source = `---
import type { HTMLAttributes } from "astro/types";
type Base = Omit<HTMLAttributes<"img">, "src" | "width"> & {
  /** Original image tooltip. */
  src: ImageMetadata | string;
  width?: number;
};
type Props = Base & (
  | { variant?: "default" }
  | { variant: "cover" }
);
type AllProps = Base & { variant?: "default" | "cover" };
const { src, width, variant = "default", ...rest } = Astro.props as AllProps;
---
<img {src} {width} {...rest} />`;
  const imageSource = readComponentProperties(source).properties.find((field) => field.name === 'src');
  assert.deepEqual(imageSource.editing, { kind: 'editable' });
  const output = value(
    editPropertyDefinition(source, {
      kind: 'save',
      originalName: 'src',
      property: {
        ...imageSource,
        type: 'ImageMetadata | string | URL',
        required: false,
        readonly: true,
        defaultValue: '"/placeholder.png"',
        description: 'Updated image tooltip.',
      },
    }),
  );
  assert.match(output, /readonly src\?: ImageMetadata \| string \| URL/);
  assert.match(output, /src = "\/placeholder\.png"/);
  assert.match(output, /Updated image tooltip\./);
  assert.equal(readComponentProperties(output).properties.find((field) => field.name === 'src').editing.kind, 'editable');
});

test('property permissions and conditions are validated at the boundary', () => {
  const data = readComponentProperties(compositeCard);
  const field = data.properties[0];
  for (const editing of [
    jsonNull,
    {},
    { kind: 'override' },
    { kind: 'override', reason: '' },
    { kind: 'override', reason: false },
    { kind: 'restricted' },
    { kind: 'restricted', reason: '' },
    { kind: 'restricted', reason: false },
    { kind: 'other' },
  ]) {
    assert.throws(() => parseComponentProperties({ ...data, properties: [{ ...field, editing }] }));
  }
  for (const conditions of ['bad', [42], Array(PROPERTY_LIMITS.fieldsMax + 1).fill('rule'), ['x'.repeat(PROPERTY_LIMITS.textCharsMax + 1)]]) {
    assert.throws(() =>
      parseComponentProperties({
        ...data,
        properties: [{ ...field, conditions }],
      }),
    );
  }
});

test('contracts reject malformed payloads and enforce resource bounds', () => {
  assert.deepEqual(parseComponentProperties(readComponentProperties(source)), readComponentProperties(source));
  assert.deepEqual(parsePropertyChange(save()), save());
  assert.deepEqual(
    parsePropertyChange({
      ...save(),
      optionRenames: [{ from: "'solid'", to: "'filled'" }],
    }),
    { ...save(), optionRenames: [{ from: "'solid'", to: "'filled'" }] },
  );
  assert.deepEqual(
    parsePropertyChange({
      kind: 'options',
      name: 'variant',
      type: "'outline' | 'solid'",
    }),
    { kind: 'options', name: 'variant', type: "'outline' | 'solid'" },
  );
  for (const input of [
    jsonNull,
    {},
    { kind: 'save', originalName: 'title', property: {} },
    { kind: 'order', names: [42] },
    { kind: 'options', name: 'bad name', type: 'string' },
    { kind: 'options', name: 'variant', type: 42 },
    { kind: 'remove', name: 'bad name' },
    {
      kind: 'source',
      frontmatter: 'x'.repeat(PROPERTY_LIMITS.sourceCharsMax + 1),
    },
    {
      kind: 'save',
      originalName: '',
      property: { ...property, required: 'yes' },
    },
    {
      kind: 'save',
      originalName: '',
      property: { ...property, type: 'x'.repeat(32769) },
    },
    { ...save(), optionRenames: [{ from: '', to: "'filled'" }] },
    { ...save(), optionRenames: [{ from: "'solid'", to: "'solid'" }] },
    {
      ...save(),
      optionRenames: Array(PROPERTY_LIMITS.fieldsMax + 1).fill({
        from: '1',
        to: '2',
      }),
    },
    {
      kind: 'order',
      names: Array(PROPERTY_LIMITS.fieldsMax + 1).fill('title'),
    },
  ]) {
    assert.throws(() => parsePropertyChange(input));
  }
  assert.throws(() => parsePropertiesResult({ ok: 'yes' }, parseComponentProperties));
  assert.throws(() => applySourceEdits('abc', [{ start: 1, end: 4, text: '' }]), /never overlap/);
  project(({ root }) =>
    assert.equal(
      loadComponentProperties({
        projectPath: root,
        file: path.join(root, 'missing.astro'),
      }).ok,
      false,
    ),
  );
});

test('defaults apply to direct reads without being shadowed by template locals', () => {
  const input = '---\ninterface Props { title?: string }\n---\n' + '<p>{Astro.props.title}</p>{[1].map((title) => <b>{Astro.props.title} {title}</b>)}';
  const output = value(editPropertyDefinition(input, save()));
  assert.match(output, /const \{ title = "New title" \} = Astro.props/);
  assert.match(output, /const _stackiDefault0 = title/);
  assert.match(output, /<b>\{_stackiDefault0\} \{title\}/);
  const { frontmatter } = readComponentProperties(output);
  const ts = require('typescript');
  const script = ts.transpileModule(frontmatter, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const evaluate = new Function('Astro', script + '\nreturn _stackiDefault0;');
  assert.equal(evaluate({ props: {} }), 'New title');
  assert.equal(evaluate({ props: { title: 'Instance' } }), 'Instance');
  assert.equal(evaluate({ props: { title: jsonNull } }), jsonNull);
  const before = '---\ninterface Props { title?: string }\n' + 'const value = Astro.props.title;\n---\n<p>{value}</p>';
  assert.equal(editPropertyDefinition(before, save()).ok, false);
});

test('adding a prop creates its binding, and unused bindings can be removed', () => {
  const output = value(
    editPropertyDefinition('<slot/>', {
      kind: 'save',
      originalName: '',
      property: { ...property, name: 'label', defaultValue: '' },
    }),
  );
  assert.match(output, /const \{ label \} = Astro.props/);
  const removed = value(editPropertyDefinition(output, { kind: 'remove', name: 'label' }));
  assert.equal(readComponentProperties(removed).properties.length, 0);
  assert.equal(editPropertyDefinition(source, { kind: 'remove', name: 'title' }).ok, false);
});

test('comma expressions remain one default and cannot introduce extra bindings', () => {
  const output = value(
    editPropertyDefinition('<slot/>', {
      kind: 'save',
      originalName: '',
      property: { ...property, defaultValue: '1, 2' },
    }),
  );
  assert.match(output, /title = \(1, 2\)/);
  assert.equal(readComponentProperties(output).properties.length, 1);
  assert.equal(
    editPropertyDefinition(
      source,
      save({
        defaultValue: '1); const other = 2; const third = (3',
      }),
    ).ok,
    false,
  );
});

test('untyped props can be ordered and quoted keys remain in source mode', () => {
  const input = '---\nconst { title = "Hello", count = 3 } = Astro.props;\n---\n<slot/>';
  const output = value(editPropertyDefinition(input, { kind: 'order', names: ['count', 'title'] }));
  assert.deepEqual(
    readComponentProperties(output).properties.map((field) => field.name),
    ['count', 'title'],
  );
  const quoted = readComponentProperties('---\ninterface Props { "aria-label"?: string }\n---\n<div/>');
  assert.equal(quoted.advanced, true);
  assert.equal(parseComponentProperties(quoted).properties[0].name, 'aria-label');
});

test('renames indexed Props references without changing unrelated string literal types', () => {
  const input =
    '---\ninterface Props { title?: string }\n' +
    'type Value = Props["title"];\ntype Chosen = Pick<Props, "title">;\n' +
    'type Unrelated = "title";\n---\n<p>{Astro.props.title}</p>';
  const output = value(renameComponentReferences(input, new Set(), { from: 'title', to: 'heading' }, 'definition'));
  assert.match(output, /Props\["heading"\]/);
  assert.match(output, /Pick<Props, "heading">/);
  assert.match(output, /Unrelated = "title"/);
});

test('renames resolve tsconfig aliases and MDX instances', () => {
  project(({ root, component }) => {
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }),
    );
    const mdx = path.join(root, 'src/pages/article.mdx');
    fs.writeFileSync(mdx, 'import Feature from "@/components/Card.astro";\n\n# Hello\n\n' + '<Feature title="Story" />');
    const result = updateComponentProperties(
      {
        projectPath: root,
        file: component,
        source,
        change: save({ name: 'heading' }),
      },
      writer,
    );
    value(result);
    assert.match(fs.readFileSync(mdx, 'utf8'), /<Feature heading="Story"/);
  });
});

test('re-exports, runtime aliases, and dynamic imports cannot cause partial renames', () => {
  for (const contents of [
    'export { default as Card } from "./components/Card.astro";',
    'const Card = await import("./components/Card.astro");',
    'import Card from "./components/Card.astro";\nconst Other = Card;',
  ]) {
    project(({ root, component, page }) => {
      fs.writeFileSync(path.join(root, 'src/index.ts'), contents);
      const before = fs.readFileSync(page, 'utf8');
      const result = updateComponentProperties(
        {
          projectPath: root,
          file: component,
          source,
          change: save({ name: 'heading' }),
        },
        writer,
      );
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(component, 'utf8'), source);
      assert.equal(fs.readFileSync(page, 'utf8'), before);
    });
  }
});

test('deleting a property refuses live instance values', () => {
  project(({ root, component, page }) => {
    const input = '---\ninterface Props { title?: string }\n---\n<slot/>';
    fs.writeFileSync(component, input);
    const result = updateComponentProperties(
      {
        projectPath: root,
        file: component,
        source: input,
        change: { kind: 'remove', name: 'title' },
      },
      writer,
    );
    assert.equal(result.ok, false);
    assert.match(result.error.message, /still passes title/);
    assert.equal(fs.readFileSync(component, 'utf8'), input);
    assert.match(fs.readFileSync(page, 'utf8'), /title=\{title\}/);
  });
});

test('inherited Props remain editable and local option aliases preserve shared types', () => {
  const input = `---
import type { HTMLAttributes } from 'astro/types';
type GapBase = 'small' | 'medium';
type ContainerGap = GapBase | 'large';
interface Props extends HTMLAttributes<'section'> {
  /** Space between items. */
  gap?: ContainerGap;
  otherGap?: ContainerGap;
  render?: boolean;
}
const { gap = 'small', otherGap = 'large', render = true, ...rest } = Astro.props;
---
<section {...rest}>{gap} {otherGap}</section>`;
  const snapshot = readComponentProperties(input);
  assert.equal(snapshot.advanced, false);
  const gap = snapshot.properties.find((field) => field.name === 'gap');
  assert.equal(gap.type, "'small' | 'medium' | 'large'");
  assert.equal(gap.description, 'Space between items.');
  const required = value(
    editPropertyDefinition(input, {
      kind: 'save',
      originalName: 'gap',
      property: { ...gap, required: true, description: 'Choose the spacing.' },
    }),
  );
  assert.match(required, /gap: ContainerGap/);
  assert.match(required, /interface Props extends HTMLAttributes<'section'>/);
  assert.equal(readComponentProperties(required).properties[0].description, 'Choose the spacing.');
  const options = value(
    editPropertyDefinition(required, {
      kind: 'save',
      originalName: 'gap',
      property: {
        ...gap,
        name: 'spacing',
        required: true,
        type: "'large' | 'compact' | 'medium'",
        defaultValue: "'compact'",
      },
    }),
  );
  assert.match(options, /spacing: 'large' \| 'compact' \| 'medium'/);
  assert.match(options, /spacing: gap = 'compact'/);
  assert.match(options, /type ContainerGap = GapBase \| 'large'/);
  assert.match(options, /otherGap\?: ContainerGap/);
  const reordered = value(
    editPropertyDefinition(options, {
      kind: 'order',
      names: ['render', 'otherGap', 'spacing'],
    }),
  );
  assert.deepEqual(
    readComponentProperties(reordered).properties.map((field) => field.name),
    ['render', 'otherGap', 'spacing'],
  );
  assert.match(reordered, /interface Props extends HTMLAttributes<'section'>/);
});

test('type aliases resolve within bounds without expanding imported or recursive contracts', () => {
  for (const [aliases, type, expected] of [
    ["type Options = ('one' | 'two');", 'Options', "'one' | 'two'"],
    ['type Toggle = boolean;', 'Toggle', 'boolean'],
    ["type Loop = 'one' | Loop;", 'Loop', 'Loop'],
    ['type First = Second; type Second = First;', 'First', 'First'],
    ["type Options<T> = T | 'one';", 'Options<string>', 'Options<string>'],
    ["import type { Options } from './types';", 'Options', 'Options'],
    ['type Options = { value: string };', 'Options', 'Options'],
    ["type Options = 'one'; type Options = 'two';", 'Options', 'Options'],
    [Array.from({ length: 70 }, (_, index) => `type A${index} = ${index === 69 ? "'last'" : `A${index + 1}`};`).join('\n'), 'A0', 'A0'],
  ]) {
    const input = `---\n${aliases}\ninterface Props { value?: ${type} }\n---\n<div/>`;
    assert.equal(readComponentProperties(input).properties[0].type, expected);
  }
});

test('renaming a local prop on inherited Props updates website instances', () => {
  project(({ root, component, page }) => {
    const input = source.replace('interface Props {', "interface Props extends HTMLAttributes<'section'> {");
    fs.writeFileSync(component, input);
    value(
      updateComponentProperties(
        {
          projectPath: root,
          file: component,
          source: input,
          change: save({ name: 'heading' }),
        },
        writer,
      ),
    );
    assert.match(fs.readFileSync(component, 'utf8'), /Props extends HTMLAttributes/);
    assert.match(fs.readFileSync(page, 'utf8'), /<Alias heading=\{title\}/);
    assert.match(fs.readFileSync(page, 'utf8'), /<Other title="untouched"/);
  });
});

// Step 6: a property batch gains its inverse batch — Undo — applied like the
// batch itself: every file checked against the bytes the batch left before
// any is written, so a file changed since refuses the whole undo.
test('the inverse batch undoes a rename, redoes it, and refuses a changed file', () => {
  project(({ root, component, page }) => {
    const before = {
      component: fs.readFileSync(component, 'utf8'),
      page: fs.readFileSync(page, 'utf8'),
    };
    const store = new PropertyUndoStore();
    let token;
    const recording = {
      ...writer,
      onCommitted: (changes) => (token = store.record(inverseBatch(changes))),
    };
    const request = {
      projectPath: root,
      file: component,
      source,
      change: save({ name: 'heading' }),
    };
    assert.equal(updateComponentProperties(request, recording).ok, true);
    assert.ok(token, 'an applied batch recorded its inverse');
    const after = {
      component: fs.readFileSync(component, 'utf8'),
      page: fs.readFileSync(page, 'utf8'),
    };
    assert.notEqual(after.page, before.page, 'the rename reached the consumer');

    const undone = revertComponentProperties(token, store, writer);
    assert.equal(undone.ok, true);
    assert.equal(fs.readFileSync(component, 'utf8'), before.component, 'the definition is back');
    assert.equal(fs.readFileSync(page, 'utf8'), before.page, 'and every consumer');
    assert.deepEqual(
      revertComponentProperties(token, store, writer),
      {
        ok: false,
        error: { code: 'expired', message: 'This property change can no longer be undone.' },
      },
      'a token is spent once',
    );

    const redone = revertComponentProperties(undone.value.undo, store, writer);
    assert.equal(redone.ok, true);
    assert.equal(fs.readFileSync(page, 'utf8'), after.page, 'redo is the batch again');

    fs.writeFileSync(page, `${after.page}\n<!-- theirs -->\n`);
    const refused = revertComponentProperties(redone.value.undo, store, writer);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'conflict');
    assert.equal(fs.readFileSync(component, 'utf8'), after.component, 'nothing was written');
    assert.ok(fs.readFileSync(page, 'utf8').endsWith('<!-- theirs -->\n'), 'their edit stays');
  });
});

test('the undo store keeps at most LIMITS.undoEntriesMax batches, oldest out first', () => {
  const store = new PropertyUndoStore();
  const first = store.record([]);
  for (let index = 0; index < 100; index++) {
    store.record([]);
  }
  assert.equal(store.take(first), undefined, 'the oldest went');
});
