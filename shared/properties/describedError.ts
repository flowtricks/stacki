// An Error that carries the sentence twice: the English message every older reader, log and test sees, and the reference the
// renderer translates (docs/i18n-playbook.md section 7). Expected refusals that are thrown (a folder path, a role name) use it,
// so the screen can show them in the language on screen while `error.message` stays exactly what it always was.
import type { Described } from './i18n/messageRef';

export class DescribedError extends Error {
  readonly problem: Described;
  constructor(problem: Described) {
    super(problem.message);
    this.problem = problem;
  }
}

/** The sentence a thrown value describes: a described error keeps its reference, anything else only its message. */
export function problemOf(error: unknown): Described {
  if (error instanceof DescribedError) {
    return error.problem;
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
