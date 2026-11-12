# Instant UI: loading states

**The rule.** UI shows instantly, with no delay. If loading is absolutely required and there is no way
around it, show a skeleton loader, never plain text ("Loading…", "Reading…") and never a spinner.

**Why.** A word in place of the content moves the layout when the content arrives, reads as a stall, and
is the first thing a person notices. A screen that paints its real shape at once feels like it was
already there.

## How, in order

1. **Instant first.** Paint the real chrome and the real layout in the first frame. Headings, buttons and
   the list's container never wait on a read.
2. **Stale while revalidate.** Keep the last result per project in memory, bounded, and paint it in the
   first render of the next open; read again behind it and swap in place. Use `createPanelCache` and
   `prewarmPanelCache` (`src/lib/usePanelData.ts`). A failed refresh keeps what is shown and adds an error
   notice; it never replaces data with an empty state.
3. **Prefetch.** Start the read before the panel opens: add it to `desktopPanelReads` in
   `src/app/shell/AppShell.tsx` (run once per project open, when the renderer is idle).
4. **Skeleton fallback.** Only when nothing is cached and the read has not answered: `Skeleton` and
   `SkeletonRows` from `src/ui/Skeleton.tsx`, drawn in the real row's shape and size so nothing shifts
   when the content arrives.

## The primitive

- Fill only (`--bg-active`), no borders or dividers.
- Shimmer is a slow highlight; `prefers-reduced-motion: reduce` turns it off (`src/ui/skeleton.css`).
- Shapes are `aria-hidden`. The group is `aria-busy="true"` with a visually hidden, translated status
  (`ui.loading`) so a screen reader hears it once.
- Row counts are bounded (`SKELETON_ROWS_MAX`) and widths come from a fixed list: no randomness.

## What a cache may hold

Names, flags, revisions. Never a secret value or anything else a person has to ask to see. The Secrets
tab's cache (`src/features/projectSettings/secretsCache.ts`) is the worked example: the listing type has
no field for a value, and a test holds that.

## Examples

- `src/features/projectSettings/SecretsTab.tsx`: cached names at once, silent refresh, placeholder rows
  in the real row layout on the first load, error notice over kept names on a failed refresh.
- `src/features/apps/marketplace/MarketplaceView.tsx`: placeholder rows shaped like app rows.

## Not covered by this rule

Progress for work that is genuinely running and has no content to preview (an export, an install, a
build) may say what it is doing, because there is no layout to hold. A short inline status on a button
that was just pressed ("Saving…") is that kind of progress, not a loading state.
