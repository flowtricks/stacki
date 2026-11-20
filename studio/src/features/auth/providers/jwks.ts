// Goal: the identity service's signing keys, fetched and cached with bounds, parsed strictly.
// Method: a key set is read once and reused for `cacheMs`; a token naming an unknown `kid` triggers at most one refetch
// per `refetchCooldownMs` (a key rotation), so a stream of forged `kid`s cannot make the Worker hammer the service.
// When the service is unreachable, an older key set is still used for `staleMs`, so a short outage does not lock people out.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { decodeBase64url } from './base64url';
import { fetchJson, type Fetcher } from './boundedFetch';
import { JWT_LIMITS, type JwtAlgorithm, type JwtKey } from './jwt';

export const JWKS_LIMITS = {
  keysMax: 20,
  cacheMs: 3_600_000,
  refetchCooldownMs: 60_000,
  staleMs: 86_400_000,
} as const satisfies Record<string, number>;

export type KeyLookupFailure = 'unavailable' | 'key-unknown';

export interface JwksCache {
  readonly keyFor: (kid: string | undefined, algorithm: JwtAlgorithm) => Promise<Result<JwtKey, KeyLookupFailure>>;
}

/** The usable keys of a JWKS document (RSA 2048 to 8192 bits, EC P-256), or why it is unusable. At most `keysMax` are read. */
export function parseJwks(input: unknown): Result<readonly JwtKey[], string> {
  if (typeof input !== 'object' || input === null) {
    return err('The key set is not an object');
  }
  const keys: unknown = Reflect.get(input, 'keys');
  if (!Array.isArray(keys) || keys.length > JWKS_LIMITS.keysMax * 5) {
    return err('The key set has no keys list of a sane size');
  }
  const found: JwtKey[] = [];
  const items: readonly unknown[] = keys;
  for (const item of items.slice(0, JWKS_LIMITS.keysMax * 5)) {
    const key = parseKey(item);
    if (key !== undefined && found.length < JWKS_LIMITS.keysMax) {
      found.push(key);
    }
  }
  return found.length > 0 ? ok(found) : err('The key set holds no usable signing key');
}

function parseKey(item: unknown): JwtKey | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const field = (name: string): unknown => Reflect.get(item, name);
  const use = field('use');
  if (use !== undefined && use !== 'sig') {
    return undefined;
  }
  const kidValue = field('kid');
  const kid = typeof kidValue === 'string' && kidValue.length > 0 && kidValue.length <= 200 ? kidValue : undefined;
  const declared = field('alg');
  if (field('kty') === 'RSA') {
    const n = field('n');
    const e = field('e');
    const modulus = typeof n === 'string' ? decodeBase64url(n, JWT_LIMITS.rsaModulusBytesMax) : undefined;
    const exponent = typeof e === 'string' ? decodeBase64url(e, 8) : undefined;
    if (modulus === undefined || exponent === undefined || modulus.length < JWT_LIMITS.rsaModulusBytesMin || (declared !== undefined && declared !== 'RS256')) {
      return undefined;
    }
    return { kid, algorithm: 'RS256', jwk: { kty: 'RSA', n: String(n), e: String(e), alg: 'RS256', ext: true } };
  }
  if (field('kty') === 'EC') {
    const x = field('x');
    const y = field('y');
    const px = typeof x === 'string' ? decodeBase64url(x, 32) : undefined;
    const py = typeof y === 'string' ? decodeBase64url(y, 32) : undefined;
    if (field('crv') !== 'P-256' || px?.length !== 32 || py?.length !== 32 || (declared !== undefined && declared !== 'ES256')) {
      return undefined;
    }
    return { kid, algorithm: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: String(x), y: String(y), alg: 'ES256', ext: true } };
  }
  return undefined;
}

export function createJwksCache(options: { readonly uri: string; readonly fetcher: Fetcher; readonly now?: () => number }): JwksCache {
  const now = options.now ?? Date.now;
  let keys: readonly JwtKey[] = [];
  let fetchedAt = 0;
  let attemptedAt = 0;
  let loading: Promise<boolean> | undefined;

  const refresh = (): Promise<boolean> => {
    loading ??= (async () => {
      attemptedAt = now();
      const answer = await fetchJson(options.fetcher, options.uri, { headers: { Accept: 'application/json' } });
      const parsed = answer.ok ? parseJwks(answer.value) : undefined;
      loading = undefined;
      if (parsed?.ok === true) {
        keys = parsed.value;
        fetchedAt = now();
        return true;
      }
      return false;
    })();
    return loading;
  };

  const pick = (kid: string | undefined, algorithm: JwtAlgorithm): JwtKey | undefined => {
    const candidates = keys.filter((key) => key.algorithm === algorithm && (kid === undefined || key.kid === kid));
    // Without a `kid` only a set with exactly one fitting key is unambiguous.
    return kid === undefined ? (candidates.length === 1 ? candidates[0] : undefined) : candidates[0];
  };

  return {
    keyFor: async (kid, algorithm) => {
      const fresh = keys.length > 0 && now() - fetchedAt < JWKS_LIMITS.cacheMs;
      const cached = fresh ? pick(kid, algorithm) : undefined;
      if (cached !== undefined) {
        return ok(cached);
      }
      const mayRefetch = !fresh || now() - attemptedAt >= JWKS_LIMITS.refetchCooldownMs;
      if (mayRefetch) {
        await refresh();
      }
      const usable = keys.length > 0 && now() - fetchedAt < JWKS_LIMITS.staleMs;
      if (!usable) {
        return err('unavailable');
      }
      const key = pick(kid, algorithm);
      return key === undefined ? err('key-unknown') : ok(key);
    },
  };
}
