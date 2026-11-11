// The RPC's file, sign-in and request methods (`files.*`, `auth.*`, `net.fetch`; docs/apps.md "Project
// files" and "Signing in"), as the dispatcher in appRpcHost.ts runs them. Kept
// beside it rather than in it so the dispatcher stays one switch of one-line
// cases. Each host supplies the two parts below: Desktop through main
// (src/app/shell/desktopAppAccess.ts), Studio through its server
// (studio/src/features/apps/StudioApps.tsx). A host without them answers each
// call with a reason, as any unavailable command does.
import { assert } from '../../../shared/core/assert';
import { can, type RoleView } from '../../../shared/properties/projectRoles';
import type { AppsResult } from '../../../shared/properties/apps';
import { parseAppFilePath, type AppFileAnswer, type AppFileContent, type AppFileListing, type AppFileOperation } from '../../../shared/properties/appFiles';
import type { AppAccessToken, AppAuthStatus } from '../../../shared/properties/appAuth';
import type { AppNetRequest, AppNetResponse } from '../../../shared/properties/appNet';
import { APP_METHODS, type AppEditOutcome, type AppMethod } from '../../../shared/properties/appsRpc';
import type { AppRpcContext, AppSession } from './appRpcHost';

/** The project's files, through the host's store; `label` names the undo step a change makes, where the editor keeps one. */
export interface AppHostFiles {
  readonly run: (appId: string, operation: AppFileOperation, label: string) => Promise<AppsResult<AppFileAnswer>>;
}

/** This person's sign-ins for each app, kept by the host's main process or server. */
export interface AppHostAuth {
  readonly connect: (appId: string, provider: string) => Promise<AppsResult<AppAuthStatus>>;
  readonly token: (appId: string, provider: string) => Promise<AppsResult<AppAccessToken>>;
  readonly disconnect: (appId: string, provider: string) => Promise<AppsResult<readonly AppAuthStatus[]>>;
  readonly status: (appId: string) => Promise<AppsResult<readonly AppAuthStatus[]>>;
  /** Hears a sign-in change for any app; returns the stop. */
  readonly watch: (listener: (appId: string) => void) => () => void;
}

/** Requests the host makes for apps, to their declared hosts only (electron/project/appNetFetch.ts). */
export interface AppHostNet {
  readonly fetch: (appId: string, request: AppNetRequest) => Promise<AppsResult<AppNetResponse>>;
}

/** The methods this module runs. */
export const APP_ACCESS_METHODS = [
  'files.list',
  'files.read',
  'files.write',
  'files.delete',
  'files.move',
  'files.mkdir',
  'auth.connect',
  'auth.token',
  'auth.disconnect',
  'auth.status',
  'net.fetch',
] as const satisfies readonly AppMethod[];
export type AppAccessMethod = (typeof APP_ACCESS_METHODS)[number];

/** A file change as the app hears it: applied with the paths it touched, or not with the reason. */
export type AppFileOutcome = { readonly applied: true; readonly paths: readonly string[] } | Extract<AppEditOutcome, { readonly applied: false }>;

/**
 * Why the role may not run a method: project files are raw code, so they need
 * `code:edit`, the feature that edits them by hand.
 */
export function accessRoleRefusal(method: AppMethod, role: RoleView): string | undefined {
  if (method.startsWith('files.') && !can(role, 'code:edit')) {
    return `The ${role.name} role cannot edit code, so apps cannot read or change project files for it`;
  }
  return undefined;
}

