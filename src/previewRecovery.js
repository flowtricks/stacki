// Getting the preview back after a compile error.
//
// A compile error replaces the site with the dev server's error screen. That
// screen is a plain page with no HMR client in it, so when the mistake is fixed
// nothing tells it — the preview goes on showing the error until someone presses
// refresh, which is the one moment you least expect to have to. Reloading the
// frame is the only way back, and something has to decide when.
//
// So: after anything that could have changed the site, ask the dev server
// whether it is serving a page again, and keep asking while the answer is no —
// a fix takes a moment to compile, and the first ask almost always lands too
// early. While the preview is healthy nothing is scheduled at all; the retry is
// only ever armed by a failed probe.

/**
 * @param probe    () => Promise<{ ok: boolean }>  — ask the dev server.
 * @param onRecover ()                             — reload the preview.
 * @param retryMs   how soon to ask again while it is still broken.
 * @param settleMs  how long to let a change land before asking at all.
 */
export function createPreviewWatch({ probe, onRecover, retryMs = 700, settleMs = 250, timers = null }) {
  const setT = timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = timers?.clearTimeout ?? ((id) => clearTimeout(id))

  let stopped = false
  let timer = null
  // Assumed healthy: the alternative is reloading once on the first probe of
  // every session, whether or not anything was ever wrong.
  let serving = true
  let inFlight = false

  const ask = async () => {
    if (stopped || inFlight) return
    inFlight = true
    let answer = null
    try {
      answer = await probe()
    } catch {
      // An unreachable server is not a page either — same verdict, and it keeps
      // asking, which is what a server still starting up needs.
      answer = { ok: false }
    } finally {
      inFlight = false
    }
    if (stopped) return
    if (!answer?.ok) {
      serving = false
      clearT(timer)
      timer = setT(ask, retryMs)
      return
    }
    // The edge is the whole point. An ordinary edit never leaves the serving
    // state, and reloading on those would throw away the live patching the app
    // does instead of a reload.
    if (!serving) {
      serving = true
      onRecover()
    }
  }

  return {
    /** Something may have changed the site — worth asking, once it settles. */
    poke() {
      if (stopped) return
      clearT(timer)
      timer = setT(ask, settleMs)
    },
    stop() {
      stopped = true
      clearT(timer)
    },
    /** For tests and for anything that wants to show the state. */
    isServing: () => serving,
  }
}
