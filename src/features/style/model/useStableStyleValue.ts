import { useEffect, useRef } from 'react';

// Refreshes invalidate computed answers before the iframe can replace them.
// Keep the last answer only for the same element/property, never for a new
// selection. A settled empty answer still clears the old value normally.
export function useStableStyleValue(value: string, options: { readonly pending: boolean }, scope: readonly unknown[]) {
  const { pending } = options;
  const last = useRef({ value, scope });
  const same = scope.length === last.current.scope.length && scope.every((key, index) => key === last.current.scope[index]);
  useEffect(() => {
    if (!pending) {
      last.current = { value, scope };
    }
  });
  return pending && same ? last.current.value : value;
}
