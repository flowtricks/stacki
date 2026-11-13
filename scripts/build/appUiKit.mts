// Writes the app UI kit's generated module (shared/properties/generated/appUiKitBundle.ts)
// from the editor's components and CSS. `npm run build` runs it before the compiler. The kit is served to apps by both hosts, which cannot
// read the editor's stylesheets at run time (a packaged Desktop has no source
// files; Studio's server has only the vendored shared code), so its CSS is
// built here and imported. test/renderer/apps/appUiKit.test.js fails when the
// module and the editor's CSS differ, so the two cannot drift.
// Usage:
// `node scripts/build/appUiKit.mts` writes the module, and with `--check` exits 1 when it is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appUiKitModule, buildAppUiKit, bundleAppUiKit, KIT_SOURCE_FILES, type KitSources } from './appUiKitSource.mts';

const TARGET = fileURLToPath(new URL('../../shared/properties/generated/appUiKitBundle.ts', import.meta.url));

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
}

const sources: KitSources = {
  editor: read(KIT_SOURCE_FILES.editor),
  styleTokens: read(KIT_SOURCE_FILES.styleTokens),
  controls: read(KIT_SOURCE_FILES.controls),
  dropdown: read(KIT_SOURCE_FILES.dropdown),
  switch: read(KIT_SOURCE_FILES.switch),
  kitHost: read(KIT_SOURCE_FILES.kitHost),
};
const expected = appUiKitModule(buildAppUiKit(sources, await bundleAppUiKit(fileURLToPath(new URL('../..', import.meta.url)))));
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    current = '';
  }
  if (current !== expected) {
    console.error('shared/properties/generated/appUiKitBundle.ts is stale: run node scripts/build/appUiKit.mts');
    process.exit(1);
  }
} else {
  writeFileSync(TARGET, expected);
}
