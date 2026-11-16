// Goal: the Properties panel never locks a prop. For every component shape in the
// corpus, every prop reads as editable, and each edit the panel offers (tooltip,
// required, type, default, rename, delete, add, reorder) is accepted, leaves a file
// whose frontmatter still compiles, and reads back as what was saved.
//
// Method: a table over three kinds of component. The prop zoo (one component per way
// of typing props), the Lumos starter's components and layouts copied read-only from
// a real project (Button's `Astro.props as AllProps` and discriminated variants among
// them), and inline shapes for the forms the files do not cover (imported Props,
// annotated destructures, quoted names, `...rest` with no Props type). Each case runs
// every edit against the original source and checks the negative space too: a save
// that changes nothing writes nothing, and a delete is refused only for a prop the
// component still reads.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');
const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');
const { readPropertySyntax, syntaxError } = require('#dist/electron/properties/propertySyntax.js');

const inline = {
  'imported Props': '---\nimport type { Props } from "./types";\nconst { title = "Hi", size } = Astro.props;\n---\n<h1 class={size}>{title}</h1>',
  'imported Props with alias':
    '---\nimport type { Props as Shared } from "./types";\ntype Props = Shared & { extra?: string };\nconst { title, extra } = Astro.props;\n---\n<h1>{title}{extra}</h1>',
  'annotated destructure by reference':
    '---\ntype Shape = { title?: string; count?: number };\nconst { title, count = 2 }: Shape = Astro.props;\n---\n<p>{title}{count}</p>',
  'annotated destructure literal': '---\nconst { title, count = 2 }: { title?: string; count?: number } = Astro.props;\n---\n<p>{title}{count}</p>',
  'cast to a local alias': '---\ntype All = { a?: string; b?: number };\nconst { a, b = 1 } = Astro.props as All;\n---\n<p>{a}{b}</p>',
  'cast to an interface': '---\ninterface All { a?: string; b?: number }\nconst { a, b = 1 } = Astro.props as All;\n---\n<p>{a}{b}</p>',
  'cast to an imported type': '---\nimport type { All } from "./types";\nconst { a, b = 1 } = Astro.props as All;\n---\n<p>{a}{b}</p>',
  'no Props at all': '---\nconst { title = "Hi", tone } = Astro.props;\n---\n<p class={tone}>{title}</p>',
  'only Astro.props.x': '---\nconst heading = Astro.props.heading;\n---\n<h1>{heading}{Astro.props.subtitle}</h1>',
  'JS-only frontmatter': '---\nconst { title = "Hi" } = Astro.props;\nconst loud = title.toUpperCase();\n---\n<h1>{loud}</h1>',
  'rest with no Props': '---\nconst { title, ...rest } = Astro.props;\n---\n<a {...rest}>{title}</a>',
  'rest with an attributes Props':
    '---\nimport type { HTMLAttributes } from "astro/types";\ninterface Props extends HTMLAttributes<"a"> { title?: string }\nconst { title, ...rest } = Astro.props;\n---\n<a {...rest}>{title}</a>',
  'renames and defaults':
    '---\ninterface Props { title?: string; class?: string }\nconst { title: heading = "Hi", class: className = "box" } = Astro.props;\n---\n<h1 class={className}>{heading}</h1>',
  'quoted names':
    '---\ninterface Props { "aria-label"?: string; title?: string }\nconst { "aria-label": label, title } = Astro.props;\n---\n<h1 aria-label={label}>{title}</h1>',
  'discriminated union': '---\ntype Props = { kind: "a"; a: string } | { kind: "b"; b: number };\nconst props = Astro.props;\n---\n<p>{props.kind}</p>',
  'union beside a common member':
    '---\ntype Props = { tone?: string } & ({ kind: "a"; a?: string } | { kind: "b"; a?: never });\nconst { tone, kind, a } = Astro.props;\n---\n<p>{tone}{kind}{a}</p>',
  'intersection of separate types':
    '---\ntype Base = { id?: string };\ntype Extra = { id?: string; note?: string };\ntype Props = Base & Extra;\nconst { id, note } = Astro.props;\n---\n<p>{id}{note}</p>',
  'generic Props': '---\ninterface Props<T> { item?: T; label?: string }\nconst { item, label } = Astro.props;\n---\n<p>{label}</p>',
  'mapped and computed members':
    '---\ntype Keys = "a" | "b";\ntype Props = { [K in Keys]?: string } & { c?: number };\nconst { a, b, c } = Astro.props;\n---\n<p>{a}{b}{c}</p>',
  'exported Props': '---\nexport interface Props { title?: string }\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>',
  'two destructures': '---\ninterface Props { a?: string; b?: string }\nconst { a } = Astro.props;\nconst { b } = Astro.props;\n---\n<p>{a}{b}</p>',
  'nested destructure':
    '---\ninterface Props { box?: { w: number; h: number }; title?: string }\nconst { box: { w, h } = { w: 1, h: 2 }, title } = Astro.props;\n---\n<p>{w}{h}{title}</p>',
  'duplicate Props declarations':
    '---\ninterface Props { title?: string }\ninterface Props { count?: number }\nconst { title, count } = Astro.props;\n---\n<p>{title}{count}</p>',
};

