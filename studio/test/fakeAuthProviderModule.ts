// The shape of studio/cloudflare/auth-provider.ts, for the workerd test: a default-exported factory. It refuses to start
// if core handed it a credential, which proves end to end that a provider never sees the session secret.
import type { AuthProviderFactory } from '../src/features/auth/authProvider';
import { createFakeProvider } from './fakeAuthProvider';

const factory: AuthProviderFactory = (setup) => {
  for (const name of ['SESSION_SECRET', 'CONTAINER_TOKEN', 'GITHUB_PRIVATE_KEY', 'GITHUB_CLIENT_SECRET', 'PREVIEW', 'DRAFTS']) {
    if (name in setup.environment) {
      throw new Error(`The provider was handed ${name}`);
    }
  }
  if (setup.environment['FAKE_PROVIDER_FLAG'] !== 'on') {
    throw new Error('The provider did not see its own variable');
  }
  return createFakeProvider();
};

export default factory;
