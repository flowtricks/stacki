// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the second half of the fence (designFence.ts).
//
// Wraps every call of Node's file system that creates, changes or removes a file, in the callback, synchronous and
// promise forms, so that while Design mode is on each one is checked against `designWriteAllowed` before it runs.
// A refused call fails the way the file system itself fails (EACCES), so every caller's existing error handling
// applies: the person sees the refusal as the toast that caller already shows for a failed write.
//
// Why wrap the module rather than each writer: the guarantee has to cover every path in this process, including
// the ones nobody listed. Main is compiled to CommonJS, where every named import of `fs` is a property read at the
// moment of the call (`(0, promises_1.writeFile)(…)`), so replacing the properties covers every caller. While the
// fence is down each wrapper only forwards, so installing it changes nothing about how the app writes.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { designWriteAllowed, designWriteRefusal } from './designFence';

/** Which arguments of a call name files it writes. */
type Targets = (args: readonly unknown[]) => readonly unknown[];

const first: Targets = (args) => [args[0]];
const second: Targets = (args) => [args[1]];
const both: Targets = (args) => [args[0], args[1]];

// O_WRONLY, O_RDWR, O_CREAT, O_TRUNC and O_APPEND: any of them means the file is opened to be written.
const WRITE_FLAG_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

const opened: Targets = (args) => {
  const flags = args[1];
  if (typeof flags === 'string') {
    return /[wa+]/.test(flags) ? [args[0]] : [];
  }
  if (typeof flags === 'number') {
    return (flags & WRITE_FLAG_BITS) === 0 ? [] : [args[0]];
  }
  return [];
};

/** The writing calls, by name, shared by the callback form and its `Sync` and promise forms. */
const WRITERS: ReadonlyMap<string, Targets> = new Map([
  ['writeFile', first],
  ['appendFile', first],
  ['mkdir', first],
  ['mkdtemp', first],
  ['rm', first],
  ['rmdir', first],
  ['unlink', first],
  ['truncate', first],
  ['chmod', first],
  ['utimes', first],
  ['rename', both],
  ['copyFile', second],
  ['cp', second],
  ['symlink', second],
  ['link', second],
  ['open', opened],
]);

let installed: 'no' | 'yes' = 'no';

/** Installs the wrappers once. Idempotent; inert until the fence is raised. */
export function guardDesignWrites(): void {
  if (installed === 'yes') {
    return;
  }
  installed = 'yes';
  const callbacks: Record<string, unknown> = fs;
  const promises: Record<string, unknown> = fs.promises;
  for (const [name, targets] of WRITERS) {
    wrap(callbacks, name, targets, 'callback');
    wrap(callbacks, `${name}Sync`, targets, 'sync');
    wrap(promises, name, targets, 'promise');
  }
  wrap(callbacks, 'createWriteStream', first, 'sync');
}

function wrap(owner: Record<string, unknown>, name: string, targets: Targets, form: 'callback' | 'sync' | 'promise'): void {
  const original = owner[name];
  if (typeof original !== 'function') {
    return;
  }
  const guarded = function (this: unknown, ...args: unknown[]): unknown {
    const refused = refusedTarget(targets(args));
    if (refused === undefined) {
      const result: unknown = Reflect.apply(original, this, args);
      return result;
    }
    const error = designWriteRefusal(refused);
    if (form === 'promise') {
      return Promise.reject(error);
    }
    if (form === 'callback') {
      const callback = [...args].reverse().find((arg) => typeof arg === 'function');
      if (typeof callback === 'function') {
        process.nextTick(() => {
          Reflect.apply(callback, undefined, [error]);
        });
        return undefined;
      }
    }
    throw error;
  };
  Object.defineProperty(owner, name, { value: guarded, configurable: true, writable: true, enumerable: true });
}

/** The first target that may not be written now, as a path. */
function refusedTarget(targets: readonly unknown[]): string | undefined {
  for (const target of targets) {
    const named = pathOf(target);
    if (named !== undefined && !designWriteAllowed(named)) {
      return named;
    }
  }
  return undefined;
}

// A file descriptor or a FileHandle was opened by a call checked here, so only names are checked.
function pathOf(target: unknown): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  if (target instanceof URL) {
    return target.protocol === 'file:' ? fileURLToPath(target) : undefined;
  }
  if (Buffer.isBuffer(target)) {
    return target.toString('utf8');
  }
  return undefined;
}