export async function runAccessMethod(
  method: AppAccessMethod,
  rawParams: unknown,
  session: AppSession,
  context: AppRpcContext,
): Promise<AppFileListing | AppFileContent | AppFileOutcome | AppAuthStatus | AppAccessToken | readonly AppAuthStatus[] | AppEditOutcome | AppNetResponse> {
  const { id: appId, name } = session.app.manifest;
  // The params were checked for every app; the app's own folder rules need its id.
  const own = (path: string, options: { readonly allowRoot: boolean }): string => parseAppFilePath(path, appId, options);
  switch (method) {
    case 'files.list': {
      const answer = await files(context).run(appId, { kind: 'list', dir: own(APP_METHODS['files.list'].params(rawParams).dir, { allowRoot: true }) }, '');
      return expectListing(answer);
    }
    case 'files.read': {
      const answer = await files(context).run(appId, { kind: 'read', path: own(APP_METHODS['files.read'].params(rawParams).path, { allowRoot: false }) }, '');
      return expectContent(answer);
    }
    case 'files.write': {
      const { path, content, encoding, label } = APP_METHODS['files.write'].params(rawParams);
      const target = own(path, { allowRoot: false });
      return change(context, appId, { kind: 'write', path: target, content, encoding }, label ?? `${name}: write ${target}`);
    }
    case 'files.delete': {
      const { path, label } = APP_METHODS['files.delete'].params(rawParams);
      const target = own(path, { allowRoot: false });
      return change(context, appId, { kind: 'delete', path: target }, label ?? `${name}: delete ${target}`);
    }
    case 'files.move': {
      const { from, to, label } = APP_METHODS['files.move'].params(rawParams);
      const source = own(from, { allowRoot: false });
      const target = own(to, { allowRoot: false });
      return change(context, appId, { kind: 'move', from: source, to: target }, label ?? `${name}: move ${source}`);
    }
    case 'files.mkdir': {
      const { path, label } = APP_METHODS['files.mkdir'].params(rawParams);
      const target = own(path, { allowRoot: false });
      return change(context, appId, { kind: 'mkdir', path: target }, label ?? `${name}: new folder ${target}`);
    }
    case 'auth.connect':
      return valueOf(await auth(context).connect(appId, APP_METHODS['auth.connect'].params(rawParams).provider));
    case 'auth.token':
      return valueOf(await auth(context).token(appId, APP_METHODS['auth.token'].params(rawParams).provider));
    case 'auth.disconnect': {
      const answer = await auth(context).disconnect(appId, APP_METHODS['auth.disconnect'].params(rawParams).provider);
      return answer.ok ? { applied: true } : { applied: false, reason: answer.message };
    }
    case 'auth.status':
      return valueOf(await auth(context).status(appId));
    case 'net.fetch': {
      const net = context.host.net;
      if (net === undefined) {
        throw new Error('Requests through Stacki are not available to apps in this editor');
      }
      return valueOf(await net.fetch(appId, APP_METHODS['net.fetch'].params(rawParams)));
    }
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

export function isAccessMethod(method: AppMethod): method is AppAccessMethod {
  return APP_ACCESS_METHODS.some((known) => known === method);
}

// A change: run while the app is marked as its origin, so the project change it makes reaches it as its own.
async function change(context: AppRpcContext, appId: string, operation: AppFileOperation, label: string): Promise<AppFileOutcome> {
  assert(operation.kind !== 'list', 'A listing is not a change');
  assert(operation.kind !== 'read', 'A read is not a change');
  const finish = context.editOrigin?.begin(appId);
  try {
    const answer = await files(context).run(appId, operation, label);
    if (!answer.ok) {
      return { applied: false, reason: answer.message };
    }
    return { applied: true, paths: expectChange(answer).paths };
  } finally {
    finish?.();
  }
}

function expectListing(answer: AppsResult<AppFileAnswer>): AppFileListing {
  const value = valueOf(answer);
  assert(value.kind === 'listing', 'A list answers with a listing');
  return value.listing;
}

function expectContent(answer: AppsResult<AppFileAnswer>): AppFileContent {
  const value = valueOf(answer);
  assert(value.kind === 'content', 'A read answers with content');
  return value.content;
}

function expectChange(answer: AppsResult<AppFileAnswer>): Extract<AppFileAnswer, { readonly kind: 'changed' }>['change'] {
  const value = valueOf(answer);
  assert(value.kind === 'changed', 'A change answers with the change');
  return value.change;
}

function valueOf<T>(answer: AppsResult<T>): T {
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value;
}

function files(context: AppRpcContext): AppHostFiles {
  const part = context.host.files;
  if (part === undefined) {
    throw new Error('Project files are not available to apps in this editor');
  }
  return part;
}

function auth(context: AppRpcContext): AppHostAuth {
  const part = context.host.auth;
  if (part === undefined) {
    throw new Error('Signing in is not available to apps in this editor');
  }
  return part;
}
