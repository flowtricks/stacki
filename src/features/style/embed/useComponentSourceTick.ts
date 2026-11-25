// Keeps the component source cache (model/componentSourceCache.ts) current for the
// Style panel, and returns a version that moves whenever a file's text arrives or is
// dropped. The cache is cleared on the project's style-change signal, which the
// watcher sends for every `.astro` change, Stacki's own saves included (the file
// signal skips those), so a class written into a component's markup turns its chip
// green without a reload. The cache holds a few files, read again only when asked.

import { useEffect, useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import { onVariablesChanged } from '../../../ipc/editorEnvironment';
import { componentSourceVersion, forgetComponentSources, onComponentSourceChange } from '../model/componentSourceCache';

export function useComponentSourceTick(): number {
  useEffect(() => onVariablesChanged(() => forgetComponentSources([])), []);
  const version = useSyncExternalStore(onComponentSourceChange, componentSourceVersion);
  assert(Number.isSafeInteger(version), 'useComponentSourceTick: the version is an integer');
  return version;
}
