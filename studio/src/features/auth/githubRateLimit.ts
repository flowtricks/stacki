// Honor GitHub's wait headers; without one, its guidance is to wait at least a minute.
export function retryAt(headers: Headers, now = Date.now()): number {
  const retry = headers.get('Retry-After');
  if (retry) {
    const time = /^\d+$/.test(retry) ? now + Number(retry) * 1000 : /^[A-Za-z]{3}, /.test(retry) ? Date.parse(retry) : NaN;
    if (Number.isSafeInteger(time) && time > now) {
      return time;
    }
  }
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isSafeInteger(reset) && reset > now) {
    return reset;
  }
  return now + 60_000;
}
