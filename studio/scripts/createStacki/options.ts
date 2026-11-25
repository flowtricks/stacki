import { STUDIO_AUTH_KINDS, isStudioAuthKind, type StudioAuthKind } from '../../vendor/stacki/shared/ipc/studioAuth';

/** Non-secret sign-in values given as flags, so a script or CI can answer what the wizard would ask. */
export interface AuthFlags {
  readonly auth: StudioAuthKind | undefined;
  readonly admin: string;
  readonly allowedDomains: string;
  readonly allowedEmails: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly name: string;
  readonly teamDomain: string;
  readonly aud: string;
  readonly teamDomainCheck: 'strict' | 'custom';
}

export interface CreateOptions extends AuthFlags {
  readonly directory: string;
  readonly yes: boolean;
  readonly mode: 'install' | 'help' | 'version' | 'agent';
}

// Each value flag maps to the field it fills. Long form only; a flag takes `--flag value` or `--flag=value`.
const VALUE_FLAGS = {
  '--auth': 'auth',
  '--auth-admin': 'admin',
  '--auth-allowed-domains': 'allowedDomains',
  '--auth-allowed-emails': 'allowedEmails',
  '--auth-client-id': 'clientId',
  '--auth-issuer': 'issuer',
  '--auth-name': 'name',
  '--auth-team-domain': 'teamDomain',
  '--auth-aud': 'aud',
} as const;
type ValueField = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

const ARGUMENTS_MAX = 24;

export function parseOptions(args: readonly string[]): CreateOptions {
  if (args.length > ARGUMENTS_MAX || args.some((arg) => arg.length > 4096)) {
    throw new Error('Too many or oversized arguments');
  }
  let directory = '.';
  let hasDirectory = false;
  let yes = false;
  let mode: CreateOptions['mode'] = 'install';
  const values: Record<ValueField, string | undefined> = {
    auth: undefined,
    admin: undefined,
    allowedDomains: undefined,
    allowedEmails: undefined,
    clientId: undefined,
    issuer: undefined,
    name: undefined,
    teamDomain: undefined,
    aud: undefined,
  };
  let teamDomainCheck: AuthFlags['teamDomainCheck'] = 'strict';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const equals = arg.indexOf('=');
    const flag = arg.startsWith('--') && equals > 0 ? arg.slice(0, equals) : arg;
    const field = valueField(flag);
    if (field !== undefined) {
      const inline = flag === arg ? undefined : arg.slice(equals + 1);
      const value = inline ?? args[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (inline === undefined) {
        index += 1;
      }
      values[field] = value;
    } else if (arg === '--auth-custom-domain') {
      teamDomainCheck = 'custom';
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--help' || arg === '-h') {
      mode = 'help';
    } else if (arg === '--version' || arg === '-v') {
      mode = 'version';
    } else if (arg === '--agent') {
      mode = 'agent';
    } else if (arg.startsWith('-')) {
      throw new Error('Unknown option: ' + arg);
    } else if (hasDirectory) {
      throw new Error('Specify only one existing project directory');
    } else {
      directory = arg;
      hasDirectory = true;
    }
  }
  return {
    directory,
    yes,
    mode,
    auth: authKind(values.auth),
    admin: values.admin ?? '',
    allowedDomains: values.allowedDomains ?? '',
    allowedEmails: values.allowedEmails ?? '',
    clientId: values.clientId ?? '',
    issuer: values.issuer ?? '',
    name: values.name ?? '',
    teamDomain: values.teamDomain ?? '',
    aud: values.aud ?? '',
    teamDomainCheck,
  };
}

function valueField(flag: string): ValueField | undefined {
  for (const [name, field] of Object.entries(VALUE_FLAGS)) {
    if (name === flag) {
      return field;
    }
  }
  return undefined;
}

function authKind(input: string | undefined): StudioAuthKind | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (isStudioAuthKind(input)) {
    return input;
  }
  throw new Error(`--auth must be one of: ${STUDIO_AUTH_KINDS.join(', ')}`);
}

export function requireSupportedNode(version: string): void {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = Number(parts?.[1]);
  const minor = Number(parts?.[2]);
  if (!parts || major < 22 || (major === 22 && minor < 19)) {
    throw new Error('Stacki Studio needs Node.js 22.19.0 or newer');
  }
}
