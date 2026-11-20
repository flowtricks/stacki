// Goal: "Sign in with a passkey": WebAuthn accounts that need no external identity service. A person is a HANDLE
// (`client-acme`) an admin invited; their identity is `passkey:<handle>`, and roles.json lists members that way.
// The ceremonies (all verified in webauthn.ts):
//   enrol   admin invite link -> `/studio/auth/login?invite=<code>` -> the page asks for a passkey -> register-options
//           (single-use challenge) -> register (invite spent and passkey stored in one transaction)
//   sign in `/studio/auth/login` -> the page asks for any passkey on the device (discoverable credentials, conditional UI where
//           supported) -> options (single-use challenge bound to core's `state`) -> the signed assertion rides to
//           `/studio/auth/passkey/callback?state=..&assertion=..` where core checks `state` and `identify` verifies it
// Relying-party ID is the Studio hostname; a passkey made for one hostname never works on another (docs/auth-providers.md).
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import type { AuthProvider, ProviderPerson, SignInFlow, SignInRefusal } from '../authProvider';
import { parsePasskeyConfig } from './authConfig';
import { decodeBase64url, encodeBase64url, randomToken, utf8Bytes } from './base64url';
import type { BuiltInContext } from './builtIn';
import { createEditorPolicy } from './editorPolicy';
import { passkeyPage } from './passkeyPages';
import { PASSKEY_LIMITS, parseDisplayName, type PasskeyStore } from './passkeyStore';
import { limitedRefusal, limitedStart, signInLimiter } from './providerCommon';
import { clientKey, createRateLimiter, RATE_LIMITS, type RateLimiter } from './rateLimit';
import { challengeOf, verifyAssertion, verifyRegistration, WEBAUTHN_LIMITS, type WebAuthnFailure } from './webauthn';

export const PASSKEY_PATHS = { prefix: '/studio/auth/provider/passkey/' } as const;
export const PASSKEY_REQUEST_LIMITS = {
  /** A JSON body of a ceremony step: attestation objects are the largest, a few kilobytes. */
  bodyBytesMax: 16_384,
  /** The assertion in the callback URL: well under common URL limits. */
  assertionCharsMax: 6_000,
  timeoutMs: 120_000,
} as const satisfies Record<string, number>;

const PASSKEY_DISPLAY_NAME = 'Passkey';

