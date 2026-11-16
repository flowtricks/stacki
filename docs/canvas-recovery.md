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
