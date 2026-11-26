import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { COMPONENT_DEFAULTS_FILE, DEFAULT_LIMITS, parseComponentDefaults, type ComponentRecipe } from '../../shared/properties/componentDefaults';
import { HEROUI_ACTIONS } from './herouiCatalogActions';
import { HEROUI_DISPLAY } from './herouiCatalogDisplay';
import { HEROUI_FIELDS } from './herouiCatalogFields';
import { HEROUI_PICKERS, HEROUI_VALUE_SOURCE } from './herouiCatalogPickers';
import { HEROUI_CATEGORIES, type CatalogProp, type HeroUICatalogEntry } from './herouiCatalogTypes';

// Source: @heroui/react@3.2.8 package/docs/components and the Free component index.
// The package exports textarea and textfield under unhyphenated subpaths.
// The Free index has no separate pages for calendar-year-picker, color-input-group,
// date-input-group, empty-state, header, list-box-item, list-box-section, menu,
// menu-item, menu-section, radio, switch-group, tag, or the React Aria helpers in rac.
export const HEROUI_STARTER_CATALOG: readonly HeroUICatalogEntry[] = [...HEROUI_ACTIONS, ...HEROUI_DISPLAY, ...HEROUI_FIELDS, ...HEROUI_PICKERS];

const COMPONENT_DIRECTORY = 'src/components/heroui';
const ISLAND_DIRECTORY = 'src/lib/heroui';
const EXAMPLES_FILE = 'src/pages/example-components.astro';

export async function writeHeroUICatalog(directory: string): Promise<void> {
  const entries = HEROUI_STARTER_CATALOG;
  assert(entries.length === 73, 'The pinned HeroUI catalog has 73 documented components');
  assert(new Set(entries.map(({ slug }) => slug)).size === entries.length, 'HeroUI catalog slugs are unique');
  assert(new Set(entries.map(({ name }) => name)).size === entries.length, 'HeroUI catalog wrappers are unique');

  const recipes = parseComponentDefaults({
    version: 1,
    components: Object.fromEntries(entries.map((entry) => [componentFile(entry), buildRecipe(entry)])),
  });
  const source = JSON.stringify(recipes, null, 2) + '\n';
  assert(source.length <= DEFAULT_LIMITS.sourceCharsMax, 'HeroUI recipes fit the shared source limit');

  // The caller owns the staging directory. Exclusive writes prevent accidental replacement.
  await mkdir(path.join(directory, COMPONENT_DIRECTORY), { recursive: true });
  await mkdir(path.join(directory, ISLAND_DIRECTORY), { recursive: true });
  await mkdir(path.join(directory, path.dirname(EXAMPLES_FILE)), { recursive: true });
  await mkdir(path.join(directory, path.dirname(COMPONENT_DEFAULTS_FILE)), { recursive: true });
  // Drain the bounded batch before the caller can remove its staging directory.
  const results = await Promise.allSettled(
    entries.flatMap((entry) => [
      writeFile(path.join(directory, componentFile(entry)), buildWrapper(entry), { encoding: 'utf8', flag: 'wx' }),
      writeFile(path.join(directory, ISLAND_DIRECTORY, `${entry.name}.tsx`), buildIsland(entry), { encoding: 'utf8', flag: 'wx' }),
    ]),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      throw new Error('Could not write the HeroUI components.', { cause: result.reason });
    }
  }
  await writeFile(path.join(directory, ISLAND_DIRECTORY, 'values.ts'), HEROUI_VALUE_SOURCE, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(directory, EXAMPLES_FILE), buildGallery(entries), { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(directory, COMPONENT_DEFAULTS_FILE), source, { encoding: 'utf8', flag: 'wx' });
}

function componentFile({ name }: HeroUICatalogEntry): string {
  return `${COMPONENT_DIRECTORY}/${name}.astro`;
}

function propIsChoice(prop: CatalogProp): prop is readonly [string, ...string[]] {
  return typeof prop === 'object';
}

function propType(prop: CatalogProp): string {
  return propIsChoice(prop) ? prop.map((choice) => JSON.stringify(choice)).join(' | ') : typeof prop;
}

function propDefault(prop: CatalogProp) {
  return propIsChoice(prop) ? prop[0] : prop;
}

function htmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;');
}

function buildRecipe({ props, slots }: HeroUICatalogEntry): ComponentRecipe {
  const children = Object.entries(slots ?? {}).map(([slot, text]) => ({ element: 'span', props: { slot }, text }));
  return {
    props: Object.fromEntries(Object.entries(props).map(([name, prop]) => [name, propDefault(prop)])),
    ...(children.length === 0 ? {} : { children }),
  };
}

