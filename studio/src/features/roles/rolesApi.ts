// Goal: the Roles view's three server calls, parsed at the boundary (AGENTS.md §2): which sign-in method the site uses and
// whether the person may manage it, the passkey administration list and its commands. The server decides every one of them
// again (`canManage`, same-origin, roles.json write rules); this module only asks and parses.
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';

export interface AuthInfo {
  readonly provider: string;
  readonly displayName: string;
  readonly kind: 'built-in' | 'custom';
  readonly canManage: boolean;
  readonly origin: string;
  readonly me: string;
  readonly inviteHint: string | undefined;
}

export interface PasskeyPerson {
  readonly handle: string;
  readonly displayName: string | undefined;
  readonly locked: boolean;
  readonly passkeys: readonly { readonly id: string; readonly label: string; readonly createdAt: number; readonly lastUsedAt: number | undefined }[];
}
export interface PasskeyInvite {
  readonly hash: string;
  readonly handle: string;
  readonly displayName: string | undefined;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface PasskeyView {
  readonly people: readonly PasskeyPerson[];
  readonly invites: readonly PasskeyInvite[];
}

export const ROLES_API_LIMITS = { listMax: 500, textCharsMax: 400 } as const satisfies Record<string, number>;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= ROLES_API_LIMITS.textCharsMax ? value : undefined);
const time = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const object = (value: unknown): object | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined);
const field = (value: object, name: string): unknown => Reflect.get(value, name);
const list = (value: unknown): readonly unknown[] | undefined => (Array.isArray(value) && value.length <= ROLES_API_LIMITS.listMax ? value : undefined);

export function parseAuthInfo(input: unknown): Result<AuthInfo, string> {
  const value = object(input);
  const provider = value && text(field(value, 'provider'));
  const displayName = value && text(field(value, 'displayName'));
  const origin = value && text(field(value, 'origin'));
  const me = value && text(field(value, 'me'));
  const kind = value && field(value, 'kind');
  const canManage = value && field(value, 'canManage');
  if (!value || !provider || !displayName || !origin || !me || (kind !== 'built-in' && kind !== 'custom') || typeof canManage !== 'boolean') {
    return err('The sign-in information is malformed');
  }
  const hint = text(field(value, 'inviteHint'));
  return ok({ provider, displayName, kind, canManage, origin, me, inviteHint: hint });
}

export function parsePasskeyView(input: unknown): Result<PasskeyView, string> {
  const root = object(input);
  const result = root && object(field(root, 'result'));
  const view = result && object(field(result, 'view'));
  const handles = view && list(field(view, 'handles'));
  const invites = view && list(field(view, 'invites'));
  if (!handles || !invites) {
    return err('The passkey list is malformed');
  }
  const people: PasskeyPerson[] = [];
  for (const item of handles) {
    const person = object(item);
    const handle = person && text(field(person, 'handle'));
    const passkeys = person && list(field(person, 'passkeys'));
    if (!person || !handle || !passkeys) {
      return err('A passkey person is malformed');
    }
    const keys: PasskeyPerson['passkeys'][number][] = [];
    for (const raw of passkeys) {
      const key = object(raw);
      const id = key && text(field(key, 'id'));
      const label = key && text(field(key, 'label'));
      const createdAt = key && time(field(key, 'createdAt'));
      if (!key || !id || !label || createdAt === undefined) {
        return err('A passkey is malformed');
      }
      keys.push({ id, label, createdAt, lastUsedAt: time(field(key, 'lastUsedAt')) });
    }
    people.push({ handle, displayName: text(field(person, 'displayName')), locked: field(person, 'locked') === true, passkeys: keys });
  }
  const pending: PasskeyInvite[] = [];
  for (const item of invites) {
    const invite = object(item);
    const hash = invite && text(field(invite, 'hash'));
    const handle = invite && text(field(invite, 'handle'));
    const createdBy = invite && text(field(invite, 'createdBy'));
    const createdAt = invite && time(field(invite, 'createdAt'));
    const expiresAt = invite && time(field(invite, 'expiresAt'));
    if (!invite || !hash || !handle || !createdBy || createdAt === undefined || expiresAt === undefined) {
      return err('An invite is malformed');
    }
    pending.push({ hash, handle, displayName: text(field(invite, 'displayName')), createdBy, createdAt, expiresAt });
  }
  return ok({ people, invites: pending });
}

/** The invite a create command returns: the one-time link, shown once. */
export function parseInviteLink(input: unknown): Result<{ readonly link: string; readonly expiresAt: number }, string> {
  const root = object(input);
  const result = root && object(field(root, 'result'));
  const link = result && text(field(result, 'link'));
  const expiresAt = result && time(field(result, 'expiresAt'));
  return link && expiresAt !== undefined && field(result, 'kind') === 'invite' ? ok({ link, expiresAt }) : err('The invite is malformed');
}

export type Transport = (path: string, init?: RequestInit) => Promise<unknown>;

/** The page's own fetch: same origin, no caching, JSON in and out. A failure throws, so the view can show it. */
export const pageTransport: Transport = async (path, init) => {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok && !(typeof body === 'object' && body !== null)) {
    throw new Error(`Request failed (${response.status})`);
  }
  return body;
};

export async function loadAuthInfo(transport: Transport = pageTransport): Promise<Result<AuthInfo, string>> {
  return parseAuthInfo(await transport('/studio/api/auth/info'));
}

export async function loadPasskeys(transport: Transport = pageTransport): Promise<Result<PasskeyView, string>> {
  return parsePasskeyView(await transport('/studio/api/auth/passkeys'));
}

export type PasskeyCommand =
  | { readonly action: 'invite'; readonly handle: string; readonly displayName?: string }
  | { readonly action: 'revokeInvite'; readonly hash: string }
  | { readonly action: 'removeCredential'; readonly id: string }
  | { readonly action: 'lock'; readonly handle: string };

/** Sends one command; resolves with the raw answer for the caller to parse, or the server's refusal code. */
export async function sendPasskeyCommand(command: PasskeyCommand, transport: Transport = pageTransport): Promise<Result<unknown, string>> {
  const answer = await transport('/studio/api/auth/passkeys', { method: 'POST', body: JSON.stringify(command) });
  const body = object(answer);
  if (body === undefined || field(body, 'ok') !== true) {
    return err(body === undefined ? 'failed' : (text(field(body, 'error')) ?? 'failed'));
  }
  return ok(answer);
}
