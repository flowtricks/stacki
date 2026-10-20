// Read by the idle timer so a build, upload, or save is never interrupted.
const pending = new Set<symbol>();
const settled = new Set<() => void>();
export function beginOperation() {
  const token = Symbol('operation');
  pending.add(token);
  return () => {
    const removed = pending.delete(token);
    if (removed && pending.size === 0) {
      for (const listener of settled) {
        listener();
      }
    }
    return removed;
  };
}
export function onOperationsSettled(listener: () => void) {
  // Only mounted editor sessions subscribe; cleanup releases each registration.
  if (settled.size >= 30) {
    throw new Error('Too many idle session listeners');
  }
  settled.add(listener);
  return () => {
    settled.delete(listener);
  };
}
export function hasPendingOperations() {
  return pending.size > 0;
}
export function mayPause(lastActivity: number, now: number, busy: boolean) {
  return !busy && now - lastActivity >= 300_000;
}
