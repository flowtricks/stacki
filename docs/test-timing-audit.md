# Test timing audit (Nov 19)

`Check` on 20293df9 was red on four suites that pass on the maintainer's Mac. This page records the
real cause of each failure, the sweep of every test file changed since v1.4.7, and the guard that
stops the same patterns coming back.

## The four reds

| Suite (job) | Real cause | Fix |
|---|---|---|
| `renderer/style/firstStylesPanel`, "the last value wins" (Windows 2/4) | **A product race, not a slow test.** A commit made just as the first `<style>` tag lands goes straight into the rule the scan already shows, while the lane still holds the older commits that waited for that tag. The lane then drained 0.4 over 0.5. A slow runner spreads the five commits over that moment. Reproduced locally every time once the save was held and released by the test | `FirstTagLane.supersede`: a write or clear that goes around the lane drops the waiting write for the same selector and property (`firstTagLane.ts`, `useEditorResolution.ts`, `useEditorWrites.ts`). The suite's save timer (`blockDelayMs`) became a held save the test releases (`holdBlock`), and a new test commits at that exact moment. It fails with the CI symptom (0.4 left) when the fix is taken out. Under the CPU burner a second hazard showed: the panel disables its fields while a save is in progress, and the old test went on typing into the disabled field, so its later commits were dropped. A person cannot do that. The test now commits only while the field takes commits, and asserts that the last one taken wins |
| `renderer/app/liveInstanceCounts`, "8,000 nodes … linear" (Linux 1/4) | The median of seven sub-millisecond runs read 4.04 ms against 0.46 ms: a garbage collection or scheduler pause, not quadratic work | Linear is proved by **counted node reads** (a proxy counts property reads: exactly 2x for twice the nodes; quadratic would be 4x). "Within a frame" is the best of 9 runs against 16 ms times `measureSpeedFactor()` |
| `renderer/apps/appUiKitElements` (Linux 3/4) | **Chromium never started.** It exited in 0.3 s with "Missing X server or $DISPLAY": it could not open its connection to the shared Xvfb display, while the Electron suites just before and after it passed. The earlier Escape fix was unrelated to this failure | `test/helpers/electronProbe.js` launches again only a probe that printed nothing and failed with that display message (3 launches at most). The Escape now waits until the search field is the active element, and presses again only if focus was lost. If the field had focus and still heard nothing, that is a real failure, reported with what each press saw |
| `test (ubuntu-latest)`, `test (windows-latest)` | Roll-ups only: they fail when a shard fails. No other suite failed | none needed |

## Sweep: test files changed since v1.4.7

