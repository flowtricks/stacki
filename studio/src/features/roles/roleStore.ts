export type EditorRole = 'designer' | 'client';
const listeners = new Set<() => void>();
let current: EditorRole | undefined;

export function getEditorRole(): EditorRole {
  if (current) {
    return current;
  }
  try {
    current = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('studio-role') === 'client' ? 'client' : 'designer';
  } catch {
    current = 'designer';
  }
  return current;
}
export function setEditorRole(role: EditorRole) {
  current = role;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('studio-role', role);
    }
  } catch {
    /* Role switching also works when browser storage is unavailable. */
  }
  for (const listener of listeners) {
    listener();
  }
}
export function subscribeRole(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clientPanel(panel: string | undefined) {
  return !['code', 'variables', 'properties', 'ai'].includes(panel ?? '');
}
