# Deploying a studio to Cloudflare

## Hosting

Each project uses its own Cloudflare resources and GitHub App installation. Configure
account usage notifications before deployment; alerts are not spending caps. This
source distribution does not create resources or claim that an account is configured.

### Cost controls

- Website dependencies are installed into the deployment image and reused when the repository lockfile matches. Changed lockfiles use a cached install fallback. Ordinary cold starts restore drafts and start Astro without reinstalling packages.
- One shared basic Container; three-minute sleep timeout after connections close.
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
- Uploads are limited to 20 MB each, 200 public asset files, and 100 MB total. Publish additionally has its existing 24 MB snapshot limit and three-minute build timeout.
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
- Keep one Container instance for the shared project. The supplied `basic` instance and three-minute sleep timeout are starting values to measure with your site's dependencies.
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

Assets → **Storage & cleanup** scans the current project's stored objects on demand. It shows
upload, collaboration-draft, and other stored bytes. These are current object sizes, not an
account-wide free-tier allowance or billing estimate; requests also incur usage. The scan is not
polled in the background.

After a successful GitHub publish, Studio automatically removes stored upload copies only when
their bytes match the committed snapshot. The asset remains in the project and can be restored
from that GitHub revision on container startup. A failed build or commit never triggers cleanup.
A cleanup failure does not turn a successful publish into a failed publish; it is reported so
cleanup can be retried from Assets.

The manual scan also lists unpublished uploads for which no literal references were found in
project source, root configuration, or public text files. Nothing is selected automatically.
Review the names, then confirm before removal. Dynamic URLs and external consumers cannot be
proven absent by a source scan. Published paths with different draft contents and files with
detected references are retained. Repository assets that were not uploaded through Studio are
not deletion candidates.

Before removal, Studio rechecks the current GitHub baseline, project references, upload version,
size, and content digest. Cleanup and uploads share the single project's mutation coordinator.
An incomplete source scan or Git tree prevents cleanup. Inventory listing follows pagination
rather than treating the first page as complete. Cleanup has no permission to delete document
state or metadata. Collaboration documents stay in storage after publishing so reconnecting
editors keep their CRDT identities; there is no age-based draft expiration or history reset.

Local development uses the same review and cleanup behavior with local upload snapshots under
`.studio-state/uploads`, and labels its storage accordingly. Production stores those copies in
private R2. No additional storage service, scheduled job, or package dependency is required.

Publishing starts a job and returns immediately; the editor checks progress with
short requests. Repeated clicks share the running job. Temporary server failures
retry status checks without resubmitting the publish. A container restart can
interrupt an in-progress job; Studio reports that its outcome is unconfirmed and
asks the editor to check GitHub before retrying. Deploy Studio while publishing
is idle. Publishing compares the snapshot with the complete GitHub tree and
uploads only changed files.

API authentication failures return JSON with HTTP 401, access failures use 403,
and server outages use 503. An unexpected upstream response no longer instructs
users to sign out. Valid, authorized sessions can return to Studio during an
OAuth cooldown; a genuine GitHub rate limit still must expire before a new
OAuth exchange.
