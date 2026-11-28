import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCatalogs } from './catalogBundle';
import { record, string } from '../src/shared/primitiveValidation';
import { syncTree, withVendorLock, writeIfChanged } from './vendorSync';

// A project release contains this generated tree. In the Stacki repository it
// is rebuilt from the canonical editor before every check, build and release.
const studio = fileURLToPath(new URL('../', import.meta.url));
const root = path.dirname(studio);
const inventory = record(JSON.parse(await readFile(path.join(studio, 'scripts/shared-source.json'), 'utf8')));

// Files the inventory may list: about 2,450 today, of which 792 are the 18 interface languages' catalogs (44 files each).
const INVENTORY_FILES_MAX = 4000;

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > INVENTORY_FILES_MAX) {
    throw new Error('Invalid shared source inventory');
  }
  return value.map((item: unknown) => {
    const name = string(item, 500);
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..')) {
      throw new Error('Invalid shared source path');
    }
    return name;
  });
}

function relativeModule(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

// The bytes one inventory entry becomes in vendor/stacki.
async function assembledContent(file: string, adapters: ReadonlySet<string>): Promise<string | Buffer> {
  const destination = path.join(studio, 'vendor/stacki', file);
  const modules = record(inventory['modules']);
  if (modules[file]) {
    const target = path.join(studio, string(modules[file], 500));
    return `export * from ${JSON.stringify(relativeModule(destination, target))};\n`;
  }
  const source = adapters.has(file) ? path.join(studio, 'adapters', file) : path.join(root, file);
  const mappings = record(inventory['imports']);
  if (mappings[file]) {
    let text = await readFile(source, 'utf8');
    for (const [specifier, target] of Object.entries(record(mappings[file]))) {
      const replacement = relativeModule(destination, path.join(studio, string(target, 500)));
      for (const quote of ["'", '"']) {
        text = text.replaceAll(quote + specifier + quote, quote + replacement + quote);
      }
    }
    return text;
  }
  return readFile(source);
}

let parent: unknown;
try {
  parent = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
} catch {
  parent = {};
}
const development = await access(path.join(root, 'shared/ipc/preloadApi.ts')).then(
  () => true,
  () => false,
);
if (record(parent)['name'] === 'stacki' && development) {
  const adapters = new Set(paths(inventory['adapters']));
  const files = paths(inventory['files']);
  const version = string(record(parent)['version'], 50);
  const contents = new Map<string, string | Buffer>();
  // Each language's namespace catalogs become its one index (catalogBundle.ts says why).
  const catalogs = await planCatalogs(root, files);
  for (const file of catalogs.files) {
    contents.set(file, await assembledContent(file, adapters));
  }
  for (const [file, text] of catalogs.bundles) {
    contents.set(file, text);
  }
  const assembledCount = contents.size;
  contents.set(
    'PROVENANCE.md',
    `# Stacki shared source\n\nGenerated from the Stacki ${version} source tree. See docs/central-icons.md for separately licensed icon assets.\n` +
      'Edit the canonical Stacki source or studio/adapters, then run npm run assemble.\n' +
      'Each language’s message catalogs are merged into its index.ts (scripts/catalogBundle.ts).\n' +
      'scripts/shared-source.json records the included files and host adapter boundaries.\n',
  );
  // Locked and incremental (vendorSync.ts): concurrent assembles never leave the tree half written.
  await withVendorLock(path.join(studio, '.studio/assemble.lock'), async () => {
    await syncTree(path.join(studio, 'vendor/stacki'), contents);
    await writeIfChanged(path.join(studio, 'src/shared/release.json'), JSON.stringify({ version }, null, 2) + '\n');
  });
  console.log(`Assembled ${assembledCount} files from ${files.length} shared sources for Stacki Studio ${version}.`);
}
