// Generate a temporary catalog and check the pinned inventory against both editor parsers.
// Resolve each recipe through the palette preview path to catch missing props, slots, or files.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSlots } from '#dist/electron/parse/astroComponentApi.js';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { readPropModel } from '#dist/electron/parse/propModel/readPropModel.js';
import { componentPreviewRecipe } from '#dist/electron/previewServer/componentPreviewRecipe.js';
import { HEROUI_STARTER_CATALOG, writeHeroUICatalog } from '#dist/electron/project/herouiStarterCatalog.js';
import { HEROUI_VERSION } from '#dist/electron/project/herouiStarterSite.js';
import { COMPONENT_DEFAULTS_FILE, defaultsIssues, parseDefaultsSource } from '#dist/shared/properties/componentDefaults.js';

const PINNED_DOCUMENT_SLUGS = `
accordion alert alert-dialog autocomplete avatar avatar-group badge breadcrumbs button button-group calendar card
checkbox checkbox-group chip close-button color-area color-field color-picker color-slider color-swatch color-swatch-picker combo-box
date-field date-picker date-range-picker description disclosure disclosure-group drawer dropdown error-message field-error fieldset
form input input-group input-otp kbd label link list-box meter modal number-field pagination popover progress-bar progress-circle
radio-group range-calendar scroll-shadow search-field select separator sheet skeleton slider spinner surface switch table tabs
tag-group text-area text-field time-field toast toggle-button toggle-button-group toolbar tooltip typography
`
  .trim()
  .split(/\s+/);

test('generates a discoverable and editable Astro example and palette recipe for each HeroUI 3.2.8 Free component', async (context) => {
  assert.equal(HEROUI_VERSION, '3.2.8', 'Reconcile the catalog and its coverage fixture when upgrading HeroUI');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stacki-heroui-catalog-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeHeroUICatalog(directory);

  const read = (file: string): Promise<string> => readFile(path.join(directory, file), 'utf8');
  const [gallery, recipeSource, componentFiles] = await Promise.all([
    read('src/pages/example-components.astro'),
    read(COMPONENT_DEFAULTS_FILE),
    readdir(path.join(directory, 'src/components/heroui')),
  ]);
  const defaults = parseDefaultsSource(recipeSource);
  assert.ok(defaults.ok);
  assert.deepEqual(HEROUI_STARTER_CATALOG.map(({ slug }) => slug).sort(), [...PINNED_DOCUMENT_SLUGS].sort());
  assert.deepEqual(componentFiles.sort(), HEROUI_STARTER_CATALOG.map(({ name }) => `${name}.astro`).sort());
  assert.match(gallery, /<Layout title="Example Components">/);
  assert.ok(parsePage(gallery, { locs: true }).editable);

  const catalog = await Promise.all(
    HEROUI_STARTER_CATALOG.map(async (entry) => {
      const { slug, name, hydrate } = entry;
      const file = `src/components/heroui/${name}.astro`;
      const [source, island] = await Promise.all([read(file), read(`src/lib/heroui/${name}.tsx`)]);
      const fields = readPropModel(source).props;
      const props = fields.map((prop) => prop.name);
      const slots = parseSlots(source);
      const recipe = defaults.value.components[file];
      assert.ok(recipe, file);
      assert.deepEqual(props, Object.keys(recipe.props ?? {}), file);
      assert.ok(
        fields.every((field) => field.declared && field.usage === 'read'),
        file,
      );
      assert.ok(
        fields.every((field) => field.control.kind !== 'code'),
        file,
      );
      assert.deepEqual(slots, Object.keys(entry.slots ?? {}), file);
      assert.equal(source.includes('client:load'), hydrate === true, file);
      assert.match(island, /from "@heroui\/react";/);
      assert.ok(parsePage(source, { locs: true }).editable, file);
      assert.ok(gallery.includes(`import ${name} from "../components/heroui/${name}.astro";`));
      assert.ok(gallery.includes(`id="example-${slug}"`));
      assert.ok(gallery.includes(`<${name} `));
      assert.ok(componentPreviewRecipe(directory, file, defaults.value), file);
      return { file, name, props, slots, slotText: false };
    }),
  );
  assert.equal(Object.keys(defaults.value.components).length, catalog.length);
  assert.deepEqual(defaultsIssues(defaults.value, catalog), []);

  const button = defaults.value.components['src/components/heroui/Button.astro'];
  assert.equal(button?.props?.['variant'], 'primary');
  const textField = defaults.value.components['src/components/heroui/TextField.astro'];
  assert.equal(textField?.props?.['defaultValue'], 'Spring launch');
  const modal = await read('src/lib/heroui/Modal.tsx');
  assert.match(modal, /<Modal\.Body[^>]*>.*<PrioritySelect /);
  assert.match(gallery, /<span slot="footer">Due Friday<\/span>/);
});
