// One bundle of the canvas modules the lost-copy and go-to tests drive, so they share one set of regions.
export { collectRegions, regions, resetFocusCache, setTracking } from '../../electron/preload/frameRegions';
export { restoreUntracked, showTarget } from '../../electron/preload/frameUnhide';