export function createPasskeyProvider(context: BuiltInContext): AuthProvider {
  const parsed = parsePasskeyConfig(context.environment);
  if (!parsed.ok) {
    throw new Error(`Studio AUTH_PROVIDER=passkey is misconfigured: ${parsed.error.join(' ')}`);
  }
  const rpId = new URL(context.origin).hostname;
  const policy = createEditorPolicy({
    policy: parsed.value,
    roles: context.roles,
    // A locked-out handle loses access within seconds, whatever its session says.
    active: (principal) => context.passkeyHandleActive(principal.identity.slice('passkey:'.length)),
  });
  const limiter = signInLimiter();
  const stepLimiter = createRateLimiter({ attemptsMax: RATE_LIMITS.passkeyStepsMax });
  const store = (): PasskeyStore => {
    if (context.passkeys === undefined) {
      throw new Error('Assertion failed: passkey ceremonies run inside the Durable Object');
    }
    return context.passkeys;
  };
  const expectation = (challenge: string) => ({ challenge, origin: context.origin, rpId });

  return {
    id: 'passkey',
    displayName: PASSKEY_DISPLAY_NAME,
    begin: async (request, flow) => {
      const limited = limitedStart(limiter, request, PASSKEY_DISPLAY_NAME);
      if (limited !== undefined) {
        return limited;
      }
      const languages = request.headers.get('Accept-Language');
      const callbackPath = new URL(flow.callbackUrl).pathname;
      const code = new URL(request.url).searchParams.get('invite');
      if (code === null) {
        return passkeyPage({ mode: 'signin', state: flow.state, callbackPath }, languages);
      }
      const invite = code.length <= 100 ? await store().peekInvite(code, context.now()) : undefined;
      return invite === undefined
        ? passkeyPage({ mode: 'invalid' }, languages)
        : passkeyPage({ mode: 'enrol', state: flow.state, callbackPath, invite: code, handle: invite.handle, displayName: invite.displayName }, languages);
    },
    identify: async (request, flow) => {
      const limited = limitedRefusal(limiter, request, context.now());
      if (limited !== undefined) {
        return err(limited);
      }
      return identifyAssertion(request, flow);
    },
    handle: async (request, flow) => {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(PASSKEY_PATHS.prefix)) {
        return undefined;
      }
      const step = path.slice(PASSKEY_PATHS.prefix.length);
      if (!['options', 'register-options', 'register'].includes(step)) {
        return undefined;
      }
      if (request.method !== 'POST') {
        return json({ error: 'method' }, 405);
      }
      if (stepLimiter.take(clientKey(request)) > 0) {
        return json({ error: 'rate-limit' }, 429);
      }
      const body = await readJson(request);
      if (body === undefined) {
        return json({ error: 'body' }, 400);
      }
      switch (step) {
        case 'options':
          return authenticationOptions(flow);
        case 'register-options':
          return registrationOptions(body, flow);
        default:
          return register(body, flow);
      }
    },
    canEdit: policy.canEdit,
    canManage: policy.canManage,
  };

  async function authenticationOptions(flow: SignInFlow): Promise<Response> {
    const challenge = randomToken(WEBAUTHN_LIMITS.challengeBytes);
    const stored = await store().putChallenge(challenge, { kind: 'get', state: flow.state }, context.now());
    return stored.ok ? json({ challenge, rpId, timeout: PASSKEY_REQUEST_LIMITS.timeoutMs }) : json({ error: 'busy' }, 503);
  }

  async function registrationOptions(body: Record<string, unknown>, flow: SignInFlow): Promise<Response> {
    const code = body['invite'];
    const invite = typeof code === 'string' && code.length <= 100 ? await store().peekInvite(code, context.now()) : undefined;
    if (invite === undefined) {
      return json({ error: 'invite' }, 400);
    }
    const challenge = randomToken(WEBAUTHN_LIMITS.challengeBytes);
    const stored = await store().putChallenge(challenge, { kind: 'create', state: flow.state }, context.now());
    if (!stored.ok) {
      return json({ error: 'busy' }, 503);
    }
    const existing = await store().credentialsOf(invite.handle);
    return json({
      challenge,
      rp: { id: rpId, name: 'Stacki Studio' },
      user: { id: encodeBase64url(utf8Bytes(invite.handle)), name: invite.handle, displayName: invite.displayName ?? invite.handle },
      pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: 'public-key', alg })),
      timeout: PASSKEY_REQUEST_LIMITS.timeoutMs,
      excludeCredentials: existing.map((credential) => credential.id),
    });
  }

  async function register(body: Record<string, unknown>, flow: SignInFlow): Promise<Response> {
    const code = body['invite'];
    const clientData = decode(body['clientDataJSON'], WEBAUTHN_LIMITS.clientDataBytesMax);
    const attestation = decode(body['attestationObject'], WEBAUTHN_LIMITS.attestationBytesMax);
    if (typeof code !== 'string' || code.length > 100 || clientData === undefined || attestation === undefined) {
      return json({ error: 'body' }, 400);
    }
    const challenge = challengeOf(clientData);
    // The challenge is spent first, whatever happens next, and only the browser flow it was issued to can spend it.
    if (challenge === undefined || !(await store().takeChallenge(challenge, 'create', flow.state, context.now()))) {
      return json({ error: 'challenge' }, 400);
    }
    const verified = await verifyRegistration({ clientDataJSON: clientData, attestationObject: attestation }, expectation(challenge));
    if (!verified.ok) {
      console.error('Studio passkey registration refused', { reason: verified.error });
      return json({ error: 'verification', reason: verified.error }, 400);
    }
    const label = parseDisplayName(body['label'])?.slice(0, PASSKEY_LIMITS.labelCharsMax) ?? 'Passkey';
    const enrolled = await store().enrol({
      code,
      credentialId: verified.value.credentialId,
      key: verified.value.key,
      signCount: verified.value.signCount,
      label,
      nowMs: context.now(),
    });
    return enrolled.ok ? json({ ok: true }) : json({ error: enrolled.error }, 400);
  }

  async function identifyAssertion(request: Request, flow: SignInFlow): Promise<Result<ProviderPerson, SignInRefusal>> {
    const assertion = parseAssertion(new URL(request.url).searchParams.get('assertion'));
    if (assertion === undefined) {
      return err({ problem: 'expired', reference: 'passkey-assertion' });
    }
    const challenge = challengeOf(assertion.clientDataJSON);
    if (challenge === undefined || !(await store().takeChallenge(challenge, 'get', flow.state, context.now()))) {
      return err({ problem: 'expired', reference: 'passkey-challenge' });
    }
    const credential = await store().credential(assertion.id);
    // The same answer for an unknown, removed or locked passkey: a probe learns nothing about which handles exist.
    if (credential === undefined || !(await context.passkeyHandleActive(credential.handle))) {
      return err({ problem: 'access', reference: 'passkey-unknown' });
    }
    if (assertion.userHandle !== undefined && assertion.userHandle !== encodeBase64url(utf8Bytes(credential.handle))) {
      return err({ problem: 'access', reference: 'passkey-handle' });
    }
    const verified = await verifyAssertion(
      { clientDataJSON: assertion.clientDataJSON, authenticatorData: assertion.authenticatorData, signature: assertion.signature },
      expectation(challenge),
      { key: credential.key, signCount: credential.signCount },
    );
    if (!verified.ok) {
      console.error('Studio passkey sign-in refused', { reason: verified.error });
      return err(refusalFor(verified.error));
    }
    const used = await store().useCredential(credential.id, verified.value.signCount, context.now());
    if (!used.ok) {
      console.error('Studio passkey sign-in refused', { reason: used.error === 'rollback' ? 'counter-rollback' : 'missing' });
      return err({ problem: 'access', reference: `passkey-${used.error}` });
    }
    const handle = await store().handle(credential.handle);
    return ok({ identity: `passkey:${credential.handle}`, name: handle?.displayName ?? credential.handle });
  }
}

