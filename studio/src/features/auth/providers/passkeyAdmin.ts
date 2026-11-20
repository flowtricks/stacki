// Goal: the admin side of passkeys: invite a person, list, revoke an invite, remove one passkey, lock a handle out.
// The Worker calls this inside the Durable Object only after core's own checks (a verified session, the Studio origin and
// `canManage`), and it parses its input again here: a command is untrusted until it has been parsed (AGENTS.md §2).
// Invite codes are shown once, when created, and stored only as hashes; a list never contains a code.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { parseDisplayName, parseHandle, type PasskeyStore } from './passkeyStore';

export type PasskeyAdminCommand =
  | { readonly action: 'list' }
  | { readonly action: 'invite'; readonly handle: string; readonly displayName: string | undefined }
  | { readonly action: 'revokeInvite'; readonly hash: string }
  | { readonly action: 'removeCredential'; readonly id: string }
  | { readonly action: 'lock'; readonly handle: string };

export interface PasskeyAdminView {
  readonly handles: readonly {
    readonly handle: string;
    readonly displayName: string | undefined;
    readonly locked: boolean;
    readonly passkeys: readonly { readonly id: string; readonly label: string; readonly createdAt: number; readonly lastUsedAt: number | undefined }[];
  }[];
  readonly invites: readonly {
    readonly hash: string;
    readonly handle: string;
    readonly displayName: string | undefined;
    readonly createdBy: string;
    readonly createdAt: number;
    readonly expiresAt: number;
  }[];
}

export type PasskeyAdminResult =
  | { readonly kind: 'view'; readonly view: PasskeyAdminView }
  | { readonly kind: 'invite'; readonly link: string; readonly handle: string; readonly expiresAt: number }
  | { readonly kind: 'done' };

export type PasskeyAdminFailure = 'invalid' | 'handle-invalid' | 'locked' | 'full' | 'not-found';

export function parsePasskeyAdminCommand(input: unknown): Result<PasskeyAdminCommand, PasskeyAdminFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err('invalid');
  }
  const field = (name: string): unknown => Reflect.get(input, name);
  switch (field('action')) {
    case 'list':
      return ok({ action: 'list' });
    case 'invite': {
      const handle = parseHandle(field('handle'));
      if (handle === undefined) {
        return err('handle-invalid');
      }
      const raw = field('displayName');
      const displayName = parseDisplayName(raw);
      return raw !== undefined && raw !== '' && displayName === undefined ? err('invalid') : ok({ action: 'invite', handle, displayName });
    }
    case 'revokeInvite': {
      const hash = field('hash');
      return typeof hash === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(hash) ? ok({ action: 'revokeInvite', hash }) : err('invalid');
    }
    case 'removeCredential': {
      const id = field('id');
      return typeof id === 'string' && /^[A-Za-z0-9_-]{1,1400}$/.test(id) ? ok({ action: 'removeCredential', id }) : err('invalid');
    }
    case 'lock': {
      const handle = parseHandle(field('handle'));
      return handle === undefined ? err('handle-invalid') : ok({ action: 'lock', handle });
    }
    default:
      return err('invalid');
  }
}

export async function runPasskeyAdmin(
  store: PasskeyStore,
  command: PasskeyAdminCommand,
  context: { readonly origin: string; readonly actor: string; readonly nowMs: number },
): Promise<Result<PasskeyAdminResult, PasskeyAdminFailure>> {
  switch (command.action) {
    case 'list': {
      const handles = await store.listHandles();
      const view = await Promise.all(
        handles.map(async (record) => ({
          handle: record.handle,
          displayName: record.displayName,
          locked: record.lockedUntil > context.nowMs,
          passkeys: (await store.credentialsOf(record.handle)).map((credential) => ({
            id: credential.id,
            label: credential.label,
            createdAt: credential.createdAt,
            lastUsedAt: credential.lastUsedAt,
          })),
        })),
      );
      const invites = (await store.listInvites(context.nowMs)).map((invite) => ({
        hash: invite.hash,
        handle: invite.handle,
        displayName: invite.displayName,
        createdBy: invite.createdBy,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      }));
      return ok({ kind: 'view', view: { handles: view, invites } });
    }
    case 'invite': {
      const created = await store.createInvite({ handle: command.handle, displayName: command.displayName, createdBy: context.actor, nowMs: context.nowMs });
      if (!created.ok) {
        return err(created.error);
      }
      return ok({
        kind: 'invite',
        handle: command.handle,
        expiresAt: created.value.expiresAt,
        link: `${context.origin}/studio/auth/login?invite=${created.value.code}`,
      });
    }
    case 'revokeInvite':
      return (await store.revokeInvite(command.hash)) ? ok({ kind: 'done' }) : err('not-found');
    case 'removeCredential':
      return (await store.removeCredential(command.id)) ? ok({ kind: 'done' }) : err('not-found');
    case 'lock':
      return (await store.lockHandle(command.handle, context.nowMs)) ? ok({ kind: 'done' }) : err('not-found');
  }
}
