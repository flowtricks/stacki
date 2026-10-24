import { createContext, useContext } from 'react';

// Embedders can offer content-only editing without mounting source editors.
export const CodeAccess = createContext(true);
export function useCodeAccess() {
  return useContext(CodeAccess);
}
export function ManagedValue() {
  return <span className="panel-note">Managed by Developer</span>;
}
