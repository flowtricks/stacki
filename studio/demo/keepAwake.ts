// The demo never pauses. Studio pauses an idle editor after five minutes and drops its
// connection, which saves a hosted container's running time. The demo has no server to
// stop, so the pause would only interrupt a visitor. Studio decides from its own idle
// timer alone (`useIdleSession`), with no setting a stand-in can answer, so the demo
// reports activity the way the canvas does, `studio:interaction`, well inside that
// window. Nothing is hidden: the editor stays connected and editable.
export const KEEP_AWAKE_MS = 60_000;

/** Studio's own idle window, for the test that holds this below it. */
export const STUDIO_IDLE_MS = 300_000;

/** Starts the reports for the page's lifetime. Called once, before Studio loads. */
export function installKeepAwake(target: EventTarget): () => void {
  const timer = setInterval(() => target.dispatchEvent(new Event('studio:interaction')), KEEP_AWAKE_MS);
  return () => clearInterval(timer);
}
