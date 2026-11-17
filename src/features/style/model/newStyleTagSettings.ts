// The project's `newStyleTag` setting as the Style panel's writers read it.
//
// The setting lives in `.stacki/styles.json` (shared/properties/newStyleTag.ts) and is read
// asynchronously; the panel's writers are synchronous, so the last value read is held here, the
// way host.ts holds the app state. Until a read lands, and in a project that never wrote the
// section, it is Stacki's default: a `<style is:global>` tag holding just the rules. The Settings page
// publishes a change here as it saves it, so the next write already uses it.

import { DEFAULT_NEW_STYLE_TAG, sameNewStyleTag, templateFrame, type NewStyleTagSettings, type TemplateFrame } from '../../../../shared/properties/newStyleTag';

let current: NewStyleTagSettings = DEFAULT_NEW_STYLE_TAG;
const listeners = new Set<() => void>();

export function getNewStyleTagSettings(): NewStyleTagSettings {
  return current;
}

export function publishNewStyleTagSettings(next: NewStyleTagSettings): void {
  if (sameNewStyleTag(next, current)) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

export function onNewStyleTagSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The template's frame; the stored template always parses (the file parser refuses one that does not), so a failure is a bug. */
export function newStyleTagFrame(settings: NewStyleTagSettings = current): TemplateFrame {
  const result = templateFrame(settings.content);
  if (!result.ok) {
    throw new Error(`Assertion failed: the stored new style tag template parses (${result.error.code})`);
  }
  return result.frame;
}
