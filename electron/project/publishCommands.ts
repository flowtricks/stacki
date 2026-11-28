import { spawn } from 'node:child_process';
import { PUBLISH_LIMITS } from '../../shared/properties/publishConfig';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { hostingCommand, scriptCommand } from '../../shared/properties/publishCommands';
import { resolvePublishExecutable, type ExecutableCommand } from './publishExecutable';
import { checkWorkerReady, withWorkerAccount } from './publishWorkerConfig';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { ok, type Result } from '../../shared/core/result';
import { netlifyEnvironment, publishEnvironment } from './publishEnvironment';
import { checkDeployScript } from './publishCustom';
import { deployNetlify, netlifyBuildPlan } from './publishNetlifyDeploy';
import { DescribedError } from '../../shared/properties/describedError';

export { publishEnvironment };

export async function runPublishScripts(
  root: string,
  scripts: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  withheld: readonly string[] = [],
): Promise<void> {
  if (scripts.length > PUBLISH_LIMITS.hooksMax) {
    throw new DescribedError(described('publish.command.hooksLimit'));
  }
  for (const script of scripts) {
    await runPublishCommand(root, { ...scriptCommand(script), environment, withheld });
  }
}

/**
 * Whether the saved hosting can deploy from this site right now, asked before Publish builds or pushes anything. A Worker
 * uses checkWorkerReady, the same check Add Worker ends with, so setup and Publish cannot disagree about a site.
 */
export async function checkHostingReady(root: string, config: PublishConfig): Promise<Result<void, Described>> {
  if (config.customHosting?.deploy === 'script') {
    const script = await checkDeployScript(root, config.customHosting.script);
    return script.ok ? ok(undefined) : script;
  }
  if (config.hosting.provider === 'cloudflare-workers') {
    const ready = await checkWorkerReady(root);
    return ready.ok ? ok(undefined) : ready;
  }
  if (config.hosting.provider === 'netlify') {
    const plan = await netlifyBuildPlan(root);
    return plan.ok ? ok(undefined) : plan;
  }
  return ok(undefined);
}

export async function deployHosting(root: string, config: PublishConfig, environment: Readonly<Record<string, string>> = {}): Promise<void> {
  if (config.customHosting?.deploy === 'script') {
    // The same contract as the publish hooks: a package.json script by name, never a command from the settings file.
    await runPublishScripts(root, [config.customHosting.script], environment);
    return;
  }
  if (config.hosting.provider === 'none') {
    throw new DescribedError(described('error.publish.chooseHosting'));
  }
  if (config.hosting.provider === 'netlify') {
    // Netlify checks the site, picks how to build, and reads back which site it deployed (publishNetlifyDeploy.ts).
    await deployNetlify(root, config.hosting, (command) => runPublishCommandOutput(root, command));
    return;
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

/**
 * Run installed tools only: publishing must never implicitly download executable packages. A package manager may run
 * here too, when Worker setup adds the deploy tool to the site as a development dependency.
 */
export async function runPublishCommand(root: string, command: ExecutableCommand): Promise<void> {
  await runPublishProcess(root, command, 'discard');
}

/** The same run, returning standard output for a command that reports its result there. It stays in this process. */
export async function runPublishCommandOutput(root: string, command: ExecutableCommand): Promise<string> {
  return runPublishProcess(root, command, 'keep');
}

async function runPublishProcess(root: string, command: ExecutableCommand, output: 'keep' | 'discard'): Promise<string> {
  const resolved = resolvePublishExecutable(root, command);
  const inherited = command.executable === 'netlify' ? netlifyEnvironment() : publishEnvironment();
  for (const name of command.withheld ?? []) {
    delete inherited[name];
  }
  const environment = {
    ...inherited,
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
    const printed: Buffer[] = [];
    let failure: Described | undefined;
    const stop = (problem: Described) => {
      failure = problem;
      stopPublishProcess(child.pid);
      child.kill('SIGKILL');
    };
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > PUBLISH_LIMITS.outputBytesMax) {
        stop(described('publish.command.outputLimit'));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      collect(chunk);
      // Bounded by the same output limit, which stops the command before more is kept.
      if (output === 'keep' && failure === undefined) {
        printed.push(chunk);
      }
    });
    child.stderr.on('data', collect);
    const timer = setTimeout(() => stop(described('publish.command.timeLimit')), PUBLISH_LIMITS.commandTimeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new DescribedError(described('publish.command.startFailed', { executable: command.executable })));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && failure === undefined) {
        resolve(Buffer.concat(printed).toString('utf8'));
      } else {
        reject(new DescribedError(failure ?? described('publish.command.exitFailed', { executable: command.executable, code: String(code) })));
      }
    });
  });
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
