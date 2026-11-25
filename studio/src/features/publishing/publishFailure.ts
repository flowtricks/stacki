import { AssertionError } from 'node:assert';
import { err, type Result } from '../../../vendor/stacki/shared/core/result';
import { DescribedError, problemOf } from '../../../vendor/stacki/shared/properties/describedError';
import { described, type Described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

/**
 * Expected I/O errors cross the legacy Publisher boundary without disguising assertions. The sentence travels twice, as English and
 * as a reference, because the Studio server has no language of its own: the browser translates what it receives.
 */
export class PublishFailure extends DescribedError {
  constructor(problem: Described) {
    super(problem);
  }
}

export function publishFailure(error: unknown): Result<never> {
  if (error instanceof AssertionError || (error instanceof Error && error.message.startsWith('Assertion failed:'))) {
    throw error;
  }
  // Described refusals keep their reference; operating-system and tool text stays as received.
  return err({
    code: 'publish',
    ...(error instanceof Error ? problemOf(error) : described('publish.studio.error.failed')),
  });
}

export function published<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new PublishFailure({ message: result.error.message, messageRef: result.error.messageRef });
}
