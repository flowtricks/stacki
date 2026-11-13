import type { MessageKey } from '../../../vendor/stacki/shared/properties/i18n/messages/en/studio';

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

// Each problem's sentence is a catalog key: the sign-in page is rendered by the Worker in the visitor's language (loginPage).
export const signInMessageKeys: Record<SignInProblem, MessageKey> = {
  expired: 'studio.login.problem.expired',
  cancelled: 'studio.login.problem.cancelled',
  configuration: 'studio.login.problem.configuration',
  unavailable: 'studio.login.problem.unavailable',
  access: 'studio.login.problem.access',
  email: 'studio.login.problem.email',
  'rate-limit': 'studio.login.problem.rateLimit',
};
