import { AssertionError } from 'node:assert';
import { err, type Result } from '../../../vendor/stacki/shared/core/result';

/** Expected I/O errors cross the legacy Publisher boundary without disguising assertions. */
export class PublishFailure extends Error {}

export function publishFailure(error: unknown): Result<never> {
  if (error instanceof AssertionError || (error instanceof Error && error.message.startsWith('Assertion failed:'))) {
    throw error;
  }
  return err({
    code: 'publish',
    message: error instanceof Error ? error.message : 'Publish failed.',
  });
}

export function published<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new PublishFailure(result.error.message);
}