78 files. In progress elsewhere and out of scope: `test/electron/documents/textEntities.test.ts` and
`test/renderer/preview/textMarkLabels.test.js` (the owner's text marks work), `test/integration/homeSwap.js`.
No test files from the canvas drag, page settings or assets work were in the tree yet.

| File | Hazard | Fix |
|---|---|---|
| `renderer/style/firstStylesPanel.test.js` | 13 fixed pauses: 900 ms after mount, after each commit and select; 1.5 s after queued commits; 400 ms save timer | Held save released by the test; `waitForSteady` (the panel stopped changing); `setImmediate` task boundary between input and Enter; `waitFor` on the source list |
| `renderer/app/liveInstanceCounts.test.js` | 2 absolute-ms bounds (16 ms; ratio of medians) | Counted reads; calibrated frame bound |
| `renderer/apps/appUiKitElements.test.js` | Blind Escape retry; no handling for a launch that never started | Focus-gated Escape; `runElectronProbe` |
| `renderer/style/segmented.test.js` | 40 ms pause for a jsdom frame | `waitFor` on `is-animated` |
| `renderer/palette/componentMenu.test.js` | 250 ms pause for the rename plan | `waitFor` on the plan text |
| `renderer/preview/panelDragHold.test.js` | 50 ms pause for the release transition; the release render count took in the transition's own end, a timer a loaded runner fires inside the act | `waitFor` on `settling === false`; the release frames are counted (settling ones) |
| `renderer/preview/previewLifecycle.test.js` | 650 ms pause for a tooltip | `waitFor` on the tooltip |
| `renderer/preview/projectBreakpoints.test.js` | 4 pauses (80 ms, 300 ms) around a confirm dialog | `waitFor` on the dialog, its closing and the save |
| `electron/previewServer/styleRecompile.test.js` | 2 × 10 ms pauses ordering held compiles; `< 1000 ms` | `waitFor` on the started compile; bound is the product's own 3 s give-up |
| `electron/previewServer/styleBlockScan.test.ts` | `wholeMs < 2000`; a timed 4x-size ratio (the burner read 16x, an idle Mac 5x) | Linear is now counted string-method calls (4x the text, 3.6x to 4.4x the calls); the bound is `2000 × measureSpeedFactor()` |
| `electron/preload/canvasInteract.test.js` | 13 waits of `LINK_HOLD_WAIT_MS` | Kept: it waits out the product hold timer under test |
| `electron/preload/canvasInteractModal.test.js` | 3: observation windows | Kept: these check that something does *not* happen, which no wait can show |
| `electron/preload/fragmentOutline.test.js`, `apps/appUiKitElements.test.js` | Poll intervals inside bounded waits | Kept: the pause is the poll interval, not the sync |
| `electron/documents/pageEdit.test.ts` | A bounded quiet-wait; one observation window | Kept |
| `studio/test/vendorSync.test.ts`, `styleRecompile.test.js` | Latency injected into fakes | Kept: awaited, never raced |
| `renderer/preview/{desktopDevice,resizeHandles,previewDeviceKeys}Chromium.test.js` | 20 settle pauses after a condition is reached, and between real input events | **Open**, allowlisted until 2026-12-19: wait on the drawn frame, the readout and the stage instead |
| `test/integration/*.js` | 20 pauses | Kept: manual scripts, not gate suites |

Counted: **29 hazards fixed** (23 fixed pauses, 4 absolute-ms bounds, 2 timer-dependent counts or ratios), 2 blind retries made
conditional, **1 product race fixed**, 32 kept with a reason, **20 open** with a 30-day expiry. Hard-coded
ports, Windows path separators, test-order dependence and working-tree reads: none found. The
`localhost:4321` strings are jsdom URLs, the `C:\` paths are deliberate Windows fixtures, and the
real servers listen on `server.address().port`.

Seen once, outside the sweep: `renderer/history/popup` read the popup's phase as `opening`, not
`open`, during the full renderer run. It passes alone. It predates v1.4.7 and is a candidate for the
same fix: wait on the phase.

## The guard

`scripts/gate/testTimingScan.ts` runs as `test-timing` in the gate's static phase, beside
`adapter-surface`. Its unit test, `test/scripts/gate/testTimingScan.test.ts`, also runs in every shard
and in targeted runs. It counts two patterns in `test/**` and `studio/test/**`:

- **fixed-pause**: an awaited sleep with a duration (`await wait(900)`, `waitForTimeout(500)`, `settle(OBSERVE_MS)`) and promise sleeps (`setTimeout(resolve, 50)`). Not counted: a zero delay or `setImmediate` (a task boundary), and `waitFor` / `waitForSteady`.
- **absolute-ms**: an asserting line that compares a duration to a number literal (`largeMs < 16`, `performance.now() - started < 1200`). Not counted: bounds from `measureSpeedFactor()` or `lagMsBound()`, and counted operations.

`scripts/gate/testTimingAllowlist.json` lists every site that exists today: file, rule, count,
reason, the day it was added and its expiry (at most 190 days). The gate fails when a file has more
sites than its entry, when a file has no entry, or when an entry has expired. It also fails on a malformed entry.
Fewer sites than the entry are reported, so the entry can be lowered. Refresh on purpose with
`node dist/scripts/gate/testTimingScan.js --baseline` (it prints the current counts).

## Reproduce a loaded runner on macOS

`taskset` is Linux-only. On macOS, run the suite as a background-QoS process, which keeps it on the
efficiency cores, beside 20 CPU burners on the same QoS:

```sh
for i in $(seq 1 20); do taskpolicy -c background node -e 'while(1);' & done
env -u ELECTRON_RUN_AS_NODE taskpolicy -c background npm test -- renderer/style/firstStylesPanel
pkill -f "node -e while"
```

Neither race reproduced this way: on 18 cores the burners never stretched the gap between two tasks enough.
Interleavings are reproduced by controlling the timing instead: the first-tag race came from
holding the save and committing on the observed state.
