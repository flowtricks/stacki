# Authentication providers

> **Experimental.** This interface may change in minor versions. Pin your Studio version, read the release notes before updating, and re-run your provider's conformance test after each update.

Hosted Studio signs people in with **GitHub** and that stays the default: with no extra files and no `AUTH_PROVIDER`, nothing here changes. Studio also ships four other built-in options, chosen with one variable (see [Built-in providers](#built-in-providers)): **Cloudflare Access**, **Google**, **SSO (OpenID Connect)** and **passkeys**. Beyond those, this page is for an instance owner or fork who wants any other method **without editing Studio core**: the interface below is the seam the built-in providers are built on.

## What a provider does, and what core keeps

| A provider                                                                                         | Core (never delegated)                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Starts sign-in (`begin`) and finishes it (`identify`)                                              | CSRF `state`, single-use callbacks, cooldown after a rate limit                                                        |
| Says **who** the person is (a qualified identity, name, optional email and avatar)                 | The signed session cookie: signing, expiry, `__Host-` name, `HttpOnly; Secure; SameSite=Lax`, preview tokens, sign-out |
| May add an edit policy (`canEdit`), a manage policy (`canManage`), extra role names (`memberKeys`) | `roles.json` role resolution and every permission check in the container                                               |
| May add its own extra routes (`handle`) under `/studio/auth/provider/`                             | Response headers, cookies, redirects from the provider are rebuilt or refused                                          |

Core owns the session, not the provider. One audited place signs, expires and rotates sessions; a provider never sees `SESSION_SECRET` (it is not in the `environment` core hands over), so it cannot mint a session for anyone, for itself or for another provider's people.

## The interface

Source: `src/features/auth/authProvider.ts`. Experimental; shown shortened.

```ts
export interface AuthProvider {
  readonly id: string; // 'google', 'email', 'oidc'... the prefix of every identity. 'github' is reserved.
  readonly displayName: string; // "Continue with <displayName>" on the sign-in page.
  begin(request: Request, flow: SignInFlow): Promise<Response>;
  identify(request: Request, flow: SignInFlow): Promise<Result<ProviderPerson, SignInRefusal>>;
  handle?(request: Request, flow: SignInFlow): Promise<Response | undefined>;
  canEdit?(principal: Principal, freshness: 'cached' | 'fresh'): Promise<boolean>;
  canManage?(principal: Principal): Promise<boolean>;
  memberKeys?(principal: Principal): readonly string[];
  inviteHint?: string; // Roles panel invite form: a hint for the identifier field (custom providers).
  parseInviteIdentifier?(input: string): string | undefined; // ...and how to turn what an admin typed into your subject.
}
export type AuthProviderFactory = (setup: { origin: string; environment: Readonly<Record<string, unknown>> }) => AuthProvider;
```

`ProviderPerson` is `{ identity, name, email?, avatarUrl? }`. `SignInRefusal` is `{ problem, reference?, retryAtMs? }` where `problem` is one of `expired`, `cancelled`, `configuration`, `unavailable`, `access`, `email`, `rate-limit`: Studio shows its own translated sentence for each, in the visitor's language.

### Identities

An identity is `<provider>:<subject>`, parsed once at the boundary (`parseQualifiedIdentity`, `shared/properties/memberIdentity.ts`):

| Part     | Rule                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider | `[a-z][a-z0-9-]*`, at most 32 characters. Must equal your `id`.                                                                                                        |
| subject  | 1 to 200 printable characters, no whitespace, no comma. Use the provider's **stable** name (`google:<sub>`), not a mutable one, unless that is what you want to match. |
| whole    | at most 233 characters                                                                                                                                                 |

Examples: `github:octocat`, `email:a@b.com`, `google:1098765432`. Only the built-in GitHub provider may produce `github:` identities: core rejects any identity outside your namespace, and refuses a custom `id` of `github`. Subjects of other providers compare **exactly**, so canonicalize before you return one (lowercase an email, for instance). GitHub logins compare case-insensitively, as before.

## Lifecycle

1. `GET /studio/auth/login`: core sets a signed one-time `state` cookie (10 minutes), calls `begin`. Your response is rebuilt: its `Set-Cookie` is dropped, `Cache-Control: no-store` is forced, and a redirect must go to `https` (or `localhost`).
2. The identity service sends the browser back to `/studio/auth/callback?state=…`. **Your service must return `flow.state` as the `state` query parameter.** Core compares it with the cookie and refuses the callback (403) before `identify` runs if it differs or the cookie is missing. A callback works once: core clears the state on every outcome.
3. `identify(request, flow)` verifies the proof in the request (a code, an ID token, a one-time link) and returns `ok(person)` or `err(refusal)`. Throwing is a bug and becomes a generic "temporarily unavailable" page.
4. Core parses the person (`parsePerson`: namespace, bounds, https avatar, no unknown fields), asks `canEdit(principal, 'fresh')`, and only then signs the session cookie for **eight hours** and redirects to `/studio`.
5. On **every request** core verifies the cookie and asks `canEdit(principal, 'cached')`. Cache remote lookups briefly; a removed person loses access within your cache time. Core re-checks open collaboration connections about every five minutes.
6. `POST /studio/auth/logout` (same-origin only) clears the session. There is no provider hook: sign-out is core's alone. If your identity service has its own session, end it from a link you show.

Sessions from another provider are worthless: after you switch providers, old GitHub sessions stop working and people sign in again.

### Extra routes (`handle`)

For a form that emails a code, or a passkey challenge. Core calls `handle` for any request under `/studio/auth/provider/`, requires the Studio `Origin` on every non-GET request, requires a live sign-in state (`flow.state`, put it in any link you email), strips `Set-Cookie`, and caches nothing. Return `undefined` for paths you do not own.

## Roles and access

`.stacki/roles.json` keeps deciding **what** a signed-in person may do. Members are matched on the qualified identity:

```json
{ "version": 1, "roles": [{ "id": "admin", "name": "Admin", "members": ["octocat", "email:boss@example.com", "google:1098765432"] }] }
```

- A **bare login means `github:<login>`**. Every existing file keeps its meaning; nothing to migrate.
- `memberKeys(principal)` can return further identities of the same person (their `email:` and their `google:` identity). Core keeps only valid ones **in your own namespace**, at most 8, so you can never claim a GitHub member.
- The container resolves roles from `x-studio-identity` (set by the Worker, trusted only with the container token). Your code never runs there and cannot skip the check.

`canEdit` answers "may this person use this Studio at all". Without it nobody can edit, unless you set `EDITOR_ACCESS` to **`authenticated`** (any person your provider verifies). `github` and `repository` mean GitHub's rules and do nothing for another provider. `canManage` answers who may connect a CMS or media host and manage Studio updates; without it nobody can (the built-in provider uses GitHub repository Write or Admin).

Publishing uses the GitHub App's installation token on the server, so signed-in people who have no GitHub account can still publish. Commits are authored by the app; for a person who is not a GitHub person the commit message gains a footer line, `Edited by google:a@b.com via Stacki Studio` (a parsed identity, printable ASCII, one line, so it cannot forge a trailer).

## Built-in providers

Order everywhere: **GitHub (default)**, Cloudflare Access, Google, SSO (OIDC), passkeys. GitHub is untouched: no `AUTH_PROVIDER`, or `AUTH_PROVIDER=github`, is today's behaviour.

### The config contract

Set in `studio/cloudflare/wrangler.jsonc` `vars` (secrets with `wrangler secret put`). The build reads `AUTH_PROVIDER` and bundles only that provider; changing it needs `npm run build`. An unknown value stops the build and answers 503 at runtime, naming the allowed values; a build made for one provider run with another id also answers 503. Nothing ever falls back to GitHub. `astro-studio check-project` reports missing or invalid variables per provider and lists the secrets to set.

| Variable                                                              | `access`                           | `google`                               | `oidc`                                                                                                                              | `passkey`          |
| --------------------------------------------------------------------- | ---------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `AUTH_PROVIDER`                                                       | `access`                           | `google`                               | `oidc`                                                                                                                              | `passkey`          |
| Provider vars                                                         | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | `GOOGLE_CLIENT_ID`                     | `OIDC_ISSUER`, `OIDC_CLIENT_ID`; optional `OIDC_SCOPES` (default `openid email profile`), `OIDC_NAME` (button label, default `SSO`) | none               |
| Secrets                                                               | none                               | `GOOGLE_CLIENT_SECRET`                 | `OIDC_CLIENT_SECRET` (absent: public client, PKCE only)                                                                             | `AUTH_SETUP_CODE`  |
| `AUTH_BOOTSTRAP_ADMIN` (required)                                     | `access:me@example.com`            | `google:me@example.com`                | `oidc:me@example.com`                                                                                                               | `passkey:owner`    |
| `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS` (optional, comma lists) | yes                                | yes                                    | yes                                                                                                                                 | not used           |
| Identity                                                              | `access:<lowercased email>`        | `google:<verified lowercased email>`   | `oidc:<verified email, else sub>`                                                                                                   | `passkey:<handle>` |
| Redirect URI to register                                              | none                               | `<origin>/studio/auth/google/callback` | `<origin>/studio/auth/oidc/callback`                                                                                                | none               |

GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_REPOSITORY`, `GITHUB_BRANCH`) stay **required in every mode**: non-GitHub editors publish through the app, and the Worker reads `.stacki/roles.json` from the repository with it.

### Who may edit and manage (the same for all four)

1. **`.stacki/roles.json` is the authority.** A member of any role (written as the qualified identity, `google:a@b.com`) may edit; a member of the **admin** role may manage (CMS and media connections, Studio updates, passkey invites). The file is read from the published branch and cached for a minute.
2. **Allow-lists add default-role editors.** A person in no role whose verified email is in `AUTH_ALLOWED_EMAILS`, or whose domain is in `AUTH_ALLOWED_DOMAINS`, may edit and gets the file's `defaultRole`. They never manage. `EDITOR_ACCESS=roles` switches the allow-lists off.
3. `EDITOR_ACCESS=authenticated` admits every person the provider verified. Not recommended for Google or SSO.
4. **Bootstrap.** `AUTH_BOOTSTRAP_ADMIN` is admin and editor only while no valid roles file exists, so a new site has an owner. The moment the file lists admins it takes over completely: add the bootstrap identity to it, or it stops being special. A roles file that does not parse grants nobody anything; the bootstrap admin can still fix it. Without a roles file, the container treats every editor as admin, as it always has.

Spellings: identities of these providers compare exactly, so write them lowercase in `roles.json`.

### Cloudflare Access

Cloudflare Access sits in front of the Worker and forwards a signed JWT in `Cf-Access-Jwt-Assertion`. Studio has no login of its own in this mode: it verifies that JWT (RS256 only, signature against `https://<team>/cdn-cgi/access/certs`, `iss` `https://<team>`, `aud` your application's tag, expiry) and never reads headers such as `Cf-Access-Authenticated-User-Email`, which any client can send when Access is not in front.

Dashboard steps, in prose:

1. In the Cloudflare dashboard open **Zero Trust**, then **Access**, then **Applications**, and choose **Add an application**, type **Self-hosted**.
2. Name it (for example "Stacki Studio"). Under **Application domain** add the Studio hostname with the path `/studio*`. For a workers.dev Studio use the Worker's **Access** toggle (Workers & Pages, your Worker, Settings, Domains & Routes) which creates the application for you; for a custom domain add the hostname yourself.
3. Add a policy: **Allow**, and include the emails, email domains or identity-provider groups that may sign in. Access is the first gate; `roles.json` still decides what each person may do.
4. Save, then open the application and copy its **Application Audience (AUD) Tag**. Your **team domain** is shown under Zero Trust, Settings, Custom Pages (it looks like `myteam.cloudflareaccess.com`).
5. Set `AUTH_PROVIDER=access`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `AUTH_BOOTSTRAP_ADMIN=access:you@example.com`, then build and deploy.

Notes: do **not** put Access in front of the preview hostname (`PREVIEW_ORIGIN`); the preview uses Studio's own preview tokens, and an Access login there would break the editor's canvas. When Access protects only `/studio*`, requests the Worker answers elsewhere are unaffected; Studio verifies the JWT itself, so it also refuses requests that reach the Worker without passing Access. If a request arrives without a valid JWT (Access not in front of this hostname or path) Studio shows an explanation instead of a sign-in button. A service token (no email) signs in as `access:service-<client id>`, may edit only if `roles.json` lists it, and manages only if it is an admin member. Sign out of Access itself at `https://<team>/cdn-cgi/access/logout`.

### Google

Authorization Code with PKCE. In Google Cloud Console create an OAuth client of type **Web application** and add the redirect URI `<STUDIO_ORIGIN>/studio/auth/google/callback`. The ID token is verified (signature against Google's published keys, `iss`, `aud`, `exp`, `nonce`) and only `email_verified: true` is accepted. With `AUTH_ALLOWED_DOMAINS`, an address on a listed domain must also carry the matching `hd` (Workspace) claim, because the same address registered at a consumer Google account is not controlled by your domain; an `hd` that disagrees with the address is always refused. The identity is the email, which Google can in principle reassign: removing someone from your Workspace should also remove them from `roles.json`.

### SSO (OpenID Connect)

Any standards-compliant provider (Okta, Entra ID, Auth0, Keycloak, Google Workspace through OIDC). Register the redirect URI `<STUDIO_ORIGIN>/studio/auth/oidc/callback`. Endpoints come from `<OIDC_ISSUER>/.well-known/openid-configuration` (https only, cached an hour, stale for a day); the document's `issuer` must equal `OIDC_ISSUER` exactly. ID tokens must be RS256 or ES256 (`none` and everything else refused), with exact `iss`, `aud` (with `azp` for several), `exp`/`nbf` with 60 seconds of skew, `nonce`, and `at_hash` when both are present. Identity rule: **`oidc:<verified lowercased email>` when the ID token has `email` with `email_verified` true, else `oidc:<sub>`**; a `sub` that looks like an email, or has spaces or commas, is refused as a fallback so an opaque id can never pose as someone else's address. Include `email` in the ID token (scope `email`, or a claim mapping) to name people by email. The token endpoint uses `client_secret_basic` when offered, else `client_secret_post`; with no secret the client is public and PKCE alone protects the exchange.

### Passkeys

No external service: WebAuthn on Web Crypto in the Worker, with a hand-written bounded CBOR reader (no new dependency; AGENTS.md section 17). Supported: attestation `none` and `packed` self attestation; ES256, RS256 and EdDSA. Attestation is not trust-checked: Studio asks "is this the same key as last time", not "which device".

- **Storage.** Handles, passkeys (id, public key, counter, label), invites and challenges live in the instance's Durable Object storage, never in Git. Invite codes are stored only as hashes.
- **First administrator (`AUTH_SETUP_CODE`).** A new site has no passkey, so nobody can sign in to invite anyone. The owner chooses a code, **16 to 200 characters with no spaces**, and stores it as a secret with `npx wrangler secret put AUTH_SETUP_CODE --config cloudflare/wrangler.jsonc` (run in `studio/`). It is required for `AUTH_PROVIDER=passkey`: a missing or malformed code is a configuration problem, and `astro-studio check-project` lists it with the other secrets to set. After deploying, the owner opens **`<origin>/studio/auth/passkey/bootstrap`** once, enters the code and creates the passkey for the `AUTH_BOOTSTRAP_ADMIN` handle (`passkey:owner` unless the owner chose another). The code is compared in constant time and Stacki never asks for it or stores it. Attempts are rate limited harder than other steps, per address and across all addresses together, and a wrong code answers 403 without saying why. The page answers only `GET`, and it **exists only while the bootstrap handle has no passkey**: once the first passkey is stored the path is as good as absent. Keep the secret set, because the provider still checks it when it starts.
- **Enrolment by invite.** An admin (`canManage`) creates an invite for a handle (`client-acme`: lowercase letters, digits, `.`, `_`, `-`, up to 64) with an optional display name. It returns a one-time link, `<origin>/studio/auth/login?invite=<code>`, **valid seven days, single use**. The invitee opens it and creates a passkey on their device; the invite is spent in the same transaction that stores the passkey. List `passkey:<handle>` as a member in `roles.json`.
- **Sign-in.** The page offers "Sign in with a passkey" (discoverable credentials; conditional UI where the browser supports it). A challenge is single use, expires in five minutes, and is bound to the browser flow that asked for it.
- **Recovery.** An admin can remove one passkey, issue a new invite for the same handle (a new device), or **lock the handle out**: its passkeys and invites are deleted, its live sessions stop working within seconds, and no new invite for that handle is accepted for eight hours (the longest session), so no old session can come back to life. Use a new handle if you need access sooner.
- **RP ID and origin.** The relying-party ID is the Studio hostname and the origin check is exact. A passkey made on `studio.example.com` does not work on a workers.dev hostname or on another domain: **decide the final hostname before inviting people**, and re-invite everyone if it changes.
- **Checks.** `rpIdHash`, the user-present flag, the signature, and a signature counter that must advance (a counter that goes back is refused as a cloned authenticator; authenticators that always send zero are allowed). User verification is requested as `preferred`.
- **Administration API** (managers only, same-origin): `GET /studio/api/auth/passkeys` lists handles, passkeys and pending invites (never codes); `POST` takes `{action: "invite", handle, displayName?}`, `revokeInvite {hash}`, `removeCredential {id}`, `lock {handle}`. `GET /studio/api/auth/info` tells the Roles panel which provider the site uses and whether the person may manage.

### Inviting people from the Roles panel

In Desktop this is Settings, then Roles; in a hosted Studio it is the **Roles view** (rail, Roles). Both draw the same member list and invite form, so a role, a member and an invite mean the same thing in either place. The invite form adapts to the site's sign-in method (`GET /studio/api/auth/info` says which) and never offers one the site is not configured for. Source: `src/features/roles/memberInvite.ts`.

| Site uses         | Admin enters                                                              | Written to `roles.json`                                                    | The person is told                                                                                 |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GitHub            | a username                                                                | the bare login (every existing file's form)                                | sign in at `<origin>/studio` with that GitHub account                                              |
| Cloudflare Access | an email                                                                  | `access:<email>`                                                           | the same, and a reminder that Zero Trust must also allow them (Stacki cannot edit Access policies) |
| Google            | an email                                                                  | `google:<email>`                                                           | sign in at `<origin>/studio` with that Google account                                              |
| SSO               | an email                                                                  | `oidc:<email>`                                                             | the same with your SSO                                                                             |
| Passkeys          | a handle and optional name                                                | `passkey:<handle>`, plus a one-time invite link from the passkey admin API | open the link (valid seven days, single use)                                                       |
| Custom provider   | an identifier (hint from `inviteHint`, shaped by `parseInviteIdentifier`) | `<id>:<subject>`                                                           | sign in with `displayName`                                                                         |

After **Invite**, Studio shows the result in place: the exact link to send (with a **Copy** button) and a line that no email was sent. For GitHub, Google, SSO and Access the link is `<origin>/studio` and the person simply signs in with that account; for passkeys it is the one-time enrolment link and the line gives the day it expires (seven days from creation). Close the result and the passkey link cannot be shown again (the server keeps only its hash), so create a new invite if it is lost. No email is sent: Stacki has no email sender, so the admin copies the link and sends it. Every change is recorded in the commit message of the `roles.json` change (`Invite google:a@b.com as Editor`). Only admins may invite (the roles file write needs the admin role, and passkey invites need `canManage`, both checked on the server). A person belongs to one role, so inviting someone who is already listed moves them; the last admin cannot be removed or moved.

### Rate limits and logging

Every public route has a bounded in-memory limiter (per connecting address): 20 sign-in starts or callbacks per minute, 30 passkey ceremony steps per minute, up to 2,048 addresses tracked. Responses from identity services are read with a ten-second timeout, no redirects and a 64 KiB cap. Tokens, codes, secrets and upstream response bodies are never logged; refusals log a reason code only.

### Security decisions

- The PKCE verifier and nonce are derived (HMAC) from core's one-time `state` and the session secret, so nothing is stored between the redirect and the callback, and a Durable Object restart cannot break a sign-in.
- Algorithms come from an allow-list and the key must match: an RS256 header never verifies with an EC key, and `none` or HS256 are refused before any key is read.
- JWKS refetch happens at most once a minute for an unknown `kid`; a stale key set serves for a day during an outage.
- Core still owns the session, `state`, headers and the callback path; the built-in providers only say who someone is. The per-provider callback `/studio/auth/<id>/callback` is handled by core exactly like `/studio/auth/callback`.

## Install a provider

1. Create `studio/cloudflare/auth-provider.ts` with a default export of an `AuthProviderFactory`. `studio/cloudflare/` is preserved by `astro-studio update … --replace-customizations`, like `wrangler.jsonc` and secrets, so the provider survives updates.
2. Put its settings in `cloudflare/wrangler.jsonc` `vars` (and secrets via `wrangler secret put`). The factory reads them from `setup.environment`. Core's own credentials (`SESSION_SECRET`, `CONTAINER_TOKEN`, GitHub keys, storage bindings) are removed from that object.
3. Set `EDITOR_ACCESS` (`authenticated`, or leave it and give your provider a `canEdit`).
4. `npm run build`. The build picks the file up, type-checks it against the interface, and **fails with the compiler's errors** when it does not fit. Remove the file and build again to return to GitHub sign-in.
5. Deploy. The sign-in page now says "Continue with `<displayName>`" in the visitor's language and no longer shows GitHub's name or mark.

A custom provider file overrides `AUTH_PROVIDER` when present. A Worker cannot choose a module at runtime, so the choice is made by the build, which writes `src/cloudflare/authProviderSlot.ts` (custom provider) and `src/cloudflare/builtInProviderSlot.ts` (built-in provider). Never edit that file; the build regenerates it (committing the regenerated file is fine). If the provider throws at startup the instance answers 503 and logs it; it never falls back to GitHub, so a misconfigured provider cannot silently open the door another way.

A provider is trusted code running inside your Worker. Core limits what it is handed and checks everything it returns; it is not a sandbox.

## A worked example: shared secret and email allowlist

Not shipped, not a recommendation. It signs in anyone who opens a link you gave them, as long as they present a shared secret and an allowlisted email. It shows every responsibility in about 40 lines.

```ts
// studio/cloudflare/auth-provider.ts
import { err, ok } from '../vendor/stacki/shared/core/result';
import type { AuthProviderFactory } from '../src/features/auth/authProvider';

const factory: AuthProviderFactory = ({ environment }) => {
  const secret = String(environment['TEAM_SECRET'] ?? '');
  const allowed = String(environment['TEAM_EMAILS'] ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase());
  return {
    id: 'team',
    displayName: 'Team link',
    // Send the person to a page (here: straight back) carrying core's state.
    begin: (_request, flow) => Promise.resolve(new Response(formPage(flow.state), { headers: { 'Content-Type': 'text/html' } })),
    // GET /studio/auth/callback?state=…&email=…&secret=…  (your form submits here)
    identify: (request) => {
      const url = new URL(request.url);
      const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
      if (secret.length < 32 || url.searchParams.get('secret') !== secret) {
        return Promise.resolve(err({ problem: 'access' as const }));
      }
      return Promise.resolve(ok({ identity: `team:${email}`, name: email.split('@')[0] ?? email, email }));
    },
    canEdit: (principal) => Promise.resolve(allowed.includes(principal.identity.slice('team:'.length))),
  };
};
export default factory;

function formPage(state: string): string {
  return (
    `<form action="/studio/auth/callback" method="get"><input type="hidden" name="state" value="${state}">` +
    '<input name="email" type="email" required><input name="secret" type="password" required><button>Continue</button></form>'
  );
}
```

Use a constant-time comparison for a real secret, and never put a secret in a URL you keep; real providers use an identity service. A role for this person is `"team:alice@example.com"` in `roles.json`.

## Testing your provider

`test/authProviderConformance.ts` runs any provider through the real sign-in flow and checks what core guarantees: exactly one cookie (core's state), a wrong or missing state never reaches `identify`, the identity is in your namespace, the session cookie is core's and verifies only with the session secret, and a finished callback cannot be replayed. Call it from a test file:

```ts
runAuthProviderConformance({
  name: 'team link',
  installed: 'custom',
  create: () => factory({ origin: 'https://studio.test', environment: { TEAM_SECRET: 's'.repeat(32), TEAM_EMAILS: 'a@x.test' } }),
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&email=a@x.test&secret=${'s'.repeat(32)}`),
  refusedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&email=a@x.test&secret=wrong`),
  expectedIdentity: 'team:a@x.test',
});
```

## What stays in core

GitHub as the default provider. The session, the cookie and its flags, preview sessions, sign-out, `state`/CSRF, rate-limit cooldown, the sign-in page and its translations (English, German, Spanish, French, Brazilian Portuguese), `roles.json` resolution, the publishing credentials, and the container's trust in the Worker. The built-in non-GitHub providers live beside the seam (`src/features/auth/providers/`) and use only what a custom provider could use, plus the session secret to derive per-sign-in values (never to sign a session).

Not covered by providers today: GitHub-avatar presence for non-GitHub people (they appear by name), the Desktop app (it has no sign-in), and Git commit authorship (the app is the author; the editor is named in the message).
