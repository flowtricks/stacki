// The handoff deliberately contains no account identifiers, credentials or
// computer paths. The agent reads project-specific information in the project.
export function studioSetupPrompt(
  version: string,
  options: { readonly installed: boolean },
): string {
  const releaseBase = `https://github.com/flowtricks/stacki-releases/releases/download/v${version}`;
  const installation = options.installed
    ? 'Studio is already installed in ./studio. Preserve its current version and configuration.'
    : `Install Stacki Studio ${version} in ./studio from the official release bundle at
${releaseBase}/stacki-studio-${version}.json.
If the bundle is not published, explain that and ask for a trusted release bundle. Do not invent
an npm package or copy a developer's working Studio folder. Never overwrite an existing
studio folder.
Validate the release paths and version before extracting. Copy templates/cloudflare to cloudflare
for a new installation. Use the package's lockfile and scripts.`;
  return `Set up Stacki Studio for this Astro project, including local preview and hosted editing.

${installation}
Read studio/AGENTS.md, studio/README.md, studio/docs/cloudflare.md and
studio/docs/releases.md first.
Preserve website source, content, assets and the current public site's behavior.

1. Check Node.js >=22.19 and npm. In studio run npm ci --ignore-scripts, npm run check and npm run
build. Stacki's website preview opens Studio on the main localhost port at /studio and saves
directly to website source; it needs no Cloudflare setup. Verify a temporary edit and restore it.
For isolated hosting tests, npm --prefix studio run dev uses a separate draft workspace.
Keep hosted drafts separate from the published site.
2. Inspect this project's Git remote and deployment pipeline. Ask which GitHub repository/branch,
Cloudflare account, public website domain, Studio URL and isolated preview origin to use if unclear.
Explain Cloudflare Workers Paid/Containers and R2 requirements and Docker or a remote image build.
Consult current official Cloudflare and GitHub docs before provisioning.
3. Guide me through registering and installing my own GitHub App for only this repository, with
Contents read/write and Metadata read. Set the OAuth callback to the Studio origin plus
/studio/auth/callback. Configure app/client/installation IDs and repository access controls.
Use public App registration if collaborators outside the owner account must authorize it.
4. Configure studio/cloudflare from the included templates. Create distinct resource names,
a private R2 bucket, the container/Worker bindings, Studio routing and the isolated authenticated
preview origin. Integrate the public site gateway and deployment revision endpoint according to
the guide. Preserve existing routes and hosting; present the proposed routing changes for review.
5. Guide me through entering GITHUB_PRIVATE_KEY, GITHUB_CLIENT_SECRET, SESSION_SECRET and
CONTAINER_TOKEN using Wrangler secret prompts. Generate independent random values of at least
32 bytes for the last two. Never put secrets in source, prompts, logs or public environment vars.
Ignore .studio/, .stacki/studio/, .wrangler/, .env*, .dev.vars* and node_modules/ in Git and Docker.
Do not reuse another project's credentials, account IDs, drafts or saved browser sessions.
6. Validate the Worker bundle and real container image build. Ask before provisioning billable
resources or deploying. Deploy only after configuration and access controls are reviewed.
A Worker-only dry run is not proof that the Container builds or works.
7. Verify authenticated login, denied unauthorized access, editing in two browsers, uploads,
container restart and private R2 recovery. Confirm Publish commits to the intended branch and
the website deployment reports that revision. Try a failed build and confirm the live site remains
unchanged. Never expose the Container directly. Report unverified steps clearly.
8. Leave concise project-specific setup, deployment and recovery instructions. Studio updates are
opt-in and replace Studio customizations while preserving project configuration and runtime data.
Do not automatically upgrade Studio or publish website edits during setup.

If I must complete an account authorization or enter a secret myself, give me the exact next step
and continue with independent work. Optional AI provider setup can wait until Studio is working.`;
}
