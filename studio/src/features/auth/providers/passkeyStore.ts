// Goal: everything the passkey provider remembers, and nothing in Git: handles, one-time invites (stored hashed), passkeys,
// and single-use challenges. It lives in the Durable Object's own storage, which only this instance's Worker can reach.
// Every read-modify-write runs inside `storage.transaction`, so two requests cannot both spend one invite, answer one
// challenge, or both advance one counter. Records are parsed when read back (a corrupted value is a programmer error that
// crashes loudly, never trusted), and every collection has a stated ceiling.
import { assert } from '../../../../vendor/stacki/shared/core/assert';
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { decodeBase64url, encodeBase64url, randomToken, sha256, utf8Bytes } from './base64url';
import { parseStoredKey, type StoredKey } from './webauthn';

export const PASSKEY_LIMITS = {
  handlesMax: 200,
  invitesMax: 100,
  credentialsMax: 500,
  credentialsPerHandleMax: 10,
  challengesMax: 256,
  inviteLifetimeMs: 7 * 86_400_000,
  challengeLifetimeMs: 300_000,
  /** How long a locked-out handle stays locked: the longest session, so no old session outlives the lock. */
  lockMs: 28_800_000,
  handleCharsMax: 64,
  displayNameCharsMax: 80,
  labelCharsMax: 60,
  inviteCodeBytes: 32,
  challengeBytes: 32,
} as const satisfies Record<string, number>;

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function parseHandle(input: unknown): string | undefined {
  return typeof input === 'string' && HANDLE_PATTERN.test(input) ? input : undefined;
}

export function parseDisplayName(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 && trimmed.length <= PASSKEY_LIMITS.displayNameCharsMax && !CONTROL.test(trimmed) ? trimmed : undefined;
}

export interface HandleRecord {
  readonly handle: string;
  readonly displayName: string | undefined;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly lockedUntil: number;
}
export interface InviteRecord {
  readonly hash: string;
  readonly handle: string;
  readonly displayName: string | undefined;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly expiresAt: number;
}
export interface CredentialRecord {
  readonly id: string;
  readonly handle: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | undefined;
  readonly key: StoredKey;
  readonly signCount: number;
}
export interface ChallengeRecord {
  readonly kind: 'create' | 'get';
  /** Core's one-time sign-in state this challenge was issued to: another browser's flow cannot answer it. */
  readonly state: string;
  readonly expiresAt: number;
}

/** The slice of Durable Object storage this store uses, so tests can supply a memory version with the same semantics. */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  list(options: { readonly prefix: string; readonly limit: number }): Promise<ReadonlyMap<string, unknown>>;
  transaction<T>(closure: (transaction: KeyValueStorage) => Promise<T>): Promise<T>;
}

export type InviteFailure = 'handle-invalid' | 'locked' | 'full';
export type EnrolFailure = 'invite-invalid' | 'locked' | 'credential-exists' | 'too-many';
export type CounterFailure = 'missing' | 'rollback';

