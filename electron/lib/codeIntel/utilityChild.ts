// The intelligence process as Electron runs it: a utility process, with its own heap limit, that can die without
// taking anything with it. Electron's value is passed in, so this module loads wherever the host is tested.
import * as path from 'node:path';
import type { UtilityProcess, ForkOptions } from 'electron';
import { CODE_INTEL_LIMITS } from '../../../shared/ipc/codeIntel';
import type { IntelChild } from './host';

export function intelligenceProcess(utility: { readonly fork: (module: string, args?: string[], options?: ForkOptions) => UtilityProcess }): IntelChild {
  const child = utility.fork(path.join(__dirname, 'serviceProcess.js'), [], {
    serviceName: 'Stacki code intelligence',
    execArgv: [`--max-old-space-size=${CODE_INTEL_LIMITS.heapMegabytesMax}`],
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
