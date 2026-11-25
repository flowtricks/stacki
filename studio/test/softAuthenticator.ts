// Goal: a software WebAuthn authenticator for tests: it makes real keys, real authenticator data, real CBOR attestation
// objects and real signatures, so the verifier is tested against what browsers send, byte for byte, with no device.
// It can also be told to misbehave (wrong origin, wrong RP, another challenge) to build the hostile cases.
import { encodeBase64url, sha256, utf8Bytes } from '../src/features/auth/providers/base64url';

export function cbor(value: unknown): Uint8Array {
  const head = (major: number, length: number): number[] => {
    if (length < 24) {
      return [(major << 5) | length];
    }
    if (length < 256) {
      return [(major << 5) | 24, length];
    }
    return [(major << 5) | 25, length >> 8, length & 255];
  };
  if (typeof value === 'number') {
    return value >= 0 ? Uint8Array.from(head(0, value)) : Uint8Array.from(head(1, -1 - value));
  }
  if (typeof value === 'string') {
    const bytes = utf8Bytes(value);
    return Uint8Array.from([...head(3, bytes.length), ...bytes]);
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from([...head(2, value.length), ...value]);
  }
  if (value instanceof Map) {
    const parts: number[] = head(5, value.size);
    for (const [key, item] of value) {
      parts.push(...cbor(key), ...cbor(item));
    }
    return Uint8Array.from(parts);
  }
  throw new Error('unsupported test value');
}

const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

export interface SoftAuthenticatorOptions {
  readonly origin: string;
  readonly rpId: string;
  readonly algorithm?: 'ES256' | 'RS256' | 'EdDSA';
  readonly format?: 'none' | 'packed';
}

export interface Misbehaviour {
  readonly origin?: string;
  readonly rpId?: string;
  readonly challenge?: string;
  readonly type?: string;
  readonly userPresent?: boolean;
  readonly signCount?: number;
  readonly corruptSignature?: boolean;
  readonly attestationFormat?: string;
}

export async function softAuthenticator(options: SoftAuthenticatorOptions) {
  const algorithm = options.algorithm ?? 'ES256';
  const pair =
    algorithm === 'ES256'
      ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      : algorithm === 'RS256'
        ? await crypto.subtle.generateKey(
            { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
            true,
            ['sign', 'verify'],
          )
        : await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const b = (text: string | undefined) => Uint8Array.from(atob((text ?? '').replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
  const coseKey =
    algorithm === 'ES256'
      ? cbor(
          new Map<number, unknown>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, b(jwk.x)],
            [-3, b(jwk.y)],
          ]),
        )
      : algorithm === 'RS256'
        ? cbor(
            new Map<number, unknown>([
              [1, 3],
              [3, -257],
              [-1, b(jwk.n)],
              [-2, b(jwk.e)],
            ]),
          )
        : cbor(
            new Map<number, unknown>([
              [1, 1],
              [3, -8],
              [-1, 6],
              [-2, b(jwk.x)],
            ]),
          );
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  let counter = 0;

  const clientData = (type: string, challenge: string, origin: string) => utf8Bytes(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const rpHash = async (rpId: string) => sha256(utf8Bytes(rpId));
  const counterBytes = (value: number) => Uint8Array.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

  const sign = async (input: Uint8Array, corrupt: boolean): Promise<Uint8Array> => {
    const data = new Uint8Array(input);
    let signature: Uint8Array;
    if (algorithm === 'ES256') {
      signature = toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data)));
    } else if (algorithm === 'RS256') {
      signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, data));
    } else {
      signature = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, data));
    }
    if (corrupt) {
      const copy = Uint8Array.from(signature);
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
      return copy;
    }
    return signature;
  };

  return {
    credentialId: encodeBase64url(credentialId),
    algorithm,
    async create(challenge: string, bad: Misbehaviour = {}) {
      const origin = bad.origin ?? options.origin;
      const clientDataJSON = clientData(bad.type ?? 'webauthn.create', bad.challenge ?? challenge, origin);
      const flags = (bad.userPresent === false ? 0 : 1) | 0x04 | 0x40;
      const idLength = Uint8Array.from([credentialId.length >> 8, credentialId.length & 255]);
      const authData = concat(
        await rpHash(bad.rpId ?? options.rpId),
        Uint8Array.from([flags]),
        counterBytes(bad.signCount ?? 0),
        new Uint8Array(16),
        idLength,
        credentialId,
        coseKey,
      );
      const format = bad.attestationFormat ?? options.format ?? 'none';
      const statement =
        format === 'packed'
          ? new Map<string, unknown>([
              ['alg', algorithm === 'ES256' ? -7 : algorithm === 'RS256' ? -257 : -8],
              ['sig', await sign(concat(authData, await sha256(clientDataJSON)), bad.corruptSignature === true)],
            ])
          : format === 'packed-x5c'
            ? new Map<string, unknown>([
                ['alg', -7],
                ['sig', new Uint8Array(8)],
                ['x5c', new Map()],
              ])
            : new Map<string, unknown>();
      const attestationObject = cbor(
        new Map<string, unknown>([
          ['fmt', format === 'packed-x5c' ? 'packed' : format],
          ['attStmt', statement],
          ['authData', authData],
        ]),
      );
      return { clientDataJSON, attestationObject };
    },
    async get(challenge: string, bad: Misbehaviour = {}) {
      counter = bad.signCount ?? counter + 1;
      const clientDataJSON = clientData(bad.type ?? 'webauthn.get', bad.challenge ?? challenge, bad.origin ?? options.origin);
      const flags = (bad.userPresent === false ? 0 : 1) | 0x04;
      const authenticatorData = concat(await rpHash(bad.rpId ?? options.rpId), Uint8Array.from([flags]), counterBytes(counter));
      const signature = await sign(concat(authenticatorData, await sha256(clientDataJSON)), bad.corruptSignature === true);
      return { clientDataJSON, authenticatorData, signature };
    },
    /** The callback's `assertion` parameter, as the sign-in page builds it. */
    async assertionParameter(challenge: string, bad: Misbehaviour = {}, userHandle?: Uint8Array) {
      const made = await this.get(challenge, bad);
      const json = JSON.stringify({
        id: encodeBase64url(credentialId),
        clientDataJSON: encodeBase64url(made.clientDataJSON),
        authenticatorData: encodeBase64url(made.authenticatorData),
        signature: encodeBase64url(made.signature),
        ...(userHandle === undefined ? {} : { userHandle: encodeBase64url(userHandle) }),
      });
      return encodeBase64url(utf8Bytes(json));
    },
  };
}

function toDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start++;
    }
    const trimmed = bytes.slice(start);
    const body = (trimmed[0] ?? 0) & 0x80 ? Uint8Array.from([0, ...trimmed]) : trimmed;
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return Uint8Array.from([0x30, body.length, ...body]);
}
