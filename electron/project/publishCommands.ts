import { spawn } from 'node:child_process';
import { PUBLISH_LIMITS } from '../../shared/properties/publishConfig';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { hostingCommand, scriptCommand } from '../../shared/properties/publishCommands';
import type { PublishCommand } from '../../shared/properties/publishCommands';
import { resolvePublishExecutable } from './publishExecutable';
import { withWorkerAccount } from './publishWorkerConfig';

export async function runPublishScripts(root: string, scripts: readonly string[], environment: Readonly<Record<string, string>> = {}): Promise<void> {
  if (scripts.length > PUBLISH_LIMITS.hooksMax) {
    throw new Error('Publish hook exceeds eight scripts.');
  }
  for (const script of scripts) {
    await runPublishCommand(root, { ...scriptCommand(script), environment });
  }
}

export async function deployHosting(root: string, config: PublishConfig): Promise<void> {
  if (config.hosting.provider === 'none') {
    throw new Error('Choose a hosting provider in Publish settings.');
  }
  const command = hostingCommand(config.hosting);
  if (config.hosting.provider === 'cloudflare-workers') {
    await withWorkerAccount(root, config.hosting.accountId, (configuration) =>
      runPublishCommand(root, {
        ...command,
        arguments: [...command.arguments, '--config', configuration],
      }),
    );
  } else {
    await runPublishCommand(root, command);
  }
}

/** Run installed tools only: publishing must never implicitly download executable packages. */
export async function runPublishCommand(root: string, command: PublishCommand): Promise<void> {
  const resolved = resolvePublishExecutable(root, command);
  const environment = {
    ...publishEnvironment(),
    ...command.environment,
    CI: 'true',
    NO_COLOR: '1',
    npm_config_yes: 'false',
  };
  const argumentsList = [...resolved.arguments];
  const token = process.env['VERCEL_TOKEN'];
  if (command.executable === 'vercel' && token) {
    argumentsList.push('--token', token);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, argumentsList, {
      cwd: root,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Logs may contain credentials from third-party hooks. Keep them out of IPC and UI errors.
    let outputBytes = 0;
    let failure = '';
    const stop = (message: string) => {
      failure = message;
      stopPublishProcess(child.pid);
      child.kill('SIGKILL');
    };
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > PUBLISH_LIMITS.outputBytesMax) {
        stop('Command exceeded the 1 MiB output limit.');
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => stop('Command exceeded the ten-minute time limit.'), PUBLISH_LIMITS.commandTimeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${command.executable}. Install and authenticate it first.`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !failure) {
        resolve();
      } else {
        reject(new Error(failure || `${command.executable} failed (exit ${code}). Check its setup.`));
      }
    });
  });
}

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

export function stopPublishProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      const cleanup = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      cleanup.on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // The command may have exited between its timeout and process-group cleanup.
  }
}
