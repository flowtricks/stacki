// Goal: the UI kit script, the bundle injected into every app iframe, stays free of the editor's translation machinery. The kit runs
// where no locale provider exists, and when the English catalogs (hundreds of kilobytes) and the provider entered it, the script grew past
// its size gate and `npm run build:runtime` failed. A shared component that imports `useTranslate` must reach the kit's own translator.
// Method: build the kit with the real builder and read the esbuild metafile's input list: no catalog, no locale provider, no
// `useTranslate` hook may be among them; the kit translator and the `ui` English words must be; the script keeps margin under its limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { repoPath } = require('../../helpers/sources');

let bundle;
test.before(async () => {
  const builder = await import(pathToFileURL(repoPath('scripts/build/appUiKitSource.mts')).href);
  bundle = await builder.bundleAppUiKit(repoPath('.'));
});

const FORBIDDEN = [
  'shared/properties/i18n/messages/en/index.ts',
  'src/lib/i18n/LocaleProvider.tsx',
  'src/lib/i18n/localeContext.ts',
  'src/lib/i18n/useTranslate.ts',
  'src/lib/i18n/loadCatalog.ts',
];

test('the kit script imports no catalog, locale provider or editor translate hook', () => {
  for (const input of bundle.inputs) {
    const isCatalog = input.startsWith('shared/properties/i18n/messages/');
    assert.ok(!isCatalog || input === 'shared/properties/i18n/messages/en/ui.ts', `${input} is in the kit`);
  }
  for (const forbidden of FORBIDDEN) {
    assert.ok(!bundle.inputs.includes(forbidden), `${forbidden} is in the kit script`);
  }
});

test('the kit reads its words from the kit translator and the English ui namespace', () => {
  assert.ok(bundle.inputs.includes('src/features/apps/uiKit/kitTranslate.ts'));
  assert.ok(bundle.inputs.includes('shared/properties/i18n/messages/en/ui.ts'));
});

test('the kit script keeps margin under its size gate (80% of 600000 characters)', () => {
  assert.ok(bundle.script.length < 480_000, `kit script is ${bundle.script.length} characters`);
});
