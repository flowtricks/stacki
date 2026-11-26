// The intelligence process as Electron runs it: a utility process, with its own heap limit, that can die without
// taking anything with it. Electron's value is passed in, so this module loads wherever the host is tested.
import * as path from 'node:path';
import type { ForkOptions } from 'electron';
import { CODE_INTEL_LIMITS } from '../../../shared/ipc/codeIntel';
import type { IntelChild } from './host';

/** What is used of a forked utility process. */
export interface ForkedProcess {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: () => void): unknown;
  kill(): boolean;
}

export interface Utility {
  readonly fork: (module: string, args: string[], options: ForkOptions) => ForkedProcess;
}

export function intelligenceProcess(utility: Utility): IntelChild {
  const child = utility.fork(path.join(__dirname, 'serviceProcess.js'), [], {
    serviceName: 'Stacki code intelligence',
    // A utility process ignores the flag given bare (its limit stays at V8's 4 GB); through `--js-flags` V8 takes it.
    execArgv: [`--js-flags=--max-old-space-size=${CODE_INTEL_LIMITS.heapMegabytesMax}`],
    stdio: 'ignore',
  });
  return {
    post: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', listener);
    },
    onExit: (listener) => {
      child.once('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
}
