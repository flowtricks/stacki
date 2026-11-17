# Memory safety

The owner's Mac froze twice with "out of memory" while agents were working. This page records what
was audited, what caused it, and how to reproduce memory trouble without taking the machine down.

## What caused it

**A test, not the app.** `componentPropertiesPanel.test.js` failed `assert.equal(document.activeElement,
firstOption)`: a stale selector made `firstOption` `null`. Building the failure message, `node:assert` inspects
both values at depth 1000 with getters on. A node React rendered carries enumerable `__reactFiber$…` and
`__reactProps$…` keys, so the inspector walks the whole fiber tree, with its props, state and closures.

| Rendered rows behind the compared nodes | Peak resident memory |
|---|---|
| 1 | 30 MB, a 158 KB message |
| 3 | 2.1 GB |
| 10 | over 3.9 GB within 1 s (killed) |
| The Properties panel test | over 4.6 GB within 5 s (killed) |

`--max-old-space-size` does not stop it: the memory goes to huge strings outside the old space. With a message
argument, or under `node:test`, it is no better, because the reporter inspects `actual` and `expected` too. The
"hang on mousedown" seen earlier was this diff being built, not a render loop in the panel.

## What holds it now

- `test/helpers/domIdentity.js`: `assertSameElement(actual, expected, message)` compares by identity and fails
  with one-line descriptions. Every `assert.equal(document.activeElement, …)` in `test/` uses it.
  `test/renderer/lib/domIdentity.test.js` pins it against 300 rendered rows.
- The gate's test pool (`scripts/gate/testPool.ts`) samples each command's process group once a second with one
  `ps` and kills a group past its bound: 4 GB for a suite, 6 GB for an Electron suite, 10 GB for the compilers,
  ESLint and Studio verify. The output says why. Windows is not sampled; the time limit still holds there.
- `test/renderer/componentProperties/propertyPanelGrowth.test.js`: 300 keys typed into a prop's settings on a
  120-prop component keep a flat heap and a flat per-key cost.

Not yet held by a machine: `assert.equal` or `assert.deepEqual` on DOM nodes outside the `activeElement` pattern.
A lint rule (`scripts/eslintPlugin/`, a gate file) would catch it; that needs a human's approval.

## Audit of recent app changes

Each suspect was read and, where it could grow, measured under the caps below.

| Area | Verdict | Measured |
|---|---|---|
| Properties panel, prop settings, conditions popover | No loop, no growth | 10, 100, 400 props: open 47, 82, 221 ms; a key median 0.5 to 0.7 ms, worst 4 ms; heap +0.3 to 1.5 MB over 300 keys |
| Variant rule model (`readVariantGroups`) | Linear | 1 KB to 1.1 MB of Props: 6 to 63 ms |
| Component property reader | Linear | 1.6 MB template, 200 props: 60 ms |
| Canvas outlines, `onePerPlace` | **Was quadratic, fixed** | 8,000 copies of a looped card: 180 ms per overlay render before, 9 ms after; 16,000: 16 ms |
| Canvas script (`frameMeasure.ts`, collapsed rects) | Linear | 500 to 2,000 marked nodes: hover 2 to 5.5 ms; class change CPU 101 to 371 ms in jsdom |
| Canvas auto-recovery | Bounded | One timer; polling window, steady interval, three flaps stop the reloading; listeners removed on unmount |
| Scroll memory across an error page | Bounded | At most 60 animation frames |
| Paste dependencies | Bounded | Each name visited once |
| Token field undo | Bounded | Steps evicted past `FIELD_HISTORY_STEPS_MAX` |
| Project scan | Linear | 3,000 pages: 426 ms, longest block 15 ms |

Worth knowing, not fixed here:

- `css:variables` parses a 25 MB sheet in one 1.5 s block of the main process (`projectScale.test.ts` says so).
- The data picker asks again for a missing collection entry on each render while it stays missing (the app forgets
  a failed ask). It is not a loop, but typing in a field with such a picker open sends a request per render.
- `TokenField` asserts at most 256 chips in one value: a value with more crashes rather than degrading.

## Reproduce under caps

Run one heavy thing at a time. Wrap it in a watcher that sums the process tree's memory and kills it past a bound,
because `--max-old-space-size` bounds only the JavaScript heap:

```sh
NODE_OPTIONS=--max-old-space-size=2048 node test/renderer/componentProperties/componentPropertiesPanel.test.js &
pid=$!
while kill -0 $pid 2>/dev/null; do
  rss=$(ps -o rss= -p $pid $(pgrep -P $pid) | awk '{s+=$1} END {print int(s/1024)}')
  [ "$rss" -gt 3000 ] && { pkill -9 -P $pid; kill -9 $pid; echo "killed at ${rss} MB"; }
  sleep 0.5
done
```

macOS ignores `ulimit -v`. To find what a runaway is doing, a preload can start a worker that connects to the
main thread with `inspector.Session.connectToMainThread()`, sends `Debugger.pause` every second and prints the
paused call frames; guard it with `isMainThread`, because `NODE_OPTIONS` also loads it into the worker.

Before a run, look for leftovers with `ps -axo pid,ppid,rss,etime,command -r | head`: a test started outside the
pool (`node test/...` by hand) is not in a process group the pool sweeps, so its Electron and Astro children can
outlive it for hours.
