import { createContext, useContext } from 'react';
import type { MissingPublishField } from '../../../shared/properties/publishMissing';

// The empty field Save refused, so the dropdown that draws it can mark itself without every layer passing a prop.
// `undefined` is no field marked.
export const PublishInvalidFieldContext = createContext<MissingPublishField | undefined>(undefined);

/** Whether `field` is the one Save refused and is still empty. */
export function useIsInvalidPublishField(field: MissingPublishField): boolean {
  return useContext(PublishInvalidFieldContext) === field;
}
