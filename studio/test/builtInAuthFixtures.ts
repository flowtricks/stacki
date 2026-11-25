// Goal: real cryptographic test vectors and a fake network for the built-in providers, so no test calls Google, an SSO
// provider or Cloudflare. Keys are generated with Web Crypto at test time, so signatures are genuine; a tampered token is a
// genuine token with one byte changed. `fakeNetwork` answers by URL and records every request it saw.
import { decodeBase64url, encodeBase64url, utf8Bytes } from '../src/features/auth/providers/base64url';
import type { BuiltInContext } from '../src/features/auth/providers/builtIn';
import { parseRolesState, type RolesSource, type RolesState } from '../src/features/auth/providers/rolesSource';
import type { Fetcher } from '../src/features/auth/providers/boundedFetch';
import { CONFORMANCE } from './authProviderConformance';

export interface TestKey {
  readonly kid: string;
  readonly algorithm: 'RS256' | 'ES256';
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey;
  /** The key as a JWKS entry: the public key plus its `kid`, `use` and `alg`. */
  readonly entry: Record<string, unknown>;
}

export async function makeKey(algorithm: 'RS256' | 'ES256', kid: string): Promise<TestKey> {
  const pair =
    algorithm === 'RS256'
      ? await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, [
          'sign',
          'verify',
        ])
      : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, algorithm, privateKey: pair.privateKey, jwk: { ...jwk, alg: algorithm }, entry: { ...jwk, kid, use: 'sig', alg: algorithm } };
}

const json = (value: unknown) => encodeBase64url(utf8Bytes(JSON.stringify(value)));

/** A compact JWS signed by `key`. `header` and `payload` are written as given, so tests can break either. */
export async function signJwt(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = { alg: key.algorithm, kid: key.kid, typ: 'JWT', ...header };
  const signed = `${json(head)}.${json(payload)}`;
  const algorithm = key.algorithm === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key.privateKey, utf8Bytes(signed)));
  return `${signed}.${encodeBase64url(signature)}`;
}

/** An unsigned or wrongly-algorithmed token: `alg` is the attacker's choice. */
export function forgedJwt(payload: Record<string, unknown>, alg: string, kid = 'k1'): string {
  return `${json({ alg, kid, typ: 'JWT' })}.${json(payload)}.${alg === 'none' ? '' : encodeBase64url(new Uint8Array(32).fill(7))}`;
}

/** The same token with its payload changed (another subject) and the old signature kept. */
export function tamper(token: string): string {
  const [head = '', body = '', signature = ''] = token.split('.');
  const claims: unknown = JSON.parse(new TextDecoder().decode(decodeBase64url(body, 8_192)));
  const changed = { ...(typeof claims === 'object' && claims !== null ? claims : {}), sub: 'attacker', email: 'attacker@evil.test' };
  return [head, json(changed), signature].join('.');
}

export const jwksOf = (...keys: readonly TestKey[]) => ({ keys: keys.map((key) => key.entry) });

type Handler = (request: { readonly url: string; readonly init: RequestInit }) => Response | Promise<Response>;

export interface FakeNetwork {
  readonly fetcher: Fetcher;
  /** URLs requested, in order. */
  readonly urls: string[];
  readonly bodies: string[];
  on(url: string, handler: Handler): void;
}

export function fakeNetwork(): FakeNetwork {
  const handlers = new Map<string, Handler>();
  const urls: string[] = [];
  const bodies: string[] = [];
  return {
    urls,
    bodies,
    on: (url, handler) => void handlers.set(url, handler),
    fetcher: async (input, init) => {
      urls.push(input);
      bodies.push(typeof init.body === 'string' ? init.body : '');
      const handler = handlers.get(input);
      if (handler === undefined) {
        throw new TypeError(`No network in tests: ${input}`);
      }
      return handler({ url: input, init });
    },
  };
}

export const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function rolesFrom(state: RolesState | string): RolesSource {
  const resolved = typeof state === 'string' ? parseRolesState(state) : state;
  return { read: () => Promise.resolve(resolved) };
}

export function contextFor(
  environment: Record<string, unknown>,
  network: FakeNetwork,
  roles: RolesSource = rolesFrom({ kind: 'none' }),
  now = () => Date.now(),
): BuiltInContext {
  return {
    origin: CONFORMANCE.origin,
    sessionSecret: CONFORMANCE.secret,
    environment,
    roles,
    fetcher: network.fetcher,
    now,
    passkeys: undefined,
    passkeyHandleActive: () => Promise.resolve(false),
  };
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
