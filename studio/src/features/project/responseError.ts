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
    return new StudioRequestError('Your Studio session expired. Sign in again.', 401);
  }
  if (response.status === 403) {
    return new StudioRequestError('Studio could not authorize this request. Check your access and retry.', 403);
  }
  if (response.status === 429) {
    const retry = response.headers.get('Retry-After');
    const wait = retry && /^\d{1,6}$/.test(retry) ? ` Wait ${retry} seconds before retrying.` : ' Please wait before retrying.';
    return new StudioRequestError('Studio is temporarily rate limited.' + wait, 429);
  }
  return new StudioRequestError(
    response.status >= 500
      ? 'Studio is restarting or temporarily unavailable. Please retry shortly.'
      : 'Studio returned an incomplete response. Refresh Studio and retry.',
    response.status,
  );
}
