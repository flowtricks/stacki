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
 * @param quietMs   how rarely to ask while the preview is healthy.
 */
export function createPreviewWatch({
  probe,
  onRecover,
  retryMs = 700,
  settleMs = 250,
  quietMs = 3000,
  timers = null,
}) {
  const setT = timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = timers?.clearTimeout ?? ((id) => clearTimeout(id))
  const now = timers?.now ?? (() => Date.now())

  let stopped = false
  let timer = null
  // Assumed healthy: the alternative is reloading once on the first probe of
  // every session, whether or not anything was ever wrong.
  let serving = true
  let inFlight = false
  // When the question was last put to the server, so a healthy preview is not
  // asked about over and over — see `poke`.
  let askedAt = -Infinity

  const ask = async () => {
    if (stopped || inFlight) return
    inFlight = true
    askedAt = now()
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
      // Asking is not free. The question is "is the dev server serving a page",
      // and the only way to ask it is to request the page — which makes the
      // server render the whole thing, for a status code. On a big page that is
      // a third of a second of the server's attention, and it was being spent
      // on EVERY write the app makes: a keystroke, a colour scrub, a variant
      // hovered in a dropdown. The canvas was then waiting behind a render it
      // had no use for, to be shown the one it did.
      //
      // While the preview is healthy there is nothing to recover from, so the
      // question can be put rarely; the moment it is not, it is asked as often
      // as it takes (see the retry above). What this costs is noticing a
      // breakage up to `quietMs` late — and nothing is waiting on that notice:
      // the canvas shows the error screen on its own, and the recovery that
      // matters is the one after the fix, which the retry loop is already
      // watching for by then.
      if (serving && now() - askedAt < quietMs) return
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
