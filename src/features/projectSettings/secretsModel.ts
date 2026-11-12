// What the Secrets tab decides without a screen: whether a draft name or value may be sent, and the
// message that says why not. The rules are the main process's (shared/properties/envFile.ts), checked
// here first so a person sees the reason beside the field instead of after a round trip.
import { ENV_LIMITS, envValueProblem, isEnvName } from '../../../shared/properties/envFile';
import type { SecretsErrorCode, SecretSummary } from '../../../shared/properties/secrets';
import type { MessageKey } from '../../lib/i18n/localeContext';

/** What a masked row shows: a fixed run of bullets, so the real length is never visible. */
export const SECRET_MASK = '••••••••';

/** The valid name pattern as an example in an empty name field. */
export const SECRET_NAME_EXAMPLE = 'API_KEY';

export type DraftProblem = 'nameEmpty' | 'invalidName' | 'nameTooLong' | 'nameTaken' | 'valueTooLong' | 'invalidValue';

/** The message key for a draft problem or a failure code from main. */
export function problemKey(problem: DraftProblem | SecretsErrorCode): MessageKey {
  switch (problem) {
    case 'nameEmpty':
      return 'settings.secrets.error.nameEmpty';
    case 'invalid-name':
    case 'invalidName':
      return 'settings.secrets.error.invalidName';
    case 'nameTooLong':
      return 'settings.secrets.error.nameTooLong';
    case 'name-taken':
    case 'nameTaken':
      return 'settings.secrets.error.nameTaken';
    case 'valueTooLong':
      return 'settings.secrets.error.valueTooLong';
    case 'invalid-value':
    case 'invalidValue':
      return 'settings.secrets.error.invalidValue';
    case 'changed':
      return 'settings.secrets.error.changed';
    case 'not-found':
      return 'settings.secrets.error.notFound';
    case 'read-only':
      return 'settings.secrets.error.readOnly';
    case 'limit':
      return 'settings.secrets.error.limit';
    case 'unreadable':
      return 'settings.secrets.error.unreadable';
    case 'too-large':
      return 'settings.secrets.error.tooLarge';
    case 'not-text':
      return 'settings.secrets.error.notText';
    case 'denied':
      return 'settings.secrets.error.denied';
    case 'filesystem':
      return 'settings.secrets.error.filesystem';
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

/** Why `name` cannot be saved as the name of the secret at `own` (absent for a new one), or undefined. */
export function nameProblem(name: string, entries: readonly SecretSummary[], own: number | undefined): DraftProblem | undefined {
  if (name.length === 0) {
    return 'nameEmpty';
  }
  if (name.length > ENV_LIMITS.nameCharsMax) {
    return 'nameTooLong';
  }
  if (!isEnvName(name)) {
    return 'invalidName';
  }
  if (entries.some((entry) => entry.name === name && entry.index !== own)) {
    return 'nameTaken';
  }
  return undefined;
}

export function valueProblem(value: string): DraftProblem | undefined {
  const problem = envValueProblem(value);
  if (problem === undefined) {
    return undefined;
  }
  return problem === 'too-long' ? 'valueTooLong' : 'invalidValue';
}

/** Whole kibibytes in the value limit, for the message. */
export const VALUE_KIB_MAX = Math.floor(ENV_LIMITS.valueBytesMax / 1024);
