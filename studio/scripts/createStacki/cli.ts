import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { installNewRelease } from '../../src/features/updates/install';
import { parseRelease, RELEASE_BYTES_MAX } from '../../src/features/updates/release';
import { parseOptions, requireSupportedNode } from './options';
import { installedVersion, projectDirectory, readJson } from './project';

const HELP = `Add Stacki Studio to an existing Astro project.

  npm create stacki@latest [project-directory]
  npm create stacki@latest -- --yes

Options:
  --yes, -y      Install without the confirmation prompt
  --agent       Print a setup prompt for your coding agent; change no files
  --help, -h    Show this help
  --version, -v Show the bundled Studio version

Studio is installed in ./studio. Existing installations are never replaced.
`;
const AGENT = `Set up Stacki Studio in this existing Astro project.
If /studio is missing, run npm create stacki@latest -- --yes from the project root.
If it exists, inspect it first; do not overwrite customizations or update silently.
Read studio/AGENTS.md, studio/README.md, and studio/docs/cloudflare.md.
Start the local preview with npm --prefix studio run dev and verify /studio.
Guide me through GitHub authentication and Cloudflare Containers deployment using
studio/cloudflare and the documented setup. Ask me for project-specific choices.
Keep credentials in local secret storage or Cloudflare secrets, never source files.
Preserve website source. Verify local editing before any deployment.
Ask for approval before creating paid resources or deploying anything.
Report external setup that still needs my action. Updates are always opt-in.`;

async function confirm(project: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Use --yes for a noninteractive installation, or --agent for setup instructions');
  }
  const input = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await input.question(`Install Stacki Studio in ${path.join(project, 'studio')}? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    input.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === 'help' || options.mode === 'agent') {
    console.log(options.mode === 'help' ? HELP : AGENT);
    return;
  }
  requireSupportedNode(process.versions.node);
  const release = parseRelease(await readJson(fileURLToPath(new URL('./stacki-studio.json', import.meta.url)), RELEASE_BYTES_MAX));
  if (options.mode === 'version') {
    console.log(release.version);
    return;
  }
  const project = await projectDirectory(options.directory);
  const installed = await installedVersion(project);
  if (installed) {
    console.log(`Stacki Studio ${installed} is already installed. No files were changed.`);
    console.log('Open Studio to manage its version. Run npm --prefix studio run dev in this project.');
    return;
  }
  console.log(`Stacki Studio ${release.version} — 1/3 Install`);
  if (!options.yes && !(await confirm(project))) {
    console.log('Cancelled. No files were changed.');
    return;
  }
  console.log('Installing dependencies, checking types, and building Studio…');
  await installNewRelease(path.join(project, 'studio'), release);
  console.log(`\nInstalled Stacki Studio ${release.version} in ${path.join(project, 'studio')}`);
  console.log('\n2/3 Local preview\nFrom your project root, run: npm --prefix studio run dev');
  console.log('\n3/3 Go live\nFollow studio/docs/cloudflare.md to configure GitHub and Cloudflare.');
  console.log('For a prompt to give your agent: npm create stacki@latest -- --agent');
  console.log('Commit /studio to keep this version with your project. Updates are opt-in.');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
