# Authentication providers

> **Experimental.** This interface may change in minor versions. Pin your Studio version, read the release notes before updating, and re-run your provider's conformance test after each update.

Hosted Studio signs people in with **GitHub** and that stays the default: with no extra files, nothing here changes. This page is for an instance owner or fork who wants Google, email one-time codes, SSO/OIDC or passkeys instead, **without editing Studio core**. Stacki does not ship any other provider and does not promise to; this is the seam to build one on.

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

Publishing uses the GitHub App's installation token on the server, so signed-in people who have no GitHub account can still publish. Their identity is **not** attached to the Git commit author.

## Install a provider

1. Create `studio/cloudflare/auth-provider.ts` with a default export of an `AuthProviderFactory`. `studio/cloudflare/` is preserved by `astro-studio update … --replace-customizations`, like `wrangler.jsonc` and secrets, so the provider survives updates.
2. Put its settings in `cloudflare/wrangler.jsonc` `vars` (and secrets via `wrangler secret put`). The factory reads them from `setup.environment`. Core's own credentials (`SESSION_SECRET`, `CONTAINER_TOKEN`, GitHub keys, storage bindings) are removed from that object.
3. Set `EDITOR_ACCESS` (`authenticated`, or leave it and give your provider a `canEdit`).
4. `npm run build`. The build picks the file up, type-checks it against the interface, and **fails with the compiler's errors** when it does not fit. Remove the file and build again to return to GitHub sign-in.
5. Deploy. The sign-in page now says "Continue with `<displayName>`" in the visitor's language and no longer shows GitHub's name or mark.

A Worker cannot choose a module at runtime, so there is no `AUTH_PROVIDER` variable: the choice is made by the build, which writes `src/cloudflare/authProviderSlot.ts`. Never edit that file; the build regenerates it (committing the regenerated file is fine). If the provider throws at startup the instance answers 503 and logs it; it never falls back to GitHub, so a misconfigured provider cannot silently open the door another way.

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

GitHub as the only built-in provider and the default. The session, the cookie and its flags, preview sessions, sign-out, `state`/CSRF, rate-limit cooldown, the sign-in page and its translations (English, German, Spanish, French, Brazilian Portuguese), `roles.json` resolution, the publishing credentials, and the container's trust in the Worker. Other providers are not implemented in core.

Not covered by providers today: Git commit authorship for non-GitHub people, GitHub-avatar presence for them (they appear by name), and the Desktop app (it has no sign-in).
