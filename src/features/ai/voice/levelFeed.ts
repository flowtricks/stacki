// The waveform's feed: the audio meter publishes bars about twenty times a second, and only the
// small component that draws them listens. Going through React state in the composer would
// re-render the whole box twenty times a second for a picture.
import { assert } from '../../../../shared/core/assert';

export type LevelListener = (bars: readonly number[]) => void;

/** Listeners a feed accepts: one waveform, and a few spare for a popped-out panel. */
const LISTENERS_MAX = 8;

export interface LevelFeed {
  readonly subscribe: (listener: LevelListener) => () => void;
  readonly publish: (bars: readonly number[]) => void;
}

export function createLevelFeed(): LevelFeed {
  const listeners = new Set<LevelListener>();
  return {
    subscribe: (listener) => {
      assert(listeners.size < LISTENERS_MAX, 'createLevelFeed: listeners stay within the bound');
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    publish: (bars) => {
      for (const listener of listeners) {
        listener(bars);
      }
    },
  };
}