export interface PasskeyStore {
  /** Whether the handle exists and is not locked out. The only call the Worker (outside the Durable Object) makes. */
  readonly handleActive: (handle: string, nowMs: number) => Promise<boolean>;
  readonly createInvite: (input: {
    readonly handle: string;
    readonly displayName: string | undefined;
    readonly createdBy: string;
    readonly nowMs: number;
  }) => Promise<Result<{ readonly code: string; readonly expiresAt: number }, InviteFailure>>;
  readonly peekInvite: (code: string, nowMs: number) => Promise<InviteRecord | undefined>;
  readonly revokeInvite: (hash: string) => Promise<boolean>;
  readonly listInvites: (nowMs: number) => Promise<readonly InviteRecord[]>;
  readonly putChallenge: (challenge: string, record: Omit<ChallengeRecord, 'expiresAt'>, nowMs: number) => Promise<Result<void, 'full'>>;
  readonly takeChallenge: (challenge: string, kind: ChallengeRecord['kind'], state: string, nowMs: number) => Promise<boolean>;
  readonly enrol: (input: {
    readonly code: string;
    readonly credentialId: string;
    readonly key: StoredKey;
    readonly signCount: number;
    readonly label: string;
    readonly nowMs: number;
  }) => Promise<Result<HandleRecord, EnrolFailure>>;
  readonly credential: (id: string) => Promise<CredentialRecord | undefined>;
  readonly handle: (handle: string) => Promise<HandleRecord | undefined>;
  readonly credentialsOf: (handle: string) => Promise<readonly CredentialRecord[]>;
  readonly listHandles: () => Promise<readonly HandleRecord[]>;
  readonly useCredential: (id: string, signCount: number, nowMs: number) => Promise<Result<void, CounterFailure>>;
  readonly removeCredential: (id: string) => Promise<boolean>;
  readonly lockHandle: (handle: string, nowMs: number) => Promise<boolean>;
}

export async function inviteHash(code: string): Promise<string> {
  return encodeBase64url(await sha256(utf8Bytes(`stacki-passkey-invite:${code}`)));
}

const key = {
  handle: (handle: string) => `passkey/handle/${handle}`,
  invite: (hash: string) => `passkey/invite/${hash}`,
  credential: (id: string) => `passkey/credential/${id}`,
  challenge: (challenge: string) => `passkey/challenge/${challenge}`,
};

