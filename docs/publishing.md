# Publishing from Desktop and Studio

Desktop's hosting menu shows **Changes to deploy** until the current project matches its last
successful deployment, and **Up to date** when it does. The separate arrow opens the detected
published site, preferring a custom domain over a Workers, Pages, or Vercel domain. Discovery
runs independently when the menu opens, so provider outages do not delay local change checks.
The arrow is omitted when the URL cannot be detected, and remains usable when deployment is
already current.

Desktop's Publish button saves to GitHub and deploys to the configured host. The attached arrow
also offers **Push to GitHub**, **Deploy to hosting**, and **Publish settings**.
GitHub-only commits and pushes without a local build, publish hooks, or a second project checkout.
The main Publish action does the same when hosting is set to `none`. It does not require
`node_modules`; a host connected to GitHub can perform its own build after the push.
Actions that deploy to hosting still build an isolated snapshot first. Hosting-only never creates
a GitHub commit or advances Studio's published GitHub baseline. Studio also skips builds and
hooks for GitHub-only actions, including Publish with hosting set to None.

Before Desktop commits, it checks the selected remote branch for incoming commits. Incoming
changes stop publishing and direct you to **Pull from GitHub** in the branch menu. Publishing
never automatically merges, rebases, or stashes local edits. A remote change after this check can
still reject the push; the local commit remains available for review and a later retry.

Desktop disables each action when its destination is current. GitHub is current when there
are no local changes and the branch matches its origin tracking reference. Hosting is checked
separately against the exact source tree and settings from the last successful Desktop
deployment. That confirmation survives restarts in Git's private `stacki-deployment.json`;
it never becomes a project change. Deployments made outside Desktop are not assumed current.
Unknown status and failed deployments keep the action available.

When every configured destination is current, Publish is disabled with an
“All changes are up to date” hover tooltip. The dropdown shows the same message and keeps
Publish settings accessible. Edits, completed publishing, and returning to the window refresh
the status; periodic checks also catch Git operations outside the editor.

Settings live in the tracked `.stacki/publish.json` file. Desktop and Studio read the same
versioned schema, and Studio includes it in its GitHub commits and incoming synchronization.
Publishing can import a single complete existing hosting link without opening settings.
A settings conflict requires reloading rather than overwriting
someone else's changes.

## GitHub accounts

Connect a repository from Publish settings or Desktop's branch menu. Install GitHub CLI, then
choose **Add account** beside GitHub account. Stacki displays a one-time code and opens GitHub's
browser sign-in page. Choose the account to add there; the account picker refreshes when sign-in
finishes. Cancelling stops the pending sign-in. Local Studio supports the same flow; hosted
Studio uses its managed GitHub connection. Running `gh auth login` manually also works.
In Publish settings, choose the account to use for this project.
Stacki obtains that account's existing credential using `gh auth token --user`; it never calls
`gh auth switch` or changes global Git configuration. The credential is passed only to the
Git/GitHub child processes. A pinned account also applies to the branch menu's Push, Create,
and Connect operations. The publish repository picker uses the selected account's credential.

Without a pinned account, normal Git authentication applies, including SSH. Studio continues
to use its repository's GitHub App installation; personal Desktop credentials are never copied
to Studio or committed to the project.

## Hosting

Cloudflare Pages needs an existing Pages project, account ID, production branch, and build
output directory (usually `dist`). Choosing **Add account** for Cloudflare in Desktop or local
Studio installs a missing project Wrangler with the site's package manager, then starts browser
sign-in automatically. This updates the site's package manifest and lockfile so future
deployments can use the same dependency. Cancel during installation skips sign-in but lets the
installation finish. Existing project or workspace installations are reused. Installation
failures can be retried; account discovery and deployment never install packages implicitly.
Alternatively, install Wrangler and run `wrangler login` once locally, or provide
`CLOUDFLARE_API_TOKEN` in the server environment. The account ID is explicitly supplied on every
deployment, so another project's account choice does not change this project's target.

Vercel needs an existing project ID and organization/team ID. These are available in
`.vercel/project.json` after linking. Install the Vercel CLI in the site's development dependencies
or on the publishing machine. Use `vercel login` locally or provide `VERCEL_TOKEN` on the server.
Stacki supplies `VERCEL_PROJECT_ID` and `VERCEL_ORG_ID` for every production deployment.
Vercel performs its own deployment build after Stacki's local validation build.

