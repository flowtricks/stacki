// The project's variables as every picker shares them — loaded once, kept in
// one list that each open picker listens to — and which types a property can
// take (VariableConnect.tsx).

import { useEffect, useMemo, useState } from 'react';
import { streamProjectVariables, type ProjectVariable } from './model/webflow';
import { getHost } from './model/host';
import { projectRelative, variableFileOffered, type VariablePlace } from '../../editor/variablePlace';
import { assert } from '../../../shared/core/assert';

// Which variable types make sense for the property being edited: a color property
// (color / *-color / fill / stroke) shows only Color variables; font-family shows only
// FontFamily; everything else shows anything BUT Color and FontFamily (sizes / numbers /
// percentages). No prop → no filter (show all).
export const COLOR_PROP_RE = /(?:^|-)color$/;
// Properties whose value is a keyword/string rather than a length/number/color — a
// FontFamily (string) variable is a valid connection for these.
export const STRING_PROPS = new Set([
  'font-family',
  'text-transform',
  'text-align',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-skip-ink',
  'font-style',
  'white-space',
  'word-break',
  'overflow-wrap',
  'text-overflow',
  'text-wrap',
  'direction',
  'display',
  'position',
  'float',
  'clear',
  'visibility',
  'box-sizing',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-self',
  'justify-self',
  'justify-items',
  'align-content',
  'place-content',
  'place-items',
  'place-self',
  'grid-auto-flow',
  'background-repeat',
  'background-attachment',
  'background-clip',
  'background-origin',
  'background-blend-mode',
  'mix-blend-mode',
  'object-fit',
  'border-style',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'outline-style',
  'column-rule-style',
  'column-span',
  'backface-visibility',
  'transform-style',
  'will-change',
]);
export function varTypeAllowed(prop: string | undefined, type: string): boolean {
  if (!prop) {
    return true;
  }
  const property = prop.toLowerCase();
  if (COLOR_PROP_RE.test(property) || property === 'fill' || property === 'stroke') {
    return type === 'Color';
  }
  // Keyword/string props (incl. font-family) take a FontFamily or String variable —
  // both are "not a length, not a colour". A font stack that isn't named …font-family
  // (`--font-display: "Inter", sans-serif`) types as String, and a keyword variable
  // (`--h6-text-transform: none`) can only ever be String, so requiring FontFamily here
  // left those fields with an empty picker.
  if (STRING_PROPS.has(property)) {
    return type === 'FontFamily' || type === 'String';
  }
  return type !== 'Color' && type !== 'FontFamily';
}

// Nest variables Collection → Group → variable (a group may be empty for a variable
// that isn't in a folder). Input is pre-sorted, so map insertion order is stable.
export type VarCollection = {
  collection: string;
  groups: Array<{ group: string; items: ProjectVariable[] }>;
};
export function byCollection(vars: ProjectVariable[]): VarCollection[] {
  const colls = new Map<string, Map<string, ProjectVariable[]>>();
  for (const variable of vars) {
    let groups = colls.get(variable.collection);
    if (!groups) {
      groups = new Map();
      colls.set(variable.collection, groups);
    }
    const list = groups.get(variable.group);
    if (list) {
      list.push(variable);
    } else {
      groups.set(variable.group, [variable]);
    }
  }
  return [...colls.entries()].map(([collection, groups]) => ({
    collection,
    groups: [...groups.entries()].map(([group, items]) => ({ group, items })),
  }));
}

// Project variables are shared across every VariableConnect instance: a native binding
// reads back as the variable's NAME (not var(…)), so to show a chip we match the field
// value against a variable's name OR its var(…) binding. Loaded once, streamed
// progressively; instances subscribe to re-render as entries (and the chip) resolve.
export let sharedVars: ProjectVariable[] = [];
export let sharedDone = false;
export let sharedLoading = false;
export const sharedListeners = new Set<() => void>();
// Which load may still publish: a change starts a new one and retires the last.
let sharedLoad = 0;
export function ensureSharedVars() {
  if (sharedDone || sharedLoading) {
    return;
  }
  sharedLoading = true;
  sharedLoad += 1;
  const load = sharedLoad;
  // A reload streams into the same list by replacing it at the end, so a picker that
  // is open keeps its rows rather than emptying and filling again.
  const reloading = sharedVars.length > 0;
  const loaded: ProjectVariable[] = [];
  const seen = new Set<string>();
  void streamProjectVariables(
    (variable) => {
      // A name declared in two files is two entries; which one is offered is
      // decided where the list is read (variablesAt), by the page open then.
      const key = `${variable.file ?? ''}\u0000${variable.binding}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      loaded.push(variable);
      if (load === sharedLoad && !reloading) {
        sharedVars = [...loaded];
        sharedListeners.forEach((listener) => listener());
      }
    },
    () => load !== sharedLoad,
    reloadSharedVars,
  ).then(() => {
    if (load !== sharedLoad) {
      return;
    }
    sharedVars = loaded;
    sharedDone = true;
    sharedLoading = false;
    sharedListeners.forEach((listener) => listener());
  });
}

// The list outlives any picker, and a variable edited in the panel, in a stylesheet
// or in a page's `<style>` must not be offered at its old value, or at all once gone.
function reloadSharedVars(): void {
  sharedDone = false;
  sharedLoading = false;
  ensureSharedVars();
}
/**
 * The variables that can apply where the user is: never another page's `<style>`
 * variables (variablePlace.ts), and one entry per name. Where several files
 * declare a name, the open file's value is the one this canvas has, then the
 * page a component is shown on, then the first read (stylesheets before other
 * blocks), which is the order the list was streamed in.
 */
export function variablesAt(vars: readonly ProjectVariable[], place: VariablePlace): ProjectVariable[] {
  assert(place.openFile !== '', 'variablesAt: an open file has a path');
  const rankOf = (variable: ProjectVariable): number => {
    if (variable.file === undefined) {
      return 2;
    }
    if (variable.file === place.openFile) {
      return 0;
    }
    return variable.file === place.contextPage ? 1 : 2;
  };
  const chosen = new Map<string, ProjectVariable>();
  for (const variable of vars) {
    if (variable.file !== undefined && !variableFileOffered(variable.file, place)) {
      continue;
    }
    const held = chosen.get(variable.binding);
    if (held === undefined) {
      chosen.set(variable.binding, variable);
    } else if (rankOf(variable) < rankOf(held)) {
      chosen.set(variable.binding, variable);
    }
  }
  const offered = vars.filter((variable) => chosen.get(variable.binding) === variable);
  assert(offered.length === chosen.size, 'variablesAt: one entry per offered name');
  return offered;
}

/** Where the style panel says the user is: the file on the canvas, and the page it is shown on. */
export function hostVariablePlace(): VariablePlace {
  const host = getHost();
  return {
    openFile: projectRelative(host.projectPath, host.openFilePath),
    contextPage: projectRelative(host.projectPath, host.contextPagePath),
  };
}

export function useSharedVars({ active }: { active: boolean }): {
  vars: ProjectVariable[];
  loading: boolean;
} {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    ensureSharedVars();
    const listener = () => force((count) => count + 1);
    sharedListeners.add(listener);
    return () => {
      sharedListeners.delete(listener);
    };
  }, [active]);
  // The host is read each render, not subscribed to: every reader re-renders when
  // the page or the selection changes, and a picker opens on a fresh render.
  const { openFile, contextPage } = hostVariablePlace();
  const listed = sharedVars;
  const vars = useMemo(() => variablesAt(listed, { openFile, contextPage }), [listed, openFile, contextPage]);
  return { vars, loading: !sharedDone };
}
