import { ok, err, type Result } from '../../vendor/stacki/shared/core/result';

export interface PublishConnection {
  readonly repository: string;
  readonly branch: string;
  readonly token: string;
}

/** Tokens never cross the browser boundary; only the authenticated container requests this grant. */
export function parsePublishConnection(input: unknown): Result<PublishConnection> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    // i18n-ignore: validation diagnostic thrown for a malformed stored publish connection; a person never sees it.
    return err({ code: 'connection', message: 'Invalid publish connection.' });
  }
  if (!('repository' in input) || !('branch' in input) || !('token' in input)) {
    // i18n-ignore: validation diagnostic thrown for a malformed stored publish connection; a person never sees it.
    return err({ code: 'connection', message: 'Incomplete publish connection.' });
  }
  const { repository, branch, token } = input;
  if (typeof repository !== 'string' || repository.length > 200 || !/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').includes('..')) {
    // i18n-ignore: validation diagnostic thrown for a malformed stored publish connection; a person never sees it.
    return err({ code: 'connection', message: 'Invalid publish repository.' });
  }
  if (
    typeof branch !== 'string' ||
    branch.length > 250 ||
    !/^[\w/-]+(?:\.[\w/-]+)*$/.test(branch) ||
    branch.startsWith('-') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  ) {
    // i18n-ignore: validation diagnostic thrown for a malformed stored publish connection; a person never sees it.
    return err({ code: 'connection', message: 'Invalid publish branch.' });
  }
  if (typeof token !== 'string' || token.length < 1 || token.length > 500 || /[\s\x00-\x1f]/.test(token)) {
    // i18n-ignore: validation diagnostic thrown for a malformed stored publish connection; a person never sees it.
    return err({ code: 'connection', message: 'Invalid publish credentials.' });
  }
  return ok({ repository, branch, token });
}