Hosted Studio passes the optional Worker secrets `PUBLISH_CLOUDFLARE_API_TOKEN` and
`PUBLISH_VERCEL_TOKEN` to its publishing container. Its image includes Wrangler; add Vercel
to the site's development dependencies and rebuild the Studio image when selecting Vercel.
Credentials must be provisioned independently on each machine. They do not belong in
`.stacki/publish.json`. No CLI is silently downloaded during a publish.

“GitHub only” skips Stacki's direct deploy command. If Cloudflare, Vercel, or GitHub Actions
already deploys on push, that automation still runs. Disable the provider's automatic builds
when using direct publishing to avoid duplicate deployments. Leave the provider set to
“GitHub only / existing automation” to retain an existing Git-triggered deployment.

## Advanced automation

Choose a build script and up to eight package.json scripts before and after publishing:

```json
{
  "version": 1,
  "githubAccount": "my-account",
  "hosting": {
    "provider": "cloudflare",
    "accountId": "your-account-id",
    "project": "my-site",
    "branch": "main",
    "directory": "dist"
  },
  "buildScript": "build",
  "beforePublish": ["check"],
  "afterPublish": ["search:index", "cache:purge"]
}
```

Scripts run sequentially inside the publish snapshot using `npm run`. A failed command stops
subsequent commands. On Desktop and Studio, scripts run only for actions that deploy to hosting;
after scripts run after all selected destinations succeed. `STACKI_PUBLISH_TARGET` tells hooks which action was selected. Use hooks for
tasks such as search indexing or cache purging after a hosting deployment.
Write idempotent hooks: Studio may rebuild a snapshot when GitHub changes concurrently.
Generated source inside the temporary snapshot is not written back to the editor or GitHub.

Migration: GitHub-only publishing previously ran the build and both publish hooks in both hosts.
Existing script settings are preserved, but GitHub-only now skips them. Move required GitHub
checks or automation to the host/CI workflow, or select a configured hosting deployment when
those scripts must run locally. Scripts are never moved into the live working directory.

Desktop captures tracked and unignored project files through a separate Git index. Ignored
files, including local `.env` files, are not automatically copied; supply build secrets through
the publishing process environment. Desktop checks the source tree, branch and HEAD before
committing and pushes the exact captured commit. Source changes stop the job for a retry.
Studio captures immutable Git objects while the collaboration coordinator holds edits. GitHub-only
publishing does not create a second checkout, require dependencies or execute scripts. Hosting
builds use a separate copy, with copy-on-write where supported; collaborators can continue editing
after capture. Git pushes transfer only objects missing from the destination, instead of sending
all file contents through the Worker as base64 or creating one GitHub API blob per file.

Desktop Git inspection is bounded to 100,000 files and 8 GiB of source, allowing photo-heavy
projects without an extra checkout. Hosting snapshots retain their 10,000-file and 256 MiB
limits because they duplicate source on disk. Both paths stream NUL-separated Git records with
16 KiB per record, bounded buffering and a ten-minute inspection timeout. Snapshot sizes are
checked against the captured Git blobs as well as working files. GitHub status uses the Git
inspection budget, not the hosting snapshot budget. These are Stacki resource budgets;
GitHub and hosting providers may enforce additional limits.

Studio supports up to 100,000 captured files / 8 GiB of source and 100 MiB per file. Hosting copies
have a separate 2 GiB source budget and reserve space for another output copy plus 1 GiB of free
disk. The source budget does not guarantee sufficient disk or a successful build. Provider limits
still apply, including Cloudflare's 25 MiB per static asset. Studio directory traversal is limited
to 10,000 directories and 64 levels. Existing upload and active draft limits remain separate.

Hosted Studio restores the baseline through Git directly to disk; there is no 100 MB archive
buffer. New container templates use `standard-2` (1 vCPU, 6 GiB RAM, 12 GB disk), with one instance
and the existing three-minute idle sleep. Existing deployments preserve their configuration:
change `instance_type` when needed, then rebuild and redeploy the Worker and container together.
Native Git must be installed for local Studio; it is already installed in the supplied image.

Build and hook commands have a ten-minute timeout and a 1 MiB output limit. Commands run without
interactive input. GitHub and hosting are separate external operations: if hosting or an after
hook fails after a successful push, the GitHub commit remains. Inspect completed actions and
use hosting-only when retrying a deployment. Publishing never force-pushes or rolls back a host.

