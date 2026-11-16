// One bundle of the frame's text modules, so a test that fills the region map and one
// that clicks text read the same module state.
module.exports = { ...require('../../electron/preload/frameRegions'), ...require('../../electron/preload/frameText') };
