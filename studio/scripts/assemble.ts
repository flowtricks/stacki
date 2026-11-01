import { access, copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, string } from '../src/shared/primitiveValidation';

// A project release contains this generated tree. In the Stacki repository it
// is rebuilt from the canonical editor before every check, build and release.
const studio = fileURLToPath(new URL('../', import.meta.url));
const root = path.dirname(studio);
const inventory = record(JSON.parse(await readFile(path.join(studio, 'scripts/shared-source.json'), 'utf8')));

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 2000) {
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

async function assembleFile(file: string, adapters: ReadonlySet<string>) {
  const destination = path.join(studio, 'vendor/stacki', file);
  await mkdir(path.dirname(destination), { recursive: true });
  const modules = record(inventory['modules']);
  if (modules[file]) {
    const target = path.join(studio, string(modules[file], 500));
    await writeFile(destination, `export * from ${JSON.stringify(relativeModule(destination, target))};\n`);
    return;
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
    await writeFile(destination, text);
  } else {
    await copyFile(source, destination);
  }
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
  await rm(path.join(studio, 'vendor/stacki'), { recursive: true, force: true });
  const adapters = new Set(paths(inventory['adapters']));
  const files = paths(inventory['files']);
  for (const file of files) {
    await assembleFile(file, adapters);
  }
  const version = string(record(parent)['version'], 50);
  await writeFile(path.join(studio, 'src/shared/release.json'), JSON.stringify({ version }, null, 2) + '\n');
  await writeFile(
    path.join(studio, 'vendor/stacki/PROVENANCE.md'),
    `# Stacki shared source\n\nGenerated from the Stacki ${version} source tree (MIT).\n` +
      'Edit the canonical Stacki source or studio/adapters, then run npm run assemble.\n' +
      'scripts/shared-source.json records the included files and host adapter boundaries.\n',
  );
  console.log(`Assembled ${files.length} shared files for Stacki Studio ${version}.`);
}