function refusalFor(failure: WebAuthnFailure): SignInRefusal {
  return { problem: failure === 'counter-rollback' ? 'access' : 'unavailable', reference: `passkey-${failure}` };
}

interface Assertion {
  readonly id: string;
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
  readonly userHandle: string | undefined;
}

/** The assertion the sign-in page put in the callback URL: base64url of a JSON object of base64url fields, every one bounded. */
export function parseAssertion(text: string | null): Assertion | undefined {
  if (text === null || text.length === 0 || text.length > PASSKEY_REQUEST_LIMITS.assertionCharsMax) {
    return undefined;
  }
  const bytes = decodeBase64url(text, PASSKEY_REQUEST_LIMITS.assertionCharsMax);
  if (bytes === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const id: unknown = Reflect.get(value, 'id');
  const userHandle: unknown = Reflect.get(value, 'userHandle');
  const clientDataJSON = decode(Reflect.get(value, 'clientDataJSON'), WEBAUTHN_LIMITS.clientDataBytesMax);
  const authenticatorData = decode(Reflect.get(value, 'authenticatorData'), WEBAUTHN_LIMITS.authenticatorDataBytesMax);
  const signature = decode(Reflect.get(value, 'signature'), WEBAUTHN_LIMITS.signatureBytesMax);
  if (
    typeof id !== 'string' ||
    decodeBase64url(id, WEBAUTHN_LIMITS.credentialIdBytesMax) === undefined ||
    clientDataJSON === undefined ||
    authenticatorData === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  if (userHandle !== undefined && (typeof userHandle !== 'string' || userHandle.length > 200)) {
    return undefined;
  }
  return { id, clientDataJSON, authenticatorData, signature, userHandle };
}

function decode(value: unknown, bytesMax: number): Uint8Array<ArrayBuffer> | undefined {
  return typeof value === 'string' ? decodeBase64url(value, bytesMax) : undefined;
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > PASSKEY_REQUEST_LIMITS.bodyBytesMax) {
    return undefined;
  }
  const text = await request.text();
  if (text.length > PASSKEY_REQUEST_LIMITS.bodyBytesMax) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
  } catch {
    return undefined;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export type { RateLimiter };