Provider setup references: [GitHub account tokens](https://cli.github.com/manual/gh_auth_token),
[Cloudflare direct upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/),
and [Vercel CLI project settings](https://vercel.com/docs/cli/global-options).

## Discovering connected accounts and projects

Publish settings lists hosting projects grouped by connected account. Selecting a
Cloudflare Pages project fills its account ID, project name, production branch and build directory.
Vercel discovery groups team projects and fills both IDs. Existing `.vercel/project.json`
links can be imported even before signing in on that machine. Wrangler JSON, JSONC and TOML project
configuration is also recognized; Cloudflare supplies the actual production branch. Manual
configuration remains available for unusual layouts, restricted tokens and older CLI versions.

The form reads saved settings before discovering hosting, so GitHub can load independently.
Saved selections remain visible while remote lists refresh. Successful account and hosting discovery
results are reused for one minute in a bounded, project-specific renderer cache; Refresh bypasses
cached results. Failed or partial discovery is retried on the next open. Settings files and repository
revisions are read fresh so cached discovery cannot hide external edits or stale connection checks.
Choosing a hosting provider cancels automatic prefilling, including when choosing GitHub only.
The publish menu uses the same discovery and shows the detected provider. Clicking Publish or
Deploy to hosting imports a single complete existing link into missing publish settings and starts
the job immediately. Ambiguous links and unresolved accounts still open settings; saved choices,
including GitHub only, take precedence. Closing settings immediately refreshes Desktop deployment
status, so a saved provider cannot keep showing “Choose a hosting provider” during the next check.

Install current Wrangler, Vercel CLI or GitHub CLI and sign in once on the publishing machine.
GitHub discovery lists healthy saved accounts; selecting one pins that username for this project.
Discovery never switches the globally active GitHub account or Vercel team. Hosted Studio uses the
server's provider connection; it cannot read a visitor's laptop credentials. Studio still uses its
GitHub App for publishing. This is built into Stacki; no Codex connector is required.

Provider reads are bounded to 30 seconds per request, 1 MiB per response and 500 projects across at
most twenty accounts (fifty Pages pages or five Vercel pages per account). Over-limit or unauthenticated responses show a retry/manual-setup path. Credentials
and raw provider logs are never returned through IPC or HTTP, or written into project metadata.
Wrangler's authenticated token is used only in server memory for the Cloudflare project lookup.
Vercel's [authenticated API command](https://vercel.com/docs/cli/api) and GitHub's
[account status command](https://cli.github.com/manual/gh_auth_status) reuse CLI sign-ins.

Repository settings show the current Git origin separately from the selected authentication account.
Choose another writable repository and save to change the origin. Add repo creates an empty private
repository by default; saving connects it, and Publish uploads files. No global GitHub account switch
is needed. Hosted Studio shows its deployment-managed repository without allowing it to be changed.

Refreshing connections keeps the current fields in place and shows a spinner in the header.

Cloudflare Workers use the existing Wrangler configuration and `wrangler deploy --name`, retaining
routes, bindings, and asset settings. A first-time settings panel detects root Wrangler files and
prefills their Worker name. When the file omits `account_id`, discovery checks up to five connected
accounts for a unique matching Worker. An unavailable or ambiguous account remains unselected;
saving requires choosing the Worker from its account group. Existing saved provider preferences always take precedence.

The provider picker presents Cloudflare once. Its project list includes Pages and Workers, grouped
by account, with a small deployment-type label. Choosing a project selects its account implicitly;
the Cloudflare account picker also lets you switch accounts and filters the project list.

Cloudflare’s **Add account** opens a cancellable browser sign-in using installed Wrangler.
Approve access with the desired Cloudflare login, then choose an account from the refreshed list.
This updates the local Wrangler login; managed Studio keeps server authentication read-only.
**Add Worker** stages a new Worker name in the selected account. Saving selects that destination;
the next publish creates it using the project’s existing Cloudflare configuration. It does not
create a placeholder deployment or upload files during settings changes.

Worker publishing applies the chosen account to a temporary sibling of the effective Wrangler
configuration, including build-generated configurations. This is necessary because Wrangler can
prefer the configuration’s account ID over the environment. Relative asset and entry paths are
preserved, authored files stay unchanged, and the temporary configuration is removed afterward.
