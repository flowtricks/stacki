/** The environment a publishing command runs in: this process's, without Studio's private control channel. */
export function publishEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // Site automation may use deployment credentials, but never Studio's private control channel.
  for (const name of [
    'STUDIO_CONTAINER_TOKEN',
    'STUDIO_BACKEND_URL',
    'GITHUB_PRIVATE_KEY',
    'GITHUB_APP_ID',
    'GITHUB_INSTALLATION_ID',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'AI_API_KEY',
  ]) {
    delete environment[name];
  }
  return environment;
}

/**
 * The environment every Netlify CLI run starts from. CI=true and no terminal keep the CLI from ever prompting;
 * BROWSER=none keeps it from opening a page itself (Stacki opens only the sign-in address it has checked); its
 * telemetry and update notice stay off for runs Stacki starts. The site is always named by --site, never inherited.
 * NETLIFY_AUTH_TOKEN, when the machine or hosted Studio provides one, is left for the CLI to read.
 */
export function netlifyEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...publishEnvironment(),
    CI: 'true',
    NO_COLOR: '1',
    NETLIFY_TELEMETRY_DISABLED: '1',
    NO_UPDATE_NOTIFIER: '1',
    BROWSER: 'none',
  };
  delete environment['NETLIFY_SITE_ID'];
  return environment;
}
