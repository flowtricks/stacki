// The style panel's edits on their way to the canvas (liveRules.ts there). The panel
// emits; the preview canvas, which holds the frame, forwards each edit to it.
import type { LiveRule } from './liveRules';

type Listener = (rule: LiveRule) => void;
const listeners = new Set<Listener>();

export const liveRuleBus = {
  emit(rule: LiveRule): void {
    for (const listener of listeners) {
      listener(rule);
    }
  },
  listen(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
