# Regression audit: user-facing behaviour lost since v1.4.0

Audit of 2026-11-17, HEAD `f74071c6`, baselines v1.4.0, v1.4.4, v1.4.5. Read-only; nothing restored (see Restore verdict).

Owned elsewhere, not repeated here: the Easings row's curve icon no longer opening the ease editor; an instance's empty
`label` not showing the current variant's default as its placeholder.

## Method

| Check | Baseline | Result |
|---|---|---|
| en message keys removed | v1.4.0 / v1.4.5 | 65 / 49 removed; each mapped to its commit (tables below) |
| Keys still in the catalog, named by no code | v1.4.5 vs HEAD | 53 newly unnamed: 45 `recovery.*`, 8 from size limits or replaced UI |
| Source files deleted (`src`, `shared`, `electron`, `studio`) | v1.4.0 | 5, each replaced by its successor |
| Whole-file sweeps: a commit sets a file back to an older blob, or deletes a file another commit just added | v1.4.0..HEAD | 13 sweeping commits; every one restored (table A) |
| Line sweeps: a commit removes most of the lines a commit of the last 36 h added, still absent at HEAD | v1.4.0..HEAD | 168 hits; all reviewed: iterations of the same feature, or table A |
| Modules nobody imports | v1.4.5 vs HEAD | 1 new (`shared/engine/instantEdits.ts`: a spec table its tests read) |
| Exports referenced nowhere else | v1.4.5 vs HEAD | 19 newly unused; none is a lost entry point (palette icon swap, refactors) |
| IPC channel names | v1.4.0 | none removed |
| Test titles removed | v1.4.5 | 86; mapped to the commit that changed the contract on purpose (`da140371`, `a805ae62`, `aa32983e` …) |
| CSS rules gone for a class the TSX still writes | v1.4.0 / v1.4.5 | `insert-frame` (dead path), `preview-btn` (covered by `titlebar-btn`) |
| `placeholder=`, `title=`, `onKeyDown=`, `draggable` counts per file | v1.4.0 | drops only in redesigned files (Grid settings, class list, multi-select) |
| Docs removed | v1.4.0 | none at HEAD (the shared index's staged deletions are stale, not commits) |

## A. Swept by a shared-index commit, already restored

| Lost | Added | Swept by | Restored |
|---|---|---|---|
| CLI component commands, apps add and remove | `44575273` | `c565a819` | `78c3c9e3` |
| Spacing hover bands, margin collapse, purple data chips, expression binding | `b3e77156`, `bde367ca` | `c565a819`, `d928a1b4` | `0f343be8` |
| Placement gate, Selector home, compile recovery notice | `c5b33fb3`, `00e9f6a4` | `04f7a8ed` | `eb3b06ff` |
| Purple chip colours | `1a5cbbed` | `04f7a8ed` | `fec7ba3c` |
| Palette "…" menu strings | `9f4fbeab` | `8377f57b` | `6624b36b` |
| Plain list rows, typed item field | `a0858f02` | `6624b36b` | `e21ef6cc` |
| Style tags settings, new sites `is:global` | `08331c3e` | `e661a718` | `4acfe4b0` (reworked `88e2f89d`) |
| Canvas outline mode files | `6bdaf200` | `f14dbf82` | `e06b3ae1` |
| Linear outline dedupe | `ec6a4882` | `507d0bb7` | `cba49112` |
| `heldSelection.ts` deletion | `9fe90220` (intended) | swept into `9906b96e` | n/a: the deletion was wanted |

## B. Removed on purpose by a commit: confirm each is wanted

| # | What the person lost | Commit | Restore | Risk |
|---|---|---|---|---|
| B1 | Grid settings per-track list: add, remove, duplicate and drag-reorder a track; `repeat()` switch; "Edit whole value" | `e661a718` | L | High: replaced by one mode control per axis |
| B2 | "Clear all" (×) in the values multi-select | `def37308` | S | Low |
| B3 | Settings > Content "Editing source" card for data-bound text (chip, hover hint and toast remain) | `0db36084` | S | Low |
| B4 | Switch hold: the Style panel kept the previous element up to 1.5 s; a write was refused with "This element changed while the next one was loading" | `9fe90220`, `36c62bf3`, `88e2f89d` | M | Medium: writes now go to the shown node with no same-element check |
| B5 | "Follow canvas size" row (Space toggles) in the breakpoint list | `aca5b5c5` | S | Low: now a toggle on the trigger and the 0 key |
| B6 | Live iframes in palette cards: pointer inside highlights the card, click inside inserts | `aa32983e` | L | Low: cards are cached pictures; a click on the card inserts |
| B7 | Variable settings gear and popup | `2c707ca3` | n/a | The eye now sits over the end of every value cell, curve column included: likely cause of the ease-editor loss |
| B8 | Read-only Properties form (type and default as code, "Edit in source", reasons) | `991940ef` | n/a | None: every prop is editable now |
| B9 | Diff caps with "Show full diff" and "cut" notes (AI, History) | `a805ae62` | n/a | None: whole diff drawn in slices |
| B10 | "Add else" / "Remove else" buttons on an `if` | `7fc229e1` | n/a | None: Else branch control replaces them |
| B11 | Hover label naming the element inside a closed component | `422c371b` reverted by `d928a1b4` | n/a | Owner rule: closed components stay green |
| B12 | Phone / Tablet device names | `e2befaf2` | n/a | None: per-project breakpoint names |
| B13 | Inline EmDash card | `c776c516` | n/a | None: button with status popup |
| B14 | "Too large" refusals (assets, CMS, selectors, page rename, history diff) | `a805ae62` | n/a | None: no size limits |

## C. Open signals for the owner

| # | Signal | Evidence | Confidence | Size |
|---|---|---|---|---|
| C1 | 45 `recovery.*` strings with no UI: dev-server crash panel (port in use, missing dependencies, Node version, restart loop, Restart, Install dependencies), preview error panel (Reload, Open in browser, Copy details, seven titles), startup stage panel (Retry, Dismiss, stalled) | Added in `a805ae62`; `git log -G` finds no code that ever named them | Medium: either never built or lost before commit | M |
| C2 | `.insert-frame` rules gone; `ComponentPreviewPopup` still writes the class on its `card` surface | `aa32983e`; the card surface has no caller | High that it is dead | S (delete the branch) |
| C3 | `ComponentPreviewFrame` export now used only in its own file | `aa32983e` | High | S (unexport) |

## Restore verdict

- Nothing restored: every loss found is either already restored (A) or removed by a commit that says so (B).
- B2, B3 and B5 are S if the owner wants them back; B1 and B4 need a design call first.
