import { claimLoginAttempt, LoginAttempts, type LoginClaim } from '../src/features/auth/loginAttempts';

export function loginAttemptFixture() {
  let claims: readonly LoginClaim[] | undefined;
  const storage = {
    get: async (_key: string): Promise<unknown> => claims,
    put: async (_key: string, value: readonly LoginClaim[]) => {
      claims = value;
    },
  };
  // Model the atomic Durable Object storage transaction used in production.
  let transaction = Promise.resolve();
  const create = () =>
    new LoginAttempts((state, expires) => {
      const result = transaction.then(() => claimLoginAttempt(storage, state, expires));
      transaction = result.then(
        () => {},
        () => {},
      );
      return result;
    });
  return { create, storage };
}
