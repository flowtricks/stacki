// The static demo's notices, handed to Studio's toast stack across a bundle boundary:
// demo.js and studio.js each hold their own copy of every module, so the toast module's
// listener cannot be shared. The detail stays unknown until this parser accepts it.
export const DEMO_NOTICE_EVENT = 'studio:demo-notice';
/** Told once the toast stack listens, so a notice found during startup is not lost. */
export const DEMO_NOTICE_READY_EVENT = 'studio:demo-notice-ready';
export const DEMO_NOTICE_CHARS_MAX = 500;

/** The notice's text, or undefined for anything that is not a bounded, non-empty string. */
export function parseDemoNotice(detail: unknown): string | undefined {
  if (typeof detail !== 'string') {
    return undefined;
  }
  return detail.length > 0 && detail.length <= DEMO_NOTICE_CHARS_MAX ? detail : undefined;
}
