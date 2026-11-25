import { useEffect, useReducer } from 'react';
import {
  EMPTY_PUBLISH_AVAILABILITY_MEMORY,
  PUBLISH_CONFIRM_DELAY_MS,
  reducePublishAvailability,
  shownPublishAvailability,
  type PublishAvailabilityEvent,
} from '../../../shared/properties/publishAvailabilityMemory';
import type { PublishAvailability } from '../../../shared/properties/publishState';

/**
 * The availability the Publish button may draw, shared by Desktop and Studio. Checks report into
 * it; it answers with the last confirmed state, and asks `requestCheck` for one more check when
 * a first "changes to publish" answer needs confirming.
 */
export function useConfirmedAvailability(requestCheck: () => void): {
  readonly availability: PublishAvailability;
  readonly report: (event: PublishAvailabilityEvent) => void;
} {
  const [memory, report] = useReducer(reducePublishAvailability, EMPTY_PUBLISH_AVAILABILITY_MEMORY);
  const held = memory.held;
  useEffect(() => {
    if (held === undefined) {
      return undefined;
    }
    const timer = setTimeout(requestCheck, PUBLISH_CONFIRM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [held, requestCheck]);
  return { availability: shownPublishAvailability(memory), report };
}
