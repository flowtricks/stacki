// A designer's words for a sign-in that is not a usual account sign-in. Why it is said at all: an agent using a
// key or a cloud provider may bill someone other than the account the person signed in with.
import type { SignInSource } from '../../../shared/ipc/aiChat';
import type { Translator } from '../../lib/i18n/localeContext';

export interface SignInSourceText {
  readonly label: string;
  readonly hint: string;
}

export function signInSourceText(source: Exclude<SignInSource, 'account'>, agent: string, translate: Translator): SignInSourceText {
  switch (source) {
    case 'api-key':
      return { label: translate('ai.signInSource.apiKey'), hint: translate('ai.signInSource.apiKey.hint', { agent }) };
    case 'token':
      return { label: translate('ai.signInSource.token'), hint: translate('ai.signInSource.token.hint', { agent }) };
    case 'cloud':
      return { label: translate('ai.signInSource.cloud'), hint: translate('ai.signInSource.cloud.hint', { agent }) };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