export function createPasskeyStore(storage: KeyValueStorage): PasskeyStore {
  const handleOf = async (access: KeyValueStorage, handle: string) => parseOptional(await access.get(key.handle(handle)), parseHandleRecord);
  const credentialsIn = async (access: KeyValueStorage, handle?: string) => {
    const all = [...(await access.list({ prefix: 'passkey/credential/', limit: PASSKEY_LIMITS.credentialsMax + 1 })).values()].map(parseCredentialRecord);
    return handle === undefined ? all : all.filter((record) => record.handle === handle);
  };
  const invitesIn = async (access: KeyValueStorage) =>
    [...(await access.list({ prefix: 'passkey/invite/', limit: PASSKEY_LIMITS.invitesMax + 1 })).values()].map(parseInviteRecord);

  return {
    handleActive: async (handle, nowMs) => {
      const record = await handleOf(storage, handle);
      return record !== undefined && record.lockedUntil <= nowMs;
    },
    createInvite: (input) =>
      storage.transaction(async (access) => {
        if (parseHandle(input.handle) === undefined) {
          return err('handle-invalid');
        }
        const existing = await handleOf(access, input.handle);
        if (existing !== undefined && existing.lockedUntil > input.nowMs) {
          return err('locked');
        }
        const invites = (await invitesIn(access)).filter((invite) => invite.expiresAt > input.nowMs);
        if (
          invites.length >= PASSKEY_LIMITS.invitesMax ||
          (existing === undefined && (await access.list({ prefix: 'passkey/handle/', limit: PASSKEY_LIMITS.handlesMax + 1 })).size >= PASSKEY_LIMITS.handlesMax)
        ) {
          return err('full');
        }
        const code = randomToken(PASSKEY_LIMITS.inviteCodeBytes);
        const hash = await inviteHash(code);
        const expiresAt = input.nowMs + PASSKEY_LIMITS.inviteLifetimeMs;
        const displayName = input.displayName ?? existing?.displayName;
        await access.put(key.invite(hash), { hash, handle: input.handle, displayName, createdAt: input.nowMs, createdBy: input.createdBy, expiresAt });
        await access.put(key.handle(input.handle), {
          handle: input.handle,
          displayName,
          createdAt: existing?.createdAt ?? input.nowMs,
          createdBy: existing?.createdBy ?? input.createdBy,
          lockedUntil: 0,
        });
        return ok({ code, expiresAt });
      }),
    peekInvite: async (code, nowMs) => {
      const invite = parseOptional(await storage.get(key.invite(await inviteHash(code))), parseInviteRecord);
      return invite !== undefined && invite.expiresAt > nowMs ? invite : undefined;
    },
    revokeInvite: (hash) => storage.transaction(async (access) => (await access.delete(key.invite(hash))) === true),
    listInvites: async (nowMs) => (await invitesIn(storage)).filter((invite) => invite.expiresAt > nowMs),
    putChallenge: (challenge, record, nowMs) =>
      storage.transaction(async (access) => {
        const all = await access.list({ prefix: 'passkey/challenge/', limit: PASSKEY_LIMITS.challengesMax + 1 });
        let live = 0;
        for (const [name, value] of all) {
          if (parseChallengeRecord(value).expiresAt <= nowMs) {
            await access.delete(name);
          } else {
            live += 1;
          }
        }
        if (live >= PASSKEY_LIMITS.challengesMax) {
          return err('full');
        }
        await access.put(key.challenge(challenge), { ...record, expiresAt: nowMs + PASSKEY_LIMITS.challengeLifetimeMs });
        return ok(undefined);
      }),
    takeChallenge: (challenge, kind, state, nowMs) =>
      storage.transaction(async (access) => {
        const stored = parseOptional(await access.get(key.challenge(challenge)), parseChallengeRecord);
        // Deleted whatever the outcome: a challenge answered wrongly is spent, so it cannot be tried again.
        await access.delete(key.challenge(challenge));
        return stored !== undefined && stored.kind === kind && stored.state === state && stored.expiresAt > nowMs;
      }),
    enrol: (input) =>
      storage.transaction(async (access) => {
        const hash = await inviteHash(input.code);
        const invite = parseOptional(await access.get(key.invite(hash)), parseInviteRecord);
        if (invite === undefined || invite.expiresAt <= input.nowMs) {
          return err('invite-invalid');
        }
        const handle = await handleOf(access, invite.handle);
        if (handle === undefined || handle.lockedUntil > input.nowMs) {
          return err('locked');
        }
        if ((await access.get(key.credential(input.credentialId))) !== undefined) {
          return err('credential-exists');
        }
        const all = await credentialsIn(access);
        if (
          all.length >= PASSKEY_LIMITS.credentialsMax ||
          all.filter((record) => record.handle === handle.handle).length >= PASSKEY_LIMITS.credentialsPerHandleMax
        ) {
          return err('too-many');
        }
        // The invite is spent in the same transaction that stores the passkey: both happen or neither does.
        await access.delete(key.invite(hash));
        await access.put(key.credential(input.credentialId), {
          id: input.credentialId,
          handle: handle.handle,
          label: input.label,
          createdAt: input.nowMs,
          lastUsedAt: undefined,
          key: input.key,
          signCount: input.signCount,
        });
        return ok(handle);
      }),
    credential: async (id) => parseOptional(await storage.get(key.credential(id)), parseCredentialRecord),
    handle: (handle) => handleOf(storage, handle),
    credentialsOf: (handle) => credentialsIn(storage, handle),
    listHandles: async () => [...(await storage.list({ prefix: 'passkey/handle/', limit: PASSKEY_LIMITS.handlesMax + 1 })).values()].map(parseHandleRecord),
    useCredential: (id, signCount, nowMs) =>
      storage.transaction(async (access) => {
        const stored = parseOptional(await access.get(key.credential(id)), parseCredentialRecord);
        if (stored === undefined) {
          return err('missing');
        }
        // Checked again inside the transaction: two concurrent assertions with the same counter cannot both pass.
        if ((signCount !== 0 || stored.signCount !== 0) && signCount <= stored.signCount) {
          return err('rollback');
        }
        await access.put(key.credential(id), { ...stored, signCount, lastUsedAt: nowMs });
        return ok(undefined);
      }),
    removeCredential: (id) => storage.transaction(async (access) => (await access.delete(key.credential(id))) === true),
    lockHandle: (handle, nowMs) =>
      storage.transaction(async (access) => {
        const record = await handleOf(access, handle);
        if (record === undefined) {
          return false;
        }
        for (const credential of await credentialsIn(access, handle)) {
          await access.delete(key.credential(credential.id));
        }
        for (const invite of await invitesIn(access)) {
          if (invite.handle === handle) {
            await access.delete(key.invite(invite.hash));
          }
        }
        await access.put(key.handle(handle), { ...record, lockedUntil: nowMs + PASSKEY_LIMITS.lockMs });
        return true;
      }),
  };
}

