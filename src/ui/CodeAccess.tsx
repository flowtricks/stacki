import { createContext, useContext } from 'react';
import { useTranslate } from '../lib/i18n/useTranslate';

// Embedders can offer content-only editing without mounting source editors.
export const CodeAccess = createContext(true);
export function useCodeAccess() {
  return useContext(CodeAccess);
}
export function ManagedValue() {
  const translate = useTranslate();
  return <span className="panel-note">{translate('ui.codeAccess.managed')}</span>;
}
