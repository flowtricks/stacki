# Canvas clicks and hovers

The product rule: **people can always click elements on the canvas and see outlines on hover.** A
click never ends in an error for a cause the canvas can recover from. This note traces the pipeline,
lists every way a click could fail, and says how each one is handled now.

## Pipeline

| Step | Where | What can go wrong |
|---|---|---|
| 1. Marking | `electron/previewServer/previewMarkers.ts` (dev plugin) | Each `.astro` file under `src/` is served with `<!--avb-s/e:path-->` markers around every node and one stamp `<!--avb-d:<sha256>:<file>-->`. A file that does not parse, is past `sourceBytesMax`, or lies outside `src/` gets neither. |
| 2. Frame start | `electron/preload/frameQueries.ts` `start`, `frameTargets.ts` `startOutlines` | The preload runs in the preview iframe (`nodeIntegrationInSubFrames`), walks the markers into regions, tags elements with `data-avb-p`, and listens to the pointer on the window in the capture phase. |
| 3. Token | `frameRegions.ts` `announceRender` | The stamps form a manifest; its SHA-256 is the token. The frame posts `avb:render`, or `avb:render-problem` when it cannot form one. |
| 4. Hit test | `frameTargets.ts` `nodeAt`, `pointTarget` | `elementFromPoint`, then past embeds and script overlays (`elementsFromPoint`), to the deepest marked node whose box holds the point. |
| 5. Message | `avb:hover-node`, `avb:click-node` | Each carries the path, the copy, the point and the token. Parsed by `src/features/preview/previewMessages.ts`. |
| 6. Gate | `src/features/preview/previewGate.ts`, `previewSelection.ts`, `electron/preview/previewCheck.ts` | A click selects only when its token is the latest, the open file's stamp is the bytes the editor shows, and main finds every stamped file unchanged on disk. |
| 7. Ladder | `src/features/preview/canvasClickRecovery.ts` (plan), `canvasClickRetry.ts` (runs it) | A refused click is recovered (below). |
| 8. Selection | `src/app/shell/AppPanes.tsx` `selectCanvasPath`, `src/editor/canvasClick.ts` | The path selects its node; no path selects the layout (page) or, in a component, nothing. |
| 9. Outlines | `previewRuntime.ts`, `PreviewOverlays.tsx` | Hover and selection outlines are drawn from boxes the frame measures for the tracked paths. |

## The recovery ladder

A refused click is never re-judged as it came. The editor asks the frame where the same point lands
**now** (`avb:click-query` `{ id, x, y }`); the frame answers with an ordinary `avb:click-node` that
carries `replay: id` and the current token, and that answer goes through the same gate. One click is
pending at a time: a newer click replaces the one being retried.

1. **Retry**: wait (60 ms rising to 1.5 s, or at once when a new rendering is announced), look again.
   Bounded by `CANVAS_CLICK_LIMITS.retryWindowMs` (6 s) and `attemptsMax`.
2. **Reload**: retries ran out on a cause a fresh rendering fixes: reload the canvas, once per
   document (`reloadsPerDocumentMax`). The click is not replayed; the page under the point is new.
3. **Page**: the canvas shows markup other than the open file: select the page (the layout node).
4. **Notice**: nothing above applies. One warning notice, never repeated within
   `noticeQuietMs`, taken down when a click selects again, with **Reload canvas** and **Copy details**.

Copy details copies the in-memory click log (`canvasClickLog.ts`, last 64 attempts with stable codes,
no paths or page content). Nothing is written to disk or sent anywhere.

## Catalog

