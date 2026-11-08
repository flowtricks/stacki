// `astro-studio build-demo`: the command-line face of bakeSite.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { bakeSite } from '../src/features/bake/bakeDemo';
import { record, string } from '../src/shared/validation';

export async function buildDemo(packageRoot: string, argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { out: { type: 'string' }, base: { type: 'string', default: '/demo/site/' } },
  });
  const project = positionals[0];
  if (project === undefined || values.out === undefined) {
    throw new Error('Usage: astro-studio build-demo <project-directory> --out <directory> [--base /demo/site/]');
  }
  const release = record(JSON.parse(await readFile(path.join(packageRoot, 'src/shared/release.json'), 'utf8')));
  const result = await bakeSite({
    root: path.resolve(project),
    out: path.resolve(values.out),
    base: values.base,
    runtime: path.join(packageRoot, 'dist'),
    studioVersion: string(release['version'], 50),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  console.log(
    `Baked ${result.value.pages.length} pages, ${result.value.sections} style sections, ${result.value.templates} component templates, ${result.value.snapshotBytes} snapshot bytes.`,
  );
  if (result.value.probeFailure !== undefined) {
    // The site still bakes; only component edits fall back to needing Astro.
    console.warn(`Component templates were skipped: ${result.value.probeFailure}`);
  }
}
