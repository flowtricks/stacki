import { studioTranslate } from '../../shared/studioTranslate';
export class StudioRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
export function responseError(response: Response) {
  if (response.status === 401) {
    return new StudioRequestError(studioTranslate('studio.request.sessionExpired'), 401);
  }
  if (response.status === 403) {
    return new StudioRequestError(studioTranslate('studio.request.notAuthorized'), 403);
  }
  if (response.status === 429) {
    const retry = response.headers.get('Retry-After');
    const message =
      retry && /^\d{1,6}$/.test(retry) ? studioTranslate('studio.request.rateLimitedWait', { seconds: retry }) : studioTranslate('studio.request.rateLimited');
    return new StudioRequestError(message, 429);
  }
  return new StudioRequestError(
    response.status >= 500 ? studioTranslate('studio.request.unavailable') : studioTranslate('studio.request.incomplete'),
    response.status,
  );
}
