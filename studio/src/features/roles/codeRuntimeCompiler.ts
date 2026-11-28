// The parser of the compiler that runs the site: Astro 7 compiles pages with `@astrojs/compiler-rs`, resolved here
// through the installed Astro so that it is that very copy. It is native code, and a failure in native code can end the
// process it happens in, which a thread does not contain. So it runs in a child process: one that dies or takes too long
// only refuses the change being read, and the next reading starts another. The child is given no environment, so it
// holds none of Studio's secrets.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { record } from '../../shared/validation';

export const RUNTIME_COMPILER_LIMITS = {
  callMsMax: 15_000,
  waitingMax: 500,
} as const satisfies Record<string, number>;

const PROGRAM = `
let loaded;
process.on('message', async ({ id, source }) => {
  try {
    loaded ??= import(process.argv[1]);
    const result = (await loaded).parse(source);
    const errors = result.diagnostics.filter((item) => item.severity === 'error').length;
    process.send({ id, value: JSON.stringify({ ast: result.ast, errors }) });
  } catch (error) {
    process.send({ id, failure: String(error) });
  }
});
process.on('disconnect', () => process.exit(0));
`;

function compilerAddress(): string {
  const astro = createRequire(import.meta.url).resolve('astro/package.json');
  return pathToFileURL(createRequire(astro).resolve('@astrojs/compiler-rs')).href;
}

let child: ChildProcess | undefined;

function running(): ChildProcess {
  if (child !== undefined && child.connected && child.exitCode === null && child.signalCode === null) {
    return child;
  }
  const started = spawn(process.execPath, ['-e', PROGRAM, '--', compilerAddress()], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
  // An idle reader never keeps Studio running; a call in progress does, through its timer.
  started.unref();
  started.channel?.unref();
  child = started;
  return started;
}

function ask(id: number, source: string): Promise<string> {
  const process = running();
  return new Promise<string>((resolve, reject) => {
    const settle = (outcome: () => void) => {
      clearTimeout(timer);
      process.off('message', answered);
      process.off('exit', ended);
      process.off('error', ended);
      outcome();
    };
    const fail = (reason: string) => {
      process.kill('SIGKILL');
      if (child === process) {
        child = undefined;
      }
      settle(() => reject(new Error(reason)));
    };
    const ended = () => fail('The site compiler stopped while reading this page');
    const answered = (message: unknown) => {
      const reply = record(message);
      if (reply['id'] !== id) {
        return;
      }
      const value = reply['value'];
      if (typeof value === 'string') {
        settle(() => resolve(value));
      } else {
        fail(`The site compiler failed: ${String(reply['failure'])}`);
      }
    };
    const timer = setTimeout(() => fail('The site compiler took too long'), RUNTIME_COMPILER_LIMITS.callMsMax);
    process.on('message', answered);
    process.once('exit', ended);
    process.once('error', ended);
    process.send({ id, source }, (error) => {
      if (error !== null) {
        ended();
      }
    });
  });
}

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;
let next = 0;

export interface RuntimeParse {
  readonly ast: Record<string, unknown>;
  readonly errors: number;
}

/** The syntax tree the site's compiler reads from a page. One call at a time, so a failure is the page's own. */
export async function parseAsRun(source: string): Promise<RuntimeParse> {
  assert(waiting < RUNTIME_COMPILER_LIMITS.waitingMax, 'Site compiler calls stay bounded');
  waiting++;
  const call = tail.then(() => ask(next++, source));
  tail = call.catch(() => undefined);
  try {
    const result = record(JSON.parse(await call));
    const errors = result['errors'];
    assert(typeof errors === 'number', 'The site compiler counts its errors');
    return { ast: record(result['ast']), errors };
  } finally {
    waiting--;
  }
}