function parseOptional<T>(value: unknown, parse: (input: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function record(input: unknown, what: string): object {
  assert(typeof input === 'object' && input !== null, `Stored ${what} is an object`);
  return input;
}
function stringField(input: object, name: string, what: string): string {
  const value: unknown = Reflect.get(input, name);
  assert(typeof value === 'string' && value.length > 0 && value.length <= 400, `Stored ${what}.${name} is a bounded string`);
  return value;
}
function optionalString(input: object, name: string): string | undefined {
  const value: unknown = Reflect.get(input, name);
  return typeof value === 'string' && value.length <= 400 ? value : undefined;
}
function numberField(input: object, name: string, what: string): number {
  const value: unknown = Reflect.get(input, name);
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `Stored ${what}.${name} is a safe integer`);
  return value;
}

// A corrupted record is a programmer or storage error, not a sign-in failure: it asserts, loudly, rather than being skipped.
export function parseHandleRecord(input: unknown): HandleRecord {
  const value = record(input, 'handle');
  const handle = stringField(value, 'handle', 'handle');
  assert(parseHandle(handle) !== undefined, 'Stored handle is valid');
  return {
    handle,
    displayName: optionalString(value, 'displayName'),
    createdAt: numberField(value, 'createdAt', 'handle'),
    createdBy: stringField(value, 'createdBy', 'handle'),
    lockedUntil: numberField(value, 'lockedUntil', 'handle'),
  };
}
export function parseInviteRecord(input: unknown): InviteRecord {
  const value = record(input, 'invite');
  return {
    hash: stringField(value, 'hash', 'invite'),
    handle: stringField(value, 'handle', 'invite'),
    displayName: optionalString(value, 'displayName'),
    createdAt: numberField(value, 'createdAt', 'invite'),
    createdBy: stringField(value, 'createdBy', 'invite'),
    expiresAt: numberField(value, 'expiresAt', 'invite'),
  };
}
export function parseCredentialRecord(input: unknown): CredentialRecord {
  const value = record(input, 'credential');
  const storedKey = parseStoredKey(Reflect.get(value, 'key'));
  assert(storedKey !== undefined, 'Stored credential holds a public key');
  const id = stringField(value, 'id', 'credential');
  assert(decodeBase64url(id, 1_023) !== undefined, 'Stored credential id is base64url');
  const lastUsed: unknown = Reflect.get(value, 'lastUsedAt');
  return {
    id,
    handle: stringField(value, 'handle', 'credential'),
    label: stringField(value, 'label', 'credential'),
    createdAt: numberField(value, 'createdAt', 'credential'),
    lastUsedAt: typeof lastUsed === 'number' && Number.isSafeInteger(lastUsed) ? lastUsed : undefined,
    key: storedKey,
    signCount: numberField(value, 'signCount', 'credential'),
  };
}
export function parseChallengeRecord(input: unknown): ChallengeRecord {
  const value = record(input, 'challenge');
  const kind: unknown = Reflect.get(value, 'kind');
  assert(kind === 'create' || kind === 'get', 'Stored challenge has a kind');
  return { kind, state: stringField(value, 'state', 'challenge'), expiresAt: numberField(value, 'expiresAt', 'challenge') };
}
