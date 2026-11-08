import { checkProject } from './checkProject';
import { projectScripts } from './projectScripts';
import { record } from '../src/shared/validation';
import { updateStudio, checkStudioUpdate } from './update';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { startDraft } from './dev';
import { buildDemo } from './buildDemo';
import { BAKE_CHILD_COMMAND } from '../src/features/bake/bakeBuild';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const command = process.argv[2];
if (command === 'check-project') {
  await checkProject(path.resolve(process.argv[3] ?? '.'));
} else if (command === 'update') {
  await updateStudio(process.argv.slice(3));
} else if (command === 'check-update') {
  await checkStudioUpdate();
} else if (command === 'dev') {
  const project = path.resolve(process.argv[3] ?? process.env['STUDIO_PROJECT'] ?? '.');
  const port = Number(process.env['PORT'] ?? 4350);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PORT must be between 1024 and 65535');
  }
  await startDraft(packageRoot, project, port);
} else if (command === 'build-demo') {
  await buildDemo(packageRoot, process.argv.slice(3));
} else if (command === BAKE_CHILD_COMMAND) {
  // A build-demo child: bakeBuild.ts, bundled into this file, answers its parent.
} else if (command === 'init-cloudflare') {
  const destination = path.resolve(process.argv[3] ?? 'studio-cloudflare');
  let existing = false;
  try {
    await access(destination);
    existing = true;
  } catch {
    /* A new directory is required. */
  }
  if (existing) {
    throw new Error('Choose a new deployment directory; existing files will not be overwritten');
  }
  await mkdir(destination, { recursive: true });
  for (const file of [
    'package.json',
    'package-lock.json',
    'Dockerfile',
    '.dockerignore',
    'templates',
    'src',
    'scripts',
    'vendor',
    'tsconfig.json',
    'tsconfig.worker.json',
    'README.md',
    'AGENTS.md',
    'docs',
    'LICENSE',
  ]) {
    await cp(path.join(packageRoot, file), path.join(destination, file), { recursive: true });
  }
  await cp(path.join(packageRoot, 'templates/cloudflare'), path.join(destination, 'cloudflare'), {
    recursive: true,
  });
  const manifest = path.join(destination, 'package.json');
  const value = record(JSON.parse(await readFile(manifest, 'utf8')));
  value['scripts'] = projectScripts;
  await writeFile(manifest, JSON.stringify(value, null, 2) + '\n');
  console.log(`Cloudflare deployment template created in ${destination}. Configure cloudflare/wrangler.jsonc and secrets using the deployment guide.`);
} else {
  console.log(
    'Astro Studio\n\n  astro-studio dev [project-directory]\n  astro-studio init-cloudflare [new-directory]\n  astro-studio build-demo <project-directory> --out <directory> [--base /demo/site/]\n\nastro-studio check-project [project-directory]\n  astro-studio check-update\n  astro-studio update <project> <exact-version-or-release.json> --replace-customizations\n\nPORT overrides 4350. STUDIO_WORKSPACE selects the draft workspace.',
  );
}
