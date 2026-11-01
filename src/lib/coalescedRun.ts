// One run in flight and at most one waiting behind it (plan §7, §11.9: one
// read per tick). A caller that asks while a run is under way is answered by
// the next run, which starts only after the running one ends — so every answer
// comes from a run that began after its caller asked, and a burst of any size
// costs at most two runs. This replaces the rescan chain and the panels' drain
// loops, which followed newer requests in a loop capped by rescanChainMax and
// saveDrainMax: there is no loop left to cap. Each run is one tick, started by
// a request, and the requests that arrive while one waits share its answer.
import { assert } from '../../shared/core/assert';

export interface CoalescedRun<T> {
  /** The result of a run that starts no earlier than this call. */
  readonly request: () => Promise<T>;
  /** Whether a newer run waits behind the one running: a run can ask this
   * before publishing, so a result a newer one supersedes is never shown. */
  readonly superseded: () => boolean;
}

interface Waiting<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

type Phase<T> = { readonly tag: 'idle' } | { readonly tag: 'running'; readonly waiting: Waiting<T> | undefined };

export function createCoalescedRun<T>(run: () => Promise<T>): CoalescedRun<T> {
  // The coordinator's one piece of state, owned here and never handed out.
  let phase: Phase<T> = { tag: 'idle' };
  // A run starts the next one from its settled promise's callback, not from the stack:
  // each run starts on its own microtask, and at most one run waits.
  // eslint-disable-next-line stacki/bounded-recursion -- promise re-entry, not recursion
  const start = (answer: Waiting<T>): void => {
    phase = { tag: 'running', waiting: undefined };
    void Promise.resolve()
      .then(run)
      .then(answer.resolve, answer.reject)
      .finally(() => {
        assert(phase.tag === 'running', 'Only a started run ends');
        const next = phase.waiting;
        if (next === undefined) {
          phase = { tag: 'idle' };
        } else {
          start(next);
        }
      });
  };
  return {
    request: () => {
      if (phase.tag === 'idle') {
        const answer = waiting<T>();
        start(answer);
        return answer.promise;
      }
      const next = phase.waiting ?? waiting<T>();
      phase = { tag: 'running', waiting: next };
      assert(phase.waiting === next, 'A request joins the one waiting run');
      return next.promise;
    },
    superseded: () => phase.tag === 'running' && phase.waiting !== undefined,
  };
}

function waiting<T>(): Waiting<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  assert(resolve !== undefined, 'The executor ran synchronously');
  assert(reject !== undefined, 'The executor ran synchronously');
  return { promise, resolve, reject };
}
