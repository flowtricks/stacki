# Deploying a studio to Cloudflare

## Hosting

Each project uses its own Cloudflare resources and GitHub App installation. Configure
account usage notifications before deployment; alerts are not spending caps. This
source distribution does not create resources or claim that an account is configured.

### Cost controls

- Website dependencies are installed into the deployment image and reused when the repository lockfile matches. Changed lockfiles use a cached install fallback. Ordinary cold starts restore drafts and start Astro without reinstalling packages.
- One shared standard-2 Container (1 vCPU, 6 GiB RAM, 12 GB disk); ten-minute sleep timeout after connections close (a return within ten minutes finds it warm; see [startup timing](../../docs/studio-startup-timing.md)).
- The editor pauses when its tab is hidden, or after five minutes without interaction,
  once saves and requests finish. Pausing removes preview iframes and closes collaboration
  connections before background tabs can freeze their timers. Resume reconnects the draft
  and obtains a fresh preview login.
- Connections without incoming application traffic expire after 90 seconds, including
  previews and clients that never answered a heartbeat. Outgoing heartbeats cannot renew
  their own lease and keep an abandoned container running.
- GitHub sync checks are sequential, at most once per minute per active editor, and skipped in hidden tabs.
- Collaboration broadcasts and local previews update immediately. Durable snapshots batch over two seconds; unchanged snapshots are not uploaded again. Saved is acknowledged only after persistence succeeds.
- Reconnection uses exponential backoff up to a minute; edit queues are bounded.
- Uploads are limited to 20 MB each, 200 public asset files, and 100 MB total. Publishing reads existing repository assets separately: up to 100,000 files / 8 GiB for GitHub and 2 GiB of source for isolated hosting builds, with a ten-minute command timeout. These budgets do not raise the separate draft-upload limits.
- Workers have 50 ms CPU limits; paid request logging/tracing stays disabled. Unauthenticated requests cannot start the Container. Public site assets stay separate from editor compute.

These reduce accidental use; they are not a monthly spending cap. Active editors, abusive traffic, other account resources, storage operations, and subscription fees can still increase the bill. Check any other account resources and subscriptions separately.

The Cloudflare configuration explicitly disables Observability by default to avoid diagnostic
logging charges. Existing installations preserve their configuration during Studio updates; set
`"observability": { "enabled": false }` in their `studio/cloudflare/wrangler.jsonc` and redeploy
to apply the same default. This does not change the account's Observability subscription.

### Interactive editing capacity

Keep at least the template's one-vCPU capacity for a substantial Astro project with concurrent
editors. A `basic` instance has only a quarter vCPU: compilation, route scanning and rendering
compete with the collaboration connection for that CPU budget. Streaming text before saving does
not remove this contention. Measure sustained typing with two sessions and the actual project
before reducing the instance size; a small fixture or one isolated edit can hide growing delays.

