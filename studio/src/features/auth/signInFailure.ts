export type SignInProblem = 'expired' | 'cancelled' | 'configuration' | 'unavailable' | 'access' | 'email' | 'rate-limit';
type SignInStage = 'callback' | 'token' | 'profile' | 'repository' | 'session';

export class SignInFailure extends Error {
  constructor(
    readonly problem: SignInProblem,
    readonly stage: SignInStage = 'callback',
    readonly status = 0,
    readonly code = 'unknown',
    readonly retryAt = 0,
  ) {
    super(problem);
    this.name = 'SignInFailure';
  }
}

export async function signInStep<T>(stage: SignInStage, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SignInFailure) {
      throw new SignInFailure(error.problem, stage, error.status, error.code, error.retryAt);
    }
    const code = error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'unexpected';
    throw new SignInFailure('unavailable', stage, 0, code);
  }
}

export const signInMessages: Record<SignInProblem, string> = {
  expired: 'This sign-in link expired or was already used. Start a new GitHub sign-in below.',
  cancelled: 'GitHub authorization was cancelled. Try again and authorize Stacki Studio.',
  configuration: 'GitHub sign-in needs attention from the site owner. Please ask them to check the GitHub App credentials and callback URL.',
  unavailable: 'GitHub sign-in is temporarily unavailable. Please try again below. If it continues, contact the site owner.',
  access: 'Your GitHub account needs Write access to this repository. Accept its invitation, then sign in again.',
  email: 'GitHub requires you to verify your primary email address before signing in. Open GitHub Settings → Emails, verify the address, then try again.',
  'rate-limit': 'GitHub is temporarily limiting sign-in requests. Please wait before trying again.',
};
