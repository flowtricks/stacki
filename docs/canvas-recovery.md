# Canvas recovery from an error page

The product rule: **when the page stops compiling or rendering and the cause goes away, the canvas
comes back by itself.** Nobody presses Reload canvas.

## Why it did not recover

The dev server answers a failing page with its own error screen, which carries no HMR client, so
nothing in the frame can hear the fix. The old watch (`previewRecovery.ts`) asked the server only
after a failed navigation of exactly the open route and assumed "serving" otherwise, so:

| Gap | Effect |
|---|---|
| Failure matched by exact URL | A query (loop source), a defaults rendering or a trailing slash: failure ignored, never polled |
| "Serving" assumed until a navigation failed | An error that arrived any other way (cut-off page, between two checks) left it asleep |
| Verdict was the HTTP status only | A 200 cut-off page counted as recovered |
| Healthy pages judged "truncated" | Stacki's marks and the page script follow `</html>`; a healthy marked page failed the end-of-document test (fixed in `shared/ipc/previewHealth.ts`) |
| Poll every 700 ms forever | A persistent error rendered the page twice a second until the window closed |

## The contract

`src/features/preview/canvasRecovery.ts` is a controller over a union state: `healthy`, `error`
(with where its polling stands), `recovering`. One check in flight, newest request wins.

- **Triggers**: the app's writes (apply, undo, redo), a watcher event for an outside change, a dev
  server (re)start, the window coming to the front, a frame load, a failed navigation of the page.
- **Poll**: 400, 800, 1600, 3000 ms, then every 5 s, for 120 s from the error (or the last trigger),
  then it stops; the next trigger starts it again. Hidden window: one check per 30 s; back in front:
  at once. Another page or leaving cancels every timer.
- **Healthy** canvas: one check per burst of writes, at most one per 1.5 s.
- **Transient**: unreachable, dropped or a 500 without words, within 3 s of a write or restart, is
  "still compiling": looked at again after 400 ms, no error state, no notice.
- **Same error**: nothing visible. **Different error**: the notice is replaced once.
- **Recovered**: the canvas reloads through `PreviewFrame`, which keeps the old document visible until
  the new one is ready (no blank flash). The notice goes away with "Fixed: the page is back". Selection
  comes from the editor and redraws on the new frame's render; scroll is restored by
  `electron/preload/frameScrollMemory.ts` (only when an error screen stood between two healthy
  documents of the route). Reloads that the page then fails again are capped (3 per minute).
- **Notice** (`appCompileRecovery.ts`): the dev server's words, "Undo last change" when the failure
  follows the app's own write, and "Reload canvas".

## An overlay over a page that loaded

Some errors never reach the page's answer: the page loads with a 200, then a module it asked for fails
and the dev server's HMR client draws its error overlay (`vite-error-overlay`, Astro's overlay uses the
same tag) over it. Deleting a component's only `<style>` block did that ("No Astro CSS at index 0"):
Vite's update still named the block's stylesheet module, the browser asked for it again, and Astro's
load threw for a block the file no longer has. A check of the page sees a 200, so the controller never
heard of it, and the next edit did not take it down either (the dev plugin turns Vite's reload into a
patch, and a patch leaves the overlay).

- **Cause, removed** (`electron/preview/markerConfig.ts`): the browser's update leaves out every
  `?astro&type=style&index=N` module past the file's last block (a client-only `hotUpdate`; the
  server's update keeps them, which Astro's reload logic reads). An ask that still comes is answered
  with an empty stylesheet where Astro has no compile for it. The patch keys each dev stylesheet by its
  `data-vite-dev-id` (`electron/previewClient/morphPatch.ts`), so the deleted block's stylesheet is the
  one removed from the head, not the last one.
- **Seen**: the frame reports the overlay coming and going (`avb:error-overlay`,
  `electron/preload/frameErrorOverlay.ts`); the controller holds it as a `frame` error, with the
  overlay's words on the notice.
- **Recovered**: a check cannot see an overlay, so nothing polls it. The next write, outside change or
  dev server restart looks once, and a page that answers is reloaded once; an overlay the dev server
  closes itself (its next good update) needs no reload. An overlay that comes back on the reloaded page
  counts toward the same cap (3 per minute). "Reload canvas" on the notice and the toolbar stay.

## A canvas that goes blank

Everything above needs the dev server to send something. These send nothing:

| What happened | What the canvas showed | Why nothing noticed |
|---|---|---|
| The dev server died, and was a detached (daemon) server | Empty, see-through frame on the next load: the dark pane | Astro >= 7 forks a detached server when the environment shows an AI agent (Stacki started from an agent's shell). Nothing heard it exit, `dev:start` kept answering with its address, and an unreachable check has no words for a notice |
| The dev server hung | The old page, or a load that never ends | No exit, no failed navigation |
| The frame's process died | A flat grey box | Electron raises no event for a subframe's process |

- **Cause, removed:** every Astro server starts with `ASTRO_DEV_BACKGROUND=1`, so it stays Stacki's own
  process. `dev:start` asks a held server whether it still serves and replaces one that does not.
  `astro dev stop` (the detached fallback) runs only while the project's lock names our port.
- **Watched:** `src/features/preview/previewSupervisor.ts` asks the server (`/@vite/client`) and the loaded
  frames (`avb:alive`, `electron/preload/frameAlive.ts`) every 5 s while the window is visible, and at once
  on return to the window, on a failed navigation, on `dev:exit`, and when the person reloads.
- **Recovered:** 3 silent looks restart the server (2 after a failed load or a reload), 2 silent looks
  reload a frame. At most 2 restarts per 10 minutes and 2 frame reloads per 5 minutes.
- **Past the bound:** the canvas shows "The preview stopped", **Restart preview** and, when a start failed,
  Show diagnostics. While restarting it shows placeholder shapes. It is never left blank.
- The editor's page, selection and unsaved work are not touched: only the server and the frames are.
- A restart main makes on purpose (phone preview on or off, `.env`, a new integration) is announced
  (`dev:restart`, docs/contracts.md): the supervisor holds back and no offline screen appears. It asks for
  the port it left. Before, a server that had started on the next port (its own was taken) came back on its
  own port and was reported as ended: "Preview is offline" (v1.4.17 to v1.4.21).

Guard tests: `test/renderer/preview/previewSupervisor.test.js`, `previewFramesAlive.test.js`,
`test/electron/preview/previewServerDeath.test.js`, `networkPreview.test.js`, `contentConfigRestart.test.js`.

## Measured (generated fixture, real Astro dev server, `npm run integration:recovery`)

| Fix | Healthy canvas after the fix |
|---|---|
| Undo or edit in the app | about 0.5 s |
| Outside write (harness has no file watcher; next poll) | 2.7 s; with the watcher about 0.5 s |
| Dev server restart | about 0.2 to 0.6 s after it is back |
| Persistent error | 6 polls in 14 s, no reload |

## Guard tests

- `test/renderer/preview/canvasRecovery.test.js`: schedule, bounds, state machine, hidden tick, flaps.
- `test/integration/canvasRecovery.js`: real dev server, scenarios a to e.
- `test/shared/ipc/previewHealth.test.ts`: a marked page is not "truncated".
- `test/electron/previewServer/styleRecompile.test.js`: the update and the load for a deleted block.
- `test/electron/previewClient/devStyleMorph.test.js`: the patch removes the deleted block's stylesheet.
- `test/integration/styleDelete.js` (`npm run integration:style-delete`): real dev server and preload;
  deletes, undoes, and the overlay's recovery.