Project configuration survives Studio updates, so an existing `basic` override stays in effect
even when the main template uses `standard-2`. A custom one-vCPU instance requires at least 3 GiB
RAM. Review [Cloudflare's limits](https://developers.cloudflare.com/containers/platform/limits/)
and [usage pricing](https://developers.cloudflare.com/containers/platform/pricing/) before changing
an existing deployment. CPU is billed by actual use; provisioned RAM and disk cost money while
the container is active. More CPU does not guarantee a particular latency over the network.

## Deployment layout

Keep Studio at `studio/` inside the website repository. Its `cloudflare/wrangler.jsonc`
contains project-specific configuration and is preserved by Studio updates. The public
website and CMS Worker have separate deployments. A site gateway can forward `/studio`
and its child routes through a service binding to the CMS Worker; other paths continue
serving the published website. Preview uses an isolated hostname.

For a Container deployment, configure the build root as `studio`, build command
`npm run build`, and deploy command `npx wrangler deploy --config cloudflare/wrangler.jsonc`.
A `wrangler deploy` you run by hand or in your own pipeline is outside Stacki's control and sends Wrangler's metrics unless you set `WRANGLER_SEND_METRICS=false` or run `wrangler telemetry disable` once.
Website deployment remains controlled by the website's own configuration. Accepting a
Studio update creates a review branch; merge and redeploy the CMS to activate it.

Each build writes `dist/.assetsignore` to exclude JavaScript and CSS source maps from
Cloudflare's static asset upload. Maps remain available locally for debugging; a map
larger than Cloudflare's 25 MiB per-asset limit does not prevent deployment. Runtime
editor assets still need to fit that limit.

## Requirements

Use a Cloudflare account with Workers Paid and Containers enabled, Docker, a GitHub repository containing the Astro site, and a GitHub App installed on that repository. The site must have `package-lock.json` and a working `npm run build` script. Each developer deploys these resources into their own account.

See Cloudflare's [Containers setup guide](https://developers.cloudflare.com/containers/get-started/) and [Container class reference](https://developers.cloudflare.com/containers/api/container-class/). Pricing and available instance types should be checked in the account before deployment.

## Routing

Use `https://example.com/studio` for the editor and a sibling subdomain such as `https://preview.example.com` for the authenticated preview. Use the same registrable domain so iframe cookies remain same-site. Never run untrusted page scripts on the studio origin in production.

Edit `cloudflare/wrangler.jsonc`:

- Set `STUDIO_ORIGIN`, `PREVIEW_ORIGIN`, repository, branch, App ID, installation ID, and GitHub client ID.
- Set `EDITOR_ACCESS` to `repository` to let accepted collaborators with Write or Admin access sign in. Invite them through GitHub’s repository Settings → Collaborators; pending invitations and read-only access do not grant editing. GitHub permissions and numeric identity are verified, with permission results cached for up to five minutes. Collaboration sockets reconnect every five minutes, so removals take effect within roughly ten minutes.
- For temporary open testing, set `EDITOR_ACCESS` to `github`. Anyone who completes GitHub sign-in can edit and publish the shared site without a repository invitation. Signed sessions are still required for the editor, API, preview, and collaboration connections. The supplied template defaults to `repository` mode.
- To end open testing, change `EDITOR_ACCESS` back to `repository` and redeploy the CMS Worker. Existing tester sessions are checked against repository permissions on their next request; open collaboration connections are checked on their next authorization renewal (normally within five minutes). Testing access is never stored in a session or permission cache.
- For a manually managed studio allowlist instead, omit `EDITOR_ACCESS` and set `EDITOR_GITHUB_IDS` to comma-separated numeric GitHub IDs.
- To sign people in with something other than GitHub (Google, email codes, SSO, passkeys), add your own provider in `cloudflare/auth-provider.ts`; it survives Studio updates. GitHub stays the default and nothing changes without that file. This interface is **experimental and may change in minor versions**; see [authentication providers](auth-providers.md). With another provider, `EDITOR_ACCESS` can also be `authenticated` (any person the provider verifies); `github` and `repository` apply to GitHub sign-in only.
- Choose a private R2 bucket name and create it. This bucket stores shared draft state and draft assets; it is not the default published-content database.
- Route `example.com/studio*` to this Worker while retaining the existing website's normal routing. Route the preview hostname to this Worker for all paths. Configure these routes/custom domains in your Cloudflare zone according to the website's existing Pages/Workers hosting setup.
- Keep one Container instance for the shared project. The supplied `standard-2` instance and ten-minute sleep timeout (`CONTAINER_SLEEP_AFTER` in `src/cloudflare/worker.ts`) are starting values to measure with your site's dependencies.
- Opening the authenticated Studio page starts preview restoration while the editor assets download; once Astro answers, the container reads the project catalog and compiles the home page before the editor asks for either. Drafts and uploaded assets restore in batches of four. The canvas shows a loading state and retry control while waiting, then appears when its editing bridge is ready without waiting for every image. Sleeping containers still incur a cold start.
- Studio startup shows an animated progress bar, the container's real stage (starting, repository, drafts, dependencies, preview server, first page) with a step count, and elapsed time after twenty seconds. The stage comes from `/studio/api/startup`, which the Worker answers without waiting for the container. Retry appears after ninety seconds. Workspace requests retry up to three times with a twenty-second limit per attempt; a visible Retry control recovers from stalled or failed startup without reloading the whole site.

## Choosing a sign-in type

Studio signs people in with **GitHub** unless you choose another type. Setup asks once, and you can change it later.

| Choice               | `AUTH_PROVIDER` | Non-secret vars (`cloudflare/wrangler.jsonc`)                                                       | Secret (`wrangler secret put`)                       |
| -------------------- | --------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| GitHub (default)     | absent          | none                                                                                                | none                                                 |
| Cloudflare Access    | `access`        | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `AUTH_BOOTSTRAP_ADMIN`                                          | none                                                 |
| Google               | `google`        | `GOOGLE_CLIENT_ID`, optional `AUTH_ALLOWED_DOMAINS` / `AUTH_ALLOWED_EMAILS`, `AUTH_BOOTSTRAP_ADMIN` | `GOOGLE_CLIENT_SECRET`                               |
| SSO (OpenID Connect) | `oidc`          | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, optional `OIDC_NAME`, allow-lists, `AUTH_BOOTSTRAP_ADMIN`          | `OIDC_CLIENT_SECRET` (none for a public PKCE client) |
| Passkeys             | `passkey`       | `AUTH_BOOTSTRAP_ADMIN`                                                                              | none                                                 |

- **Where to choose.** `npm create stacki@latest` asks "How should people sign in to Studio?"; scripts pass `--auth github|access|google|oidc|passkey` with the value flags (`npm create stacki@latest -- --help`). In Desktop, **Settings → Stacki Studio → Add to project** asks the same question, and **Change** next to the current sign-in type edits it later. All of them write the same variables with a surgical edit of `cloudflare/wrangler.jsonc`: comments, other variables and an existing `AUTH_PROVIDER` you set yourself are left alone unless you agree to replace it.
- **Secrets are never asked for.** Setup and Desktop only print the `wrangler secret put` command (run it from the `studio` folder, as in the next section). Client secrets never enter a prompt, a file or a payload.
- **Redirect URI.** Register `https://<your-site>/studio/auth/google/callback` (Google) or `https://<your-site>/studio/auth/oidc/callback` (SSO) with the identity service. Create a Google OAuth client of type Web application, or an OIDC application at your identity provider.
- **First administrator.** `AUTH_BOOTSTRAP_ADMIN` is a qualified identity such as `google:me@example.com`, `oidc:me@corp.com`, `access:me@corp.com` or `passkey:owner`. It is required for every type except GitHub, so someone can administer. Passkey people are invited later from Studio settings.
- **Cloudflare Access.** Create a Zero Trust Access application covering the site's hostname and the path `/studio*` (or enable Access on the `workers.dev` route) with a policy that allows your team, then use its team domain (`myteam.cloudflareaccess.com`; a custom domain needs an explicit confirmation) and its application AUD tag. People must be **both** allowed in the Access policy **and** listed in `.stacki/roles.json`; invite them from the Roles panel.
- **GitHub App credentials stay required in every mode**, because publishing commits through the GitHub App.
- **After switching** people need new credentials or invites, and existing sessions stop working on the next deploy. `astro-studio check-project` validates the result.

Runtime behaviour of each type is documented in [authentication providers](auth-providers.md).

## GitHub App and secrets

Create a GitHub App with repository Contents read/write and Metadata read access. Install it on the selected website repository. Configure the OAuth callback as `https://example.com/studio/auth/callback`. Generate an App private key and an OAuth client secret. Clients sign in with GitHub; they do not receive the installation key. Sessions last eight hours. The account menu shows the signed-in GitHub account and provides Sign out. Presence avatars come from verified numeric GitHub identities; local loopback development displays Local and does not require sign-in.

For collaborators outside the app owner's account, make the **GitHub App registration public** under Developer settings → GitHub Apps → Advanced. [GitHub restricts authorization of private Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private). Public registration exposes the app's identity and permits installation by other accounts; it does not make the website repository public or bypass the studio's repository permission check. Keep the installation limited to the selected website repository.

Register your own GitHub App for this project; the release bundle does not include an App registration or credentials. The website repository can remain private. Open the Stacki logo menu at the top left of the studio to see your signed-in account or sign out; profile pictures appear in the collaborator group.

If GitHub returns HTTP 429 during sign-in, the studio honors its `Retry-After` or rate-limit reset header and otherwise waits at least one minute. A signed, HTTP-only cooldown cookie blocks repeated login attempts from that browser during the wait; no automatic token-exchange retries run. Afterward, start a fresh sign-in instead of refreshing the callback URL. Existing valid studio sessions are reused. Safe failure references distinguish token exchange, profile lookup, and repository authorization without logging codes or tokens. See [GitHub's rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors). Repository Write access alone cannot clear GitHub's upstream rate limit.

Sign-in uses the existing project Durable Object to coordinate callbacks without starting the
preview Container. Concurrent callbacks share one exchange; a consumed state stays consumed after
a Worker restart. Only state identifiers and expiration times are persisted, with at most 128
attempts retained for ten minutes. HEAD requests and browser prefetches never start OAuth.
These controls prevent duplicate exchanges; GitHub can still enforce upstream limits independently.

Store these through Wrangler's secret prompts, not checked-in files:

```sh
npx wrangler secret put GITHUB_PRIVATE_KEY --config cloudflare/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put CONTAINER_TOKEN --config cloudflare/wrangler.jsonc
```

Use independent cryptographically random values of at least 32 bytes for the final two secrets. The App private key may contain actual newlines or escaped `\n` sequences. Never put these credentials in the Astro site's public environment variables.

Optional AI configuration: set `AI_BASE_URL` and `AI_MODEL` in Worker vars; use a secret for `AI_API_KEY` if your provider requires one. `AI_BASE_URL` is the OpenAI-compatible base URL, typically ending in `/v1`; the gateway appends `/chat/completions`. Without a provider, the AI panel explains the missing configuration. The endpoint must use HTTPS and be reachable from the Worker. A local model on your laptop is only usable in local development unless you intentionally host an authenticated reachable endpoint.

## CMS connections

Editors connect a site's Sanity project from the CMS panel's **Connect a CMS** row by pasting
an Editor key. The Worker keeps connections in the `DRAFTS` R2 bucket at
`cms/connections.json`, each key encrypted (AES-GCM) under a key derived from `SESSION_SECRET`.
Neither R2, the container nor the browser holds a usable key: the Worker decrypts it for one
connected-CMS request and passes it to the container with that request alone. Anyone who can
edit may use a connection; only GitHub Write or Admin collaborators may add or remove one.

Rotating `SESSION_SECRET` makes saved keys unreadable; add the connections again afterwards.
A local Studio (`npm run dev`) keeps its connections in the user's home folder
(`~/.stacki/studio-cms/`), never in the project.

From the website’s `studio/` directory, or a directory produced by `astro-studio init-cloudflare`:

```sh
npm install
npm run build
npx wrangler r2 bucket create YOUR_BUCKET_NAME
npx wrangler deploy --dry-run --config cloudflare/wrangler.jsonc
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

Only execute the final deployment after filling the configuration. `--containers-rollout=none --dry-run` checks the Worker bundle but does not validate or deploy the Container.

Connect the configured GitHub branch to your normal Cloudflare deployment pipeline. Publish creates a direct GitHub commit after validating a snapshot. Studio tracks preparation, build, commit, cleanup, and live deployment. The public gateway reports its deployed Git revision at `/__studio-deployment` with caching disabled. Set `SITE_DEPLOYMENT_URL` to that endpoint to enable live verification. Studio only reports live success when the deployed revision exactly matches the publish commit; an unconfirmed deployment remains pending after a bounded wait.

When Cloudflare Workers Builds already deploys the connected branch, set
`GITHUB_DEPLOY_WORKER` to the public site's Worker name and `GITHUB_DEPLOY_ACCOUNT` to its account
ID, alongside `SITE_DEPLOYMENT_URL`. For that exact hosting destination, Studio commits once and
waits for the matching live revision. It skips the duplicate container build and direct Wrangler
upload, so no container publishing token is needed. The saved hosting choice stays intact.
Use the main Publish action for this workflow; hosting-only cannot publish an uncommitted draft.
Configure custom build commands and hooks in Workers Builds instead of Studio's local hooks.
Other hosting destinations continue using their configured local build and deployment commands.

Before inviting clients, verify GitHub login and denied access for an uninvited account; edit with two browsers; interrupt and restart the Container and confirm R2 recovery; upload an image; publish a successful revision; try a failing site build; push a conflicting GitHub edit; and verify both desktop and phone behavior on the actual custom domains.

Do not enable public access to the preview Container directly. The Worker is its authentication and origin boundary. The internal storage/AI/GitHub routes require the Container token.

### App frames and signed file links

App frames are sandboxed without `allow-same-origin`, so their own loads (stylesheets, scripts,
the SDK) carry no session cookie. A signed-in load of `/studio/api/apps/files/<id>/<file>`
therefore redirects to `/studio/api/apps/files/<id>/~<expires>.<signature>/<file>`, and the
frame's relative loads stay under that link. A link serves GET and HEAD for that one app's folder,
on the Studio host only, for at most eight hours and never past the session that made it. Every
other request under it answers 404. The Worker forwards it to the container with the container
token alone, no user. The signature is an HMAC under a key derived from `SESSION_SECRET` for this
purpose, so rotating the secret ends every link. Anyone holding a link can read that app's
bundle until it expires, which is exactly what the frame's own code can read. Bundle files are not
made public, because a bundle is not guaranteed to be free of secrets.
`src/cloudflare/appFileLinks.ts` states the full threat model. A top-level file or folder whose
name starts with `~` cannot be loaded from an app folder.

### Identities and project roles

The Worker forwards the signed-in GitHub login as `x-studio-user`, and the container trusts
it only alongside the container token. Project roles (`.stacki/roles.json`) name GitHub logins,
and the container parses every forwarded login as a GitHub username (`parseGitHubLogin` in
`shared/properties/projectRoles.ts`). A request without a valid GitHub login never gets a role,
so every role-gated write is refused, even when no roles file exists. A deployment that issues
its own sign-in names (for example from a custom handoff route) must forward a GitHub login;
otherwise every role-gated write is refused. Carrying other identities is not supported yet.

## Local server configuration

For an optional local AI server:

```sh
AI_BASE_URL=http://127.0.0.1:11434/v1 AI_MODEL=YOUR_MODEL npm run dev
```

For local GitHub publishing, supply `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_REPOSITORY`, and optionally `GITHUB_BRANCH` in the server environment. The starting local checkout's Git HEAD becomes the baseline. Use a clean checkout corresponding to that repository and branch. No credentials are required for the ordinary local editor demo.

## GitHub changes a running workspace cannot take

Automatic GitHub sync writes site source under `src/` and the `.stacki` metadata the server reads
on demand (`.stacki/roles.json`, `audits.json`, `instructions.json`, `variables.json`,
`styles.json`, `components.json`, `component-sources.json`, `guide.json`, `pages.json` and
`publish.json`). The reason for each file is in `src/features/github/syncPaths.ts`. Any other
change (dependencies, Astro or Vite configuration, `public/` files, `.stacki/folders.json`, which
the component preview reads once at startup) stops the sync with "Restart from a fresh repository
revision". Studio keeps editing from its current revision.

Studio has no button that restarts a workspace from a newer revision. A container start
restores the revision Studio last recorded in R2, not GitHub's newest commit:

- **The workspace has Git history** (someone has used the Git panel): **Pull from GitHub** merges
  the commit with Git, runtime files included, and records the new remote head. The next container
  start begins from that revision and runs `npm ci` when dependencies changed. A container starts
  again after it sleeps (three idle minutes) or after a redeploy.
- **The workspace has no Git history**: the recorded baseline (`metadata/base-sha` in R2) only
  advances through a sync that succeeds, so a blocked change stays blocked across restarts. Make one
  Git panel action (for example **Pull from GitHub**) to give the workspace Git history, then
  follow the step above.

## Draft storage cleanup

Studio automatically removes duplicate upload copies from private R2 after a confirmed GitHub
push. This includes nested assets in `public/` and `src/`, across every supported asset format.
The stored bytes must match the committed snapshot before removal. The working project keeps
its asset, and container startup restores it from GitHub. A failed or unconfirmed push never
triggers cleanup; a newer unpublished version of an asset stays in R2.

Deleting an asset in Assets also removes its stored upload copy. Unpublished uploads are never
removed merely because a source scan finds no references: dynamic URLs and external consumers
can still use them. The account menu needs no storage scan or cleanup button.

Cleanup verifies the upload version, size and content digest under the project's mutation
coordinator. It cannot delete collaboration documents or metadata. Those records preserve draft
recovery and CRDT identities across reconnects, even after publishing. There is no age-based
expiration of draft documents or history reset.

If cleanup fails, publishing still succeeds and reports a warning. The next successful GitHub
publish scans stored uploads again, including copies left by an earlier failed cleanup.
Local development uses the same automatic cleanup with snapshots under
`.stacki/studio/state/uploads`.
No additional storage service, scheduled job or package dependency is required.

Publishing starts a job and returns immediately; the editor checks progress with
short requests. Repeated clicks share the running job. Temporary server failures
retry status checks without resubmitting the publish. A container restart can
interrupt an in-progress job; Studio reports that its outcome is unconfirmed and
asks the editor to check GitHub before retrying. Deploy Studio while publishing
is idle. Publishing captures Git objects and pushes only objects missing from the destination.
GitHub-only publishing skips builds and hooks; it never sends a full base64 payload through the Worker.

API authentication failures return JSON with HTTP 401, access failures use 403,
and server outages use 503. An unexpected upstream response no longer instructs
users to sign out. Valid, authorized sessions can return to Studio during an
OAuth cooldown; a genuine GitHub rate limit still must expire before a new
OAuth exchange.

## Large repositories and upgrades

Startup fetches the witnessed Git revision directly to disk instead of buffering an archive.
Publishing reads file lists incrementally and keeps blob bodies out of JavaScript memory. GitHub
App installation tokens are scoped to the configured repository and given only to the authenticated
container for Git operations; the App private key stays in the Worker. Tokens are not persisted in
Git config, and build/hook processes do not inherit them.

Deploy the updated Worker and container together because the internal publish/bootstrap protocol
changed. Existing `cloudflare/wrangler.jsonc` files are preserved during updates. For a photo-heavy
1.3 GB site, select `standard-2` as a starting size, rebuild and redeploy; measure the actual build.
Hosting requires capacity for source, temporary Git objects, a build copy, output and dependencies.
Preflight disk checks retain a 1 GiB reserve, but arbitrary build tools still need their own limits.
The default build caps the Node heap at 2 GiB. Larger instances cost more while awake; the idle
sleep policy and one-instance limit remain unchanged. Small sites can retain a smaller instance
when measured memory and disk requirements fit. GitHub-only pushes avoid the extra build cost.

Limits enforced by GitHub and hosting providers still apply independently. Cloudflare static
assets must fit its file count and per-file limits. A passing local test is not a production
Cloudflare deployment or a measured bill.
