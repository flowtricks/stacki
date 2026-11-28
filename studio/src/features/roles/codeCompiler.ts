// Astro's compiler, run in a thread of its own so that nothing it does can stop Studio. It is a Go program in
// WebAssembly: some malformed pages make it panic, after which a timer it left behind throws where nothing can catch
// it, and the memory its tree takes is not given back, so a few dozen readings of a large page ran it out. A thread
// that fails or has read enough is ended, which frees everything, and the next reading starts another. It also keeps
// a long reading off the thread that serves editors.
import { Worker } from 'node:worker_threads';
import type { ParseResult } from '@astrojs/compiler/types';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { record } from '../../shared/validation';

export const COMPILER_LIMITS = {
  /** Characters read into trees by one thread before it is replaced. */
  parsedCharsMax: 150_000,
  /** The same for conversion to TSX, whose memory barely grows. */
  convertedCharsMax: 20_000_000,
  callMsMax: 30_000,
  waitingMax: 500,
} as const satisfies Record<string, number>;

// The thread's whole program. It is written here so that the built integration needs no second file to find. Asking
// for source positions would cost several times as much, so the tree is read without them.
const PROGRAM = `
const { parentPort, workerData } = require('node:worker_threads');
// A panic prints the whole Go stack; the caller learns of it from the failed call, so the thread's output is
// dropped here. Reading it from outside instead keeps Studio's process from ever exiting.
const drop = (chunk, encoding, done) => {
  const written = typeof encoding === 'function' ? encoding : done;
  if (written) written();
  return true;
};
process.stdout.write = drop;
process.stderr.write = drop;
const loaded = import(workerData.compiler);
parentPort.on('message', async ({ id, kind, source }) => {
  try {
    const compiler = await loaded;
    const result = kind === 'tree'
      ? await compiler.parse(source, { position: false })
      : await compiler.convertToTSX(source, { sourcemap: 'external' });
    const value = kind === 'tree' ? { ast: result.ast, diagnostics: result.diagnostics } : { code: result.code, diagnostics: result.diagnostics };
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({ id, failure: String(error) });
  }
});
`;

const TOOK_TOO_LONG = 'The page compiler took too long';

type Kind = 'tree' | 'tsx';

interface Waiting {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class CompilerThread {
  private readonly waiting = new Map<number, Waiting>();
  private readonly worker = new Worker(PROGRAM, { eval: true, workerData: { compiler: import.meta.resolve('@astrojs/compiler') } });
  private next = 0;
  private parsed = 0;
  private converted = 0;
  private retired = false;

  constructor() {
    this.worker.on('message', (message: unknown) => this.answer(message));
    this.worker.on('error', (error: unknown) => this.end(`The page compiler failed: ${String(error)}`));
    this.worker.on('exit', () => this.end('The page compiler stopped'));
    // An idle thread never keeps Studio running; a call in progress does, through its timer.
    this.worker.unref();
  }

  get usable(): boolean {
    return !this.retired && this.parsed <= COMPILER_LIMITS.parsedCharsMax && this.converted <= COMPILER_LIMITS.convertedCharsMax;
  }

  call(kind: Kind, source: string): Promise<unknown> {
    assert(this.waiting.size < COMPILER_LIMITS.waitingMax, 'Compiler calls stay bounded');
    const id = this.next++;
    if (kind === 'tree') {
      this.parsed += source.length;
    } else {
      this.converted += source.length;
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.end(TOOK_TOO_LONG), COMPILER_LIMITS.callMsMax);
      const settle = () => clearTimeout(timer);
      this.waiting.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.worker.postMessage({ id, kind, source });
    });
  }

  /** Ends the thread once nothing waits on it. */
  retire(): void {
    this.retired = true;
    if (this.waiting.size === 0) {
      void this.worker.terminate();
    }
  }

  private answer(message: unknown): void {
    const reply = record(message);
    const id = reply['id'];
    const waiting = typeof id === 'number' ? this.waiting.get(id) : undefined;
    if (waiting === undefined || typeof id !== 'number') {
      return;
    }
    this.waiting.delete(id);
    if (reply['failure'] === undefined) {
      waiting.resolve(reply['value']);
    } else {
      // After a panic the program is gone, whatever it was asked next.
      this.end(`The page compiler failed: ${String(reply['failure'])}`);
      waiting.reject(new Error(`The page compiler failed: ${String(reply['failure'])}`));
    }
    if (this.retired && this.waiting.size === 0) {
      void this.worker.terminate();
    }
  }

  private end(reason: string): void {
    this.retired = true;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    void this.worker.terminate();
    for (const call of waiting) {
      call.reject(new Error(reason));
    }
  }
}

let current: CompilerThread | undefined;
let spare: CompilerThread | undefined;

function thread(): CompilerThread {
  if (current === undefined || !current.usable) {
    current?.retire();
    current = spare ?? new CompilerThread();
    spare = undefined;
  }
  return current;
}

async function compile(kind: Kind, source: string): Promise<unknown> {
  const running = thread();
  const result = running.call(kind, source);
  // The next thread starts while this one works, so that replacing it adds no wait.
  if (!running.usable) {
    spare ??= new CompilerThread();
  }
  // A second failure is the page's own: the caller refuses the change or asks another way. A page that ran out of
  // time would only run out again, while every other write waits for this one.
  return result.catch((error: unknown) => {
    if (error instanceof Error && error.message === TOOK_TOO_LONG) {
      throw error;
    }
    return thread().call(kind, source);
  });
}

function isTree(value: unknown): value is ParseResult {
  const result = record(value);
  const tree = record(result['ast']);
  return tree['type'] === 'root' && Array.isArray(tree['children']) && Array.isArray(result['diagnostics']);
}

/** The compiler's syntax tree of a page. */
export async function parseAstro(source: string): Promise<ParseResult> {
  const result = await compile('tree', source);
  assert(isTree(result), 'The compiler answers a page with its tree');
  return result;
}

export interface Converted {
  readonly code: string;
  readonly errors: number;
}

/** The compiler's TSX reading of a page: the same tokenizer and parser, many times faster than its tree. */
export async function astroToTSX(source: string): Promise<Converted> {
  const result = record(await compile('tsx', source));
  const code = result['code'];
  const diagnostics = result['diagnostics'];
  assert(typeof code === 'string', 'The compiler answers a conversion with TSX');
  assert(Array.isArray(diagnostics), 'The compiler lists a conversion’s diagnostics');
  return { code, errors: diagnostics.filter((diagnostic: unknown) => record(diagnostic)['severity'] === 1).length };
}
