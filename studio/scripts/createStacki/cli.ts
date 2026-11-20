import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installNewRelease } from '../../src/features/updates/install';
import { parseRelease, RELEASE_BYTES_MAX } from '../../src/features/updates/release';
import { parseOptions, requireSupportedNode } from './options';
import { installedVersion, projectDirectory, readJson } from './project';
import { isRawInput, keyPrompter, linePrompter, type Prompter } from './prompter';
import { SIGN_IN_FLAGS_HELP, chooseSignIn, configureSignIn } from './signIn';
import { STUDIO_AUTH_KINDS } from '../../vendor/stacki/shared/ipc/studioAuth';

const HELP = `Add Stacki Studio to an existing Astro project.

  npm create stacki@latest [project-directory]
  npm create stacki@latest -- --yes

Options:
  --yes, -y      Install without the confirmation prompt
  --agent       Print a setup prompt for your coding agent; change no files
  --help, -h    Show this help
  --version, -v Show the bundled Studio version

${SIGN_IN_FLAGS_HELP}

Studio is installed in ./studio. Existing installations are never replaced.
`;
const AGENT = `Set up Stacki Studio in this existing Astro project.
If /studio is missing, run npm create stacki@latest -- --yes from the project root.
If it exists, inspect it first; do not overwrite customizations or update silently.
Read studio/AGENTS.md, studio/README.md, and studio/docs/cloudflare.md.
Start the local preview with npm --prefix studio run dev and verify /studio.
Ask me how people should sign in to Studio. The choices are (flag --auth):
  github   GitHub accounts (default; needs the GitHub App from studio/docs/cloudflare.md)
  access   Cloudflare Zero Trust Access in front of Studio. Needs the team domain
           (--auth-team-domain, myteam.cloudflareaccess.com), the Access application's AUD tag
           (--auth-aud) and the first admin's email (--auth-admin). No secrets at all. I create
           the Access application (site hostname + path /studio*, policy allowing my team);
           people must be allowed in Access AND listed in .stacki/roles.json (Roles panel).
  google   Google sign-in. Needs my OAuth client ID (--auth-client-id), optional allowed
           domains/emails, and the first admin's email (--auth-admin).
  oidc     SSO through OpenID Connect. Needs the issuer https URL (--auth-issuer), client ID,
           optional button name, allowed domains/emails, and the first admin's email.
  passkey  Passkeys. Needs nothing; the first admin handle (--auth-admin, default owner)
           registers a passkey, then invites people from Studio settings.
Run npm create stacki@latest -- --yes --auth <choice> plus the flags above, or edit the vars in
studio/cloudflare/wrangler.jsonc (AUTH_PROVIDER, ACCESS_TEAM_DOMAIN, ACCESS_AUD, GOOGLE_CLIENT_ID, OIDC_ISSUER, OIDC_CLIENT_ID,
OIDC_NAME, AUTH_ALLOWED_DOMAINS, AUTH_ALLOWED_EMAILS, AUTH_BOOTSTRAP_ADMIN) and never overwrite an
AUTH_PROVIDER that is already there without asking me.
For google and oidc, tell me to create the OAuth client / OIDC application and register the
redirect URI https://<site>/studio/auth/<google|oidc>/callback, and have me run the secret
command myself in the studio folder: npx wrangler secret put GOOGLE_CLIENT_SECRET (or
OIDC_CLIENT_SECRET) --config cloudflare/wrangler.jsonc. Never ask me to paste a client secret
into chat, a file, a prompt or a log.
Every mode still needs the GitHub App credentials for publishing. Run
node studio/dist/cli.mjs check-project . when done.
Guide me through Cloudflare Containers deployment using
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

// The check Studio ships for a project's own files; it validates the sign-in variables too.
function checkProject(project: string): Promise<{ readonly ok: boolean; readonly output: string }> {
  const cli = path.join(project, 'studio/dist/cli.mjs');
  return access(cli).then(
    () =>
      new Promise((resolve) => {
        execFile(process.execPath, [cli, 'check-project', project], { cwd: project, timeout: 120_000, maxBuffer: 1_000_000 }, (error, out, errors) => {
          resolve({ ok: error === null, output: (out + errors).trim() });
        });
      }),
    () => ({ ok: true, output: '' }),
  );
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
  // A bad flag must fail before anything is installed; so must a missing value without a terminal.
  const interactive = !options.yes;
  if (interactive && !(await confirm(project))) {
    console.log('Cancelled. No files were changed.');
    return;
  }
  const prompter: Prompter | undefined = interactive ? (isRawInput(stdin) ? keyPrompter(stdin, stdout) : linePrompter(stdin, stdout)) : undefined;
  try {
    const signIn = await chooseSignIn(options, prompter);
    if (!signIn.ok) {
      throw new Error(`${signIn.error}. No files were changed. Sign-in choices: ${STUDIO_AUTH_KINDS.join(', ')}.`);
    }
    console.log('Installing dependencies, checking types, and building Studio…');
    await installNewRelease(path.join(project, 'studio'), release);
    console.log(`\nInstalled Stacki Studio ${release.version} in ${path.join(project, 'studio')}`);
    const configured = await configureSignIn(project, signIn.value, prompter);
    console.log('\n2/3 Local preview\nFrom your project root, run: npm --prefix studio run dev');
    console.log('\n3/3 Go live\nFollow studio/docs/cloudflare.md to configure GitHub and Cloudflare.');
    for (const line of configured.lines) {
      console.log(line);
    }
    if (configured.written.kind === 'written') {
      const checked = await checkProject(project);
      console.log(checked.ok ? 'Studio check-project: ok' : `Studio check-project reported problems:\n${checked.output}`);
    }
  } finally {
    prompter?.close();
  }
  console.log('For a prompt to give your agent: npm create stacki@latest -- --agent');
  console.log('Commit /studio to keep this version with your project. Updates are opt-in.');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