function buildWrapper({ name, props, slots, hydrate }: HeroUICatalogEntry): string {
  const fields = Object.entries(props);
  const types = fields.map(([field, prop]) => `  readonly ${field}?: ${propType(prop)};`).join('\n');
  const defaults = fields.map(([field, prop]) => `  ${field} = ${JSON.stringify(propDefault(prop))},`).join('\n');
  const attributes = fields.map(([field]) => `{${field}}`).join(' ');
  const open = `<Example${hydrate === true ? ' client:load' : ''} ${attributes}`;
  const children = Object.entries(slots ?? {}).map(
    ([slot, fallback]) => `  <Fragment slot="${slot}"><slot name="${slot}">${htmlText(fallback)}</slot></Fragment>`,
  );
  return `---
import { Example } from "../../lib/heroui/${name}";

interface Props {
${types}
}

const {
${defaults}
} = Astro.props;
---

${children.length === 0 ? `${open} />` : `${open}>\n${children.join('\n')}\n</Example>`}
`;
}

function buildIsland({ props, slots, imports, extraImports, setup, markup }: HeroUICatalogEntry): string {
  const slotNames = Object.keys(slots ?? {});
  const fields = [...Object.entries(props).map(([field, prop]) => `  readonly ${field}: ${propType(prop)};`)];
  const heroUIImports = `import { ${imports.join(', ')} } from "@heroui/react";`;
  return `${heroUIImports}
${slotNames.length === 0 ? '' : 'import type { ReactNode } from "react";\n'}${extraImports === undefined ? '' : `${extraImports}\n`}
interface ExampleProps {
${[...fields, ...slotNames.map((slot) => `  readonly ${slot}?: ReactNode;`)].join('\n')}
}

export function Example({ ${[...Object.keys(props), ...slotNames].join(', ')} }: ExampleProps) {
${setup === undefined ? '' : `  ${setup}\n`}  return (
    ${markup}
  );
}
`;
}

function buildGalleryExample(entry: HeroUICatalogEntry): string {
  const recipe = buildRecipe(entry);
  const attributes = Object.entries(recipe.props ?? {})
    .map(([name, value]) => ` ${name}={${JSON.stringify(value)}}`)
    .join('');
  const open = `<${entry.name}${attributes}`;
  const children = Object.entries(entry.slots ?? {}).map(([slot, content]) => `            <span slot="${slot}">${htmlText(content)}</span>`);
  return children.length === 0
    ? `${open} />`
    : `${open}>
${children.join('\n')}
          </${entry.name}>`;
}

function buildGallery(entries: readonly HeroUICatalogEntry[]): string {
  const imports = entries.map(({ name }) => `import ${name} from "../components/heroui/${name}.astro";`).join('\n');
  const groups = HEROUI_CATEGORIES.map((category) => ({
    category,
    anchor: category.toLowerCase().replaceAll(' ', '-'),
    entries: entries.filter((entry) => entry.category === category).sort((left, right) => left.slug.localeCompare(right.slug, 'en')),
  }));
  assert(
    groups.every((group) => group.entries.length > 0),
    'Each HeroUI category has gallery examples',
  );
  const links = groups
    .map(({ category, anchor }) => `      <li><a class="underline underline-offset-4 hover:text-accent" href="#${anchor}">${category}</a></li>`)
    .join('\n');
  const sections = groups
    .map(({ category, anchor, entries: groupEntries }) => {
      const examples = groupEntries
        .map(
          (entry) => `        <article id="example-${entry.slug}" class="min-w-0 rounded-2xl border border-border bg-surface p-4 sm:p-6">
          <h3 class="mb-5 text-sm font-semibold text-muted">${entry.name}</h3>
          ${buildGalleryExample(entry)}
        </article>`,
        )
        .join('\n');
      return `    <section aria-labelledby="${anchor}" class="mb-12">
      <h2 id="${anchor}" class="mb-4 scroll-mt-24 text-xl font-semibold">${category}</h2>
      <div class="grid gap-4 md:grid-cols-2">
${examples}
      </div>
    </section>`;
    })
    .join('\n');
  return `---
import Layout from "../layouts/main.astro";
${imports}
---

<Layout title="Example Components">
  <div class="mx-auto w-full max-w-6xl px-4 py-12 sm:px-8">
    <h1 class="mb-6 text-4xl font-semibold tracking-tight">Example Components</h1>
    <nav aria-label="Component categories" class="mb-10">
      <ul class="flex flex-wrap gap-x-5 gap-y-3 text-sm text-muted">
${links}
      </ul>
    </nav>
${sections}
  </div>
</Layout>
`;
}
