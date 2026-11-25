import { cookie, sessionCookie, signSession, verifySession } from './session';

const cookieName = '__Host-studio-login-wait';

export async function loginWait(request: Request, secret: string): Promise<number> {
  const wait = await verifySession(cookie(request, cookieName), secret, 'login');
  return wait?.login === 'rate-limit' ? wait.expires : 0;
}

export async function waitCookie(until: number, secret: string): Promise<string> {
  const token = await signSession({ id: 1, login: 'rate-limit', expires: until, audience: 'login' }, secret);
  return sessionCookie(cookieName, token, Math.max(1, Math.ceil((until - Date.now()) / 1000)));
}
