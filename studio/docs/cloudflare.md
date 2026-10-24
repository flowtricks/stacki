# Deploying a studio to Cloudflare

## Hosting

Each project uses its own Cloudflare resources and GitHub App installation. Configure
account usage notifications before deployment; alerts are not spending caps. This
source distribution does not create resources or claim that an account is configured.

### Cost controls

- Website dependencies are installed into the deployment image and reused when the repository lockfile matches. Changed lockfiles use a cached install fallback. Ordinary cold starts restore drafts and start Astro without reinstalling packages.
- One shared standard-2 Container (1 vCPU, 6 GiB RAM, 12 GB disk); three-minute sleep timeout after connections close.
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

## Deployment layout

Keep Studio at `studio/` inside the website repository. Its `cloudflare/wrangler.jsonc`
contains project-specific configuration and is preserved by Studio updates. The public
website and CMS Worker have separate deployments. A site gateway can forward `/studio`
and its child routes through a service binding to the CMS Worker; other paths continue
serving the published website. Preview uses an isolated hostname.

For a Container deployment, configure the build root as `studio`, build command
`npm run build`, and deploy command `npx wrangler deploy --config cloudflare/wrangler.jsonc`.
Website deployment remains controlled by the website's own configuration. Accepting a
Studio update creates a review branch; merge and redeploy the CMS to activate it.

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
- Choose a private R2 bucket name and create it. This bucket stores shared draft state and draft assets; it is not the default published-content database.
- Route `example.com/studio*` to this Worker while retaining the existing website's normal routing. Route the preview hostname to this Worker for all paths. Configure these routes/custom domains in your Cloudflare zone according to the website's existing Pages/Workers hosting setup.
- Keep one Container instance for the shared project. The supplied `standard-2` instance and three-minute sleep timeout are starting values to measure with your site's dependencies.
- Opening the authenticated Studio page starts preview restoration and homepage compilation while the editor assets download. Drafts and uploaded assets restore in batches of four. The canvas shows a loading state and retry control while waiting, then appears when its editing bridge is ready without waiting for every image. Sleeping containers still incur a cold start.
- Studio startup shows an animated progress bar, the current loading stage, and elapsed time after ten seconds. Workspace requests retry up to three times with a twenty-second limit per attempt; a visible Retry control recovers from stalled or failed startup without reloading the whole site.

## GitHub App and secrets

Create a GitHub App with repository Contents read/write and Metadata read access. Install it on the selected website repository. Configure the OAuth callback as `https://example.com/studio/auth/callback`. Generate an App private key and an OAuth client secret. Clients sign in with GitHub; they do not receive the installation key. Sessions last eight hours. The account menu shows the signed-in GitHub account and provides Sign out. Presence avatars come from verified numeric GitHub identities; local loopback development displays Local and does not require sign-in.

For collaborators outside the app owner's account, make the **GitHub App registration public** under Developer settings → GitHub Apps → Advanced. [GitHub restricts authorization of private Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private). Public registration exposes the app's identity and permits installation by other accounts; it does not make the website repository public or bypass the studio's repository permission check. Keep the installation limited to the selected website repository.

Register your own GitHub App for this project; the release bundle does not include an App registration or credentials. The website repository can remain private. Open the Stacki logo menu at the top left of the studio to see your signed-in account or sign out; profile pictures appear in the collaborator group.

If GitHub returns HTTP 429 during sign-in, the studio honors its `Retry-After` or rate-limit reset header and otherwise waits at least one minute. A signed, HTTP-only cooldown cookie blocks repeated login attempts from that browser during the wait; no automatic token-exchange retries run. Afterward, start a fresh sign-in instead of refreshing the callback URL. Existing valid studio sessions are reused. Safe failure references distinguish token exchange, profile lookup, and repository authorization without logging codes or tokens. See [GitHub's rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors). Repository Write access alone cannot clear GitHub's upstream rate limit.

Store these through Wrangler's secret prompts, not checked-in files:

```sh
npx wrangler secret put GITHUB_PRIVATE_KEY --config cloudflare/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put CONTAINER_TOKEN --config cloudflare/wrangler.jsonc
```

Use independent cryptographically random values of at least 32 bytes for the final two secrets. The App private key may contain actual newlines or escaped `\n` sequences. Never put these credentials in the Astro site's public environment variables.

Optional AI configuration: set `AI_BASE_URL` and `AI_MODEL` in Worker vars; use a secret for `AI_API_KEY` if your provider requires one. `AI_BASE_URL` is the OpenAI-compatible base URL, typically ending in `/v1`; the gateway appends `/chat/completions`. Without a provider, the AI panel explains the missing configuration. The endpoint must use HTTPS and be reachable from the Worker. A local model on your laptop is only usable in local development unless you intentionally host an authenticated reachable endpoint.

## Build and verify

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

Before inviting clients, verify GitHub login and denied access for an uninvited account; edit with two browsers; interrupt and restart the Container and confirm R2 recovery; upload an image; publish a successful revision; try a failing site build; push a conflicting GitHub edit; and verify both desktop and phone behavior on the actual custom domains.

Do not enable public access to the preview Container directly. The Worker is its authentication and origin boundary. The internal storage/AI/GitHub routes require the Container token.

## Local server configuration

For an optional local AI server:

```sh
AI_BASE_URL=http://127.0.0.1:11434/v1 AI_MODEL=YOUR_MODEL npm run dev
```

For local GitHub publishing, supply `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_REPOSITORY`, and optionally `GITHUB_BRANCH` in the server environment. The starting local checkout's Git HEAD becomes the baseline. Use a clean checkout corresponding to that repository and branch. No credentials are required for the ordinary local editor demo.

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
Local development uses the same automatic cleanup with snapshots under `.studio-state/uploads`.
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
