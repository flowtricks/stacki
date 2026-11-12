# Stacki Style panel parity

Reference: `/path/to/stacki`, upstream revision
`b8594ed7ab13868deb1d5f6f7a6b34a185e8f121` (plus the reference checkout's current files).

## Implementation coverage

The complete upstream Style panel directory is included. The runtime audit compares
231 reachable upstream modules: 220 are byte-identical and eleven adapt browser transport and refresh behavior.
No upstream Style panel files are missing. The adapters are StylePanel's inventory
loader, stylePanelBridge, model/webflow's project persistence, BackgroundLayerFields'
asset URLs, variableEditBridge, assetBridge, AssetThumb, background scan/rebuild hooks,
and the computed-style/color hooks.

The retained upstream implementation includes:

- Component-green, stylesheet-blue, inherited/global-gray, active, hover, pending,
  disabled and out-of-context selector chips; selector suggestions, addition,
  selection, deselection, global and inherited toggles, and source selection.
- Base and conditional contexts; query creation, nesting, editing and deletion;
  CSS code editing and source-preserving rule serialization.
- Flex/grid child, layout, spacing, size, position, typography, backgrounds,
  borders, effects and custom properties, including their expandable controls.
- Variable connections and color resolution, font choices, value stepping and
  scrubbing, spacing modifier gestures, provenance and inherited-source navigation.
- Background images and gradients, layer ordering/removal, shadows, transforms,
  transitions, filters, clipping, cursor and pointer-event controls.
- Live changes, committed writes, save/error indicators and undo/redo.

Browser-specific connections now provide bounded/retryable inventories, coalesced
in-flight reads, rendered classes for Astro expressions, marker/text style queries,
inherited sources, CSS/cache invalidation, canvas modifiers and asset thumbnails.
Adding classes uses Stacki's class-expression handling. A page with no `<style>` and no stylesheet
has nowhere to write the first style, so the panel adds a `<style is:global>` block at the end of
that page and puts `.class` (then `.class-2`, `.class-3`) on the selected element, in one undo step
(`src/features/style/model/firstStyleBlock.ts`; Desktop applies it as one gesture, Studio as one
source edit); a project with any style or stylesheet of its own is written as before. File edits and history use
shared draft rooms and expected-source comparisons, protecting newer collaborator
changes. Upstream's desktop filesystem is replaced by Studio's existing editable
`src` and `public` roots; this is not a desktop filesystem access implementation.

## Reproducible checks

Run from `studio`:

```sh
npx tsx scripts/auditStyleParity.ts /path/to/stacki
npx tsx --test test/styleClassEdit.test.ts test/styleInventory.test.ts test/styleReads.test.ts test/styleTransport.test.ts
npm run build
npx tsx test/stylePanelParity.browser.ts
npx tsx test/styleStability.browser.ts
npx tsx test/styleSelectors.browser.ts
npm run verify
npm run test:browser
```

The isolated browser fixture uses a temporary project and available port. It checks
actual chip colors, conditional dimming, all section headers, CSS editor opening,
context and layout controls, background-layer dialogs, canvas modifier-key forwarding,
component stylesheet writes and exact undo, background-image decoding, inherited
properties, missing/text-node queries, CSS variables, and `class:list` additions.
The selector recovery test covers failed inventories, retries, switching elements,
reopening the panel and retaining loaded chips through a later outage.

Source equivalence covers the full upstream control implementation; browser tests
exercise the host integrations and representative flows. They do not establish that
every possible CSS syntax, gesture combination or browser has been exhaustively tested.

The stability regression checks idle and hover refreshes, failed stylesheet reads,
recovery, and repeated live opacity edits. Inherited field hints retain their last
answer while the same element is being refreshed, then adopt the new answer.
Selection/file/property changes never reuse a different target's answer. Failed
background scans retain the previous complete model and remain throttled.