| Code | How a person hits it | Project shape | Handled now |
|---|---|---|---|
| `stale:no-render` | Click while the page loads or a patch digests | Any; slow pages | Retry until the frame announces its rendering |
| `stale:no-render` + `conflicting-stamps` | A patch or a duplicated module leaves two versions of one file on the page | HMR mid-edit; one component imported by two specifiers | Frame reports it; canvas reloads once; hovers still draw |
| `stale:no-render` + `too-many-stamps` / `page-too-large` | Every click on a huge page | Over 20 000 stamps or 512 files | Notice "too-large": select in the Navigator. **Cannot recover** |
| `stale:no-render` + `no-digest` | Frame without Web Crypto | Non-secure preview origin | Reload once, then notice "unreachable" |
| `stale:superseded` | Click while the canvas re-renders (HMR, a save, a patch) | Any editing session | Retry: look again at the point on the new rendering |
| `stale:token-mismatch` | Rendering the frame could not vouch for | Page code forging stamps | Retry, reload once, then notice "out-of-step" |
| `stale:file-changed` | A file changed on disk after it rendered | External editor, AI agent, `git checkout`; a watcher that missed it (network drives, inotify limits) | Retry (the dev server re-renders), reload once, then notice |
| `stale:file-missing` | A stamped file was deleted or moved | Renames, branch switches | Retry, reload once, then notice |
| `stale:unstamped-file` | **Every click** while the canvas shows something other than the open file | Astro error page, 404, i18n or middleware redirect, a page the marker could not parse | Select the page; notice "other-page" once. This was the most likely "click not applied on every click" |
| `stale:unstamped-file` + `stamped-files=0` | **Every click**, no marker anywhere on the page | A project plugin that loads `.astro` files before Stacki's (`load: { order: 'pre' }`, as component-navigator integrations do: Vite serves the first `load` that returns source). Fixed: the marker plugin is `order: 'pre'` and first in the list (`electron/preview/markerConfig.ts`, `competingLoad.test.js`) | Select the page; notice "unmarked" names the missing markers; Copy details shows `stamped-files=0` |
| `stale:shown-page-differs` | Click while a structural edit is unsaved or rendering | Editing | Retry until saved and rendered; then notice (a reload cannot render unsaved edits) |
| `check-failed` | Main did not answer `preview:check` | Main busy or crashed | Retry, then notice "unreachable" |
| `frame-silent` | The frame did not answer a look | Frame crashed, navigated, or stuck in a long script | Retry, reload once, then notice "unreachable" |
| `no-point` | A text session's own click | Double-click text editing | Dropped; the text session says why itself |

Frame-side shapes that used to make clicks or hovers disappear without any message:

| Shape | Before | Now |
|---|---|---|
| Page with no markers at first (markup arrives with the first patch, error page) | Pointer listeners never attached: clicks and hovers dead | Listeners always attached; observers start when markers appear |
| Page script stopping `mousemove` (carousels, modal libraries) | No hover outlines | Hover listens on the window in the capture phase, before any page script |
| Astro `<ClientRouter />` swap | Frame kept the old page's token: every click refused | `astro:after-swap` re-reads markers and stamps |
| Script overlay over the page (click catchers, lightboxes) | Every click selected the layout | The first element a file wrote beneath the overlay answers |
| Embedded document (`iframe`, `embed`, `object`) | Pointer went to the embed: no hover, no click | Select mode lets the pointer through; the embed itself is selected |
| Forged or malformed stamp in page content | Whole rendering dropped: every click "still loading" | Stamp skipped with the shared parser |
| Page changes under a resting pointer | Outline stuck on the old box | Hover re-hit-tested with the new token |
| Hover before any rendering is vouched for | Outline hidden | Drawn: it is a picture of the frame's own boxes |
| Announcement sent before the editor listened (slow start, a reload racing the listener) | Every click waited out the ladder and reloaded (`stale:no-render`) | A `no-render` retry asks again (`avb:request-render`); the frame re-sends its rendering or its render problem |

Shapes that already worked and are covered by the corpus test: `pointer-events: none` overlays, fixed
headers on a scrolled page, transforms, shadow DOM (the host is selected), SVG internals (the `svg`),
the dialog top layer, `display: contents`, bare text, several roots, markup a script generated or
replaced (the nearest element a file wrote).

## Studio

Studio's canvas (`studio/src/features/preview/previewClient.ts`) selects by `studio:select` without the
token gate, so it never showed "Click not applied". It shares `frameRegions.ts` (stamp parsing) and
`frameInteraction.ts` (embeds take no pointer in select mode).

## Tests

- `test/renderer/preview/canvasClickRecovery.test.js`: the planner over every code, the notice gate,
  the log bound, the controller with a fake clock, and a 400-seed randomized run.
- `test/renderer/preview/canvasClickLadder.test.js`: the real `PreviewPane` recovering clicks.
- `test/electron/preload/canvasClickHeal.test.js`: the real preload in jsdom, frame-side shapes.
- `test/electron/preload/canvasClickCorpus.test.js`: real Electron, a corpus of page shapes, and
  clicks during repeated patches.

## If it still happens

Ask for the notice text, the page (or error) the canvas showed, whether it happens on the first click
or only after edits, and the **Copy details** text.