function corpus() {
  const cases = [];
  for (const root of ['test/fixtures/propZoo/src/components', 'test/fixtures/lumos/components', 'test/fixtures/lumos/layouts']) {
    const stack = [repoPath(root)];
    while (stack.length > 0) {
      const directory = stack.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.endsWith('.astro')) {
          cases.push([path.relative(repoPath('test/fixtures'), full), fs.readFileSync(full, 'utf8')]);
        }
      }
    }
  }
  return [...cases.sort((left, right) => left[0].localeCompare(right[0])), ...Object.entries(inline)];
}

function compiles(source) {
  const frontmatter = readPropertySyntax(source).frontmatter;
  return syntaxError(frontmatter) === undefined;
}

function edit(source, change) {
  return editPropertyDefinition(source, change);
}

// A delete may be refused for exactly one reason: the component still reads the value.
function acceptable(result) {
  return result.ok || result.error.code === 'in-use';
}

for (const [name, source] of corpus()) {
  test(`every prop is editable and its edits round-trip: ${name}`, () => {
    const data = readComponentProperties(source);
    const failures = [];
    for (const property of data.properties) {
      const label = `${name}:${property.name}`;
      if (property.editing?.kind === 'restricted') {
        failures.push(`${label} reads as restricted`);
        continue;
      }
      const save = (changed, originalName = property.name) => edit(source, { kind: 'save', originalName, property: { ...property, ...changed } });
      const read = (output, prop) => readComponentProperties(output).properties.find((field) => field.name === prop);
      const tooltip = save({ description: 'Round trip tip' });
      if (!tooltip.ok || !compiles(tooltip.value) || read(tooltip.value, property.name)?.description !== 'Round trip tip') {
        failures.push(`${label} tooltip: ${JSON.stringify(tooltip.ok ? 'not read back' : tooltip.error)}`);
      }
      const required = save({ required: !property.required });
      if (!required.ok || !compiles(required.value)) {
        failures.push(`${label} required: ${JSON.stringify(required.ok ? 'does not compile' : required.error)}`);
      }
      const typed = save({ type: 'string' });
      if (!typed.ok || !compiles(typed.value) || read(typed.value, property.name)?.type !== 'string') {
        failures.push(`${label} type: ${JSON.stringify(typed.ok ? 'not read back' : typed.error)}`);
      }
      const defaulted = save({ defaultValue: '"round"' });
      if (!defaulted.ok || !compiles(defaulted.value) || read(defaulted.value, property.name)?.defaultValue !== '"round"') {
        failures.push(`${label} default: ${JSON.stringify(defaulted.ok ? 'not read back' : defaulted.error)}`);
      }
      const renamed = save({ name: 'renamedProp' });
      if (!renamed.ok || !compiles(renamed.value) || read(renamed.value, 'renamedProp') === undefined) {
        failures.push(`${label} rename: ${JSON.stringify(renamed.ok ? 'not read back' : renamed.error)}`);
      }
      const removed = edit(source, { kind: 'remove', name: property.name });
      if (!acceptable(removed) || (removed.ok && !compiles(removed.value))) {
        failures.push(`${label} remove: ${JSON.stringify(removed.ok ? 'does not compile' : removed.error)}`);
      }
      const unchanged = save({});
      if (!unchanged.ok || unchanged.value !== source) {
        failures.push(`${label} a save that changes nothing rewrote the file`);
      }
    }
    const added = edit(source, {
      kind: 'save',
      originalName: '',
      property: { name: 'addedProp', type: 'string', required: false, readonly: false, defaultValue: '"new"', description: 'Added' },
    });
    if (!added.ok || !compiles(added.value) || readComponentProperties(added.value).properties.find((field) => field.name === 'addedProp') === undefined) {
      failures.push(`${name}: add ${JSON.stringify(added.ok ? 'not read back' : added.error)}`);
    }
    const reorder = edit(source, { kind: 'order', names: data.properties.map((field) => field.name).reverse() });
    if (!reorder.ok || !compiles(reorder.value)) {
      failures.push(`${name}: reorder ${JSON.stringify(reorder.ok ? 'does not compile' : reorder.error)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('the Lumos Button, the shape that was locked, reads and writes through both of its declarations', () => {
  const source = fs.readFileSync(repoPath('test/fixtures/lumos/components/Button.astro'), 'utf8');
  const data = readComponentProperties(source);
  assert.ok(data.properties.length >= 10);
  assert.deepEqual(
    data.properties.filter((property) => property.editing?.kind === 'restricted').map((property) => property.name),
    [],
  );
  const render = data.properties.find((property) => property.name === 'render');
  const saved = edit(source, { kind: 'save', originalName: 'render', property: { ...render, name: 'visible', description: 'Show it' } });
  assert.equal(saved.ok, true);
  assert.equal((saved.value.match(/visible\??: boolean/g) ?? []).length, 2, 'the public and the runtime declaration are renamed together');
});
