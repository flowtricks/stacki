// The CLI installs the registry sources. Astro adapters make those sources usable in both editors.
import { lstatSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { ShadcnBase } from '../../shared/ipc/shadcnStarter';
import {
  COMPONENT_DEFAULTS_FILE,
  DEFAULT_LIMITS,
  parseComponentDefaults,
  parseDefaultsSource,
  type ComponentRecipe,
} from '../../shared/properties/componentDefaults';
import { catalogExamples, type CatalogExample } from './shadcnStarterExamples';

// The three authored ui/_registry.ts files at shadcn@4.23.0 define this inventory.
// All eight styles per base use the same item names. Keep this explicit because
// the CLI's --all also selects other registry types, including page examples.
const COMMON_ITEMS = [
  'accordion',
  'alert',
  'alert-dialog',
  'aspect-ratio',
  'attachment',
  'avatar',
  'badge',
  'breadcrumb',
  'bubble',
  'button',
  'button-group',
  'calendar',
  'card',
  'carousel',
  'chart',
  'checkbox',
  'code-block',
  'collapsible',
  'combobox',
  'command',
  'context-menu',
  'dialog',
  'direction',
  'drawer',
  'dropdown-menu',
  'empty',
  'field',
  'form',
  'hover-card',
  'input',
  'input-group',
  'input-otp',
  'item',
  'kbd',
  'label',
  'marker',
  'message',
  'message-scroller',
  'native-select',
  'pagination',
  'popover',
  'progress',
  'questionnaire',
  'radio-group',
  'resizable',
  'scroll-area',
  'select',
  'separator',
  'sheet',
  'sidebar',
  'skeleton',
  'slider',
  'sonner',
  'spinner',
  'switch',
  'table',
  'tabs',
  'textarea',
  'toggle',
  'toggle-group',
  'tooltip',
  'trace',
] as const;
const MENU_ITEMS = ['menubar', 'navigation-menu'] as const;
const BASE_ITEMS = {
  base: [...MENU_ITEMS, 'toast'],
  aria: [],
  radix: MENU_ITEMS,
} as const satisfies Record<ShadcnBase, readonly string[]>;
const DOCS_COMPOSITIONS = ['data-table', 'date-picker', 'typography'] as const;

// The starter content already writes these Astro adapters and their recipes.
const CURATED_COMPONENTS = {
  button: 'Button',
  card: 'Card',
  dialog: 'Dialog',
  field: 'Field',
  input: 'Input',
  tabs: 'Tabs',
} as const satisfies Readonly<Record<string, string>>;

type RegistryItem = (typeof COMMON_ITEMS)[number] | (typeof BASE_ITEMS)[ShadcnBase][number];
type StarterExampleName = Exclude<RegistryItem, keyof typeof CURATED_COMPONENTS> | (typeof DOCS_COMPOSITIONS)[number];

export function shadcnRegistryItems(base: ShadcnBase): readonly RegistryItem[] {
  return [...COMMON_ITEMS, ...BASE_ITEMS[base]];
}

export function verifyShadcnRegistryInstall(directory: string, base: ShadcnBase): void {
  // Form is the sole metadata-only registry UI item. It has a composition adapter.
  const installed = shadcnRegistryItems(base)
    .filter((item) => item !== 'form')
    .map((item) => {
      const entry = lstatSync(path.join(directory, 'src/components/ui', `${item}.tsx`), { throwIfNoEntry: false });
      return { item, exists: entry?.isFile() === true };
    });
  const missing = installed.filter(({ exists }) => !exists).map(({ item }) => item);
  if (missing.length > 0) {
    throw new Error(`shadcn did not install these components: ${missing.join(', ')}.`);
  }
}

export async function writeShadcnStarterCatalog(directory: string, { base }: { readonly base: ShadcnBase }): Promise<void> {
  const defaultsFile = path.join(directory, COMPONENT_DEFAULTS_FILE);
  const current = await readCatalogDefaults(defaultsFile);
  const examples = catalogExamples(base);
  const entries = [...shadcnRegistryItems(base), ...DOCS_COMPOSITIONS].flatMap((item) => {
    if (isCurated(item)) {
      const file = `src/components/${CURATED_COMPONENTS[item]}.astro`;
      assert(Object.hasOwn(current.components, file), `The starter content writes a recipe for ${file}`);
      return [];
    }
    const example = examples[item];
    return [catalogEntry(item, example)];
  });
  assert(
    entries.length + Object.keys(CURATED_COMPONENTS).length === shadcnRegistryItems(base).length + DOCS_COMPOSITIONS.length,
    'The catalog covers every selected item',
  );
  const generated = Object.fromEntries(entries.map(({ file, recipe }) => [file, recipe]));
  assert(Object.keys(generated).length === entries.length, 'Catalog files have unique paths');
  const defaults = parseComponentDefaults({
    version: 1,
    components: { ...current.components, ...generated },
  });

  await mkdir(path.join(directory, 'src/components/shadcn'), { recursive: true });
  await mkdir(path.join(directory, 'src/components/examples/catalog'), { recursive: true });
  // Drain every write before the caller can clean up the staging directory.
  const settled = await Promise.allSettled(
    entries.flatMap(({ file, astro, islandFile, island }) => [
      writeFile(path.join(directory, file), astro, { encoding: 'utf8', flag: 'wx' }),
      writeFile(path.join(directory, islandFile), island, { encoding: 'utf8', flag: 'wx' }),
    ]),
  );
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw new Error('Could not write the shadcn catalog.', { cause: result.reason });
    }
  }
  await writeFile(defaultsFile, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
}

function isCurated(item: RegistryItem | (typeof DOCS_COMPOSITIONS)[number]): item is keyof typeof CURATED_COMPONENTS {
  return Object.hasOwn(CURATED_COMPONENTS, item);
}

async function readCatalogDefaults(file: string) {
  const source = await open(file, 'r');
  try {
    // UTF-8 can take three bytes per UTF-16 code unit. The parser checks the character bound.
    const buffer = Buffer.alloc(DEFAULT_LIMITS.sourceCharsMax * 3 + 1);
    const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) {
      throw new Error('The shadcn insertion defaults exceed their size limit.');
    }
    const result = parseDefaultsSource(buffer.toString('utf8', 0, bytesRead));
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  } finally {
    await source.close();
  }
}

function adapterName(item: StarterExampleName): string {
  return item === 'input-otp' ? 'InputOTP' : item.replace(/(^|-)([a-z])/g, (_match, _divider, letter: string) => letter.toUpperCase());
}

function catalogEntry(item: StarterExampleName, example: CatalogExample) {
  const { label, imports, markup, setup = '', module = '', hydrate = false } = example;
  const name = adapterName(item);
  const recipe: ComponentRecipe = { props: { label } };
  return {
    file: `src/components/shadcn/${name}.astro`,
    astro: `---
import { Example } from "../examples/catalog/${name}";

interface Props {
  readonly label?: string;
}

const { label = ${JSON.stringify(label)} } = Astro.props;
---

<Example${hydrate ? ' client:load' : ''} {label} />
`,
    islandFile: `src/components/examples/catalog/${name}.tsx`,
    island: `${imports}
import { PreviewDirectionProvider } from "../PreviewDirection";
${module}
export function Example({ label }: { readonly label: string }) {
  ${setup}
  return (
    <PreviewDirectionProvider>
      ${markup}
    </PreviewDirectionProvider>
  );
}
`,
    recipe,
  };
}
