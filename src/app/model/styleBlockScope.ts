// Every `<style>` the insert palette adds is written `<style is:global>`, in a
// page, a layout or a component alike.
//
// Astro scopes a plain `<style>` to the file it is written in: every selector
// gets that file's `data-astro-cid-…` attribute, and only that file's own
// elements carry it. A scoped block on a page therefore misses everything the
// page renders through a component, and one in a component misses what a page
// passes into its slots. A builder's styles (Webflow's classes) apply wherever
// the class is used, and that is how styles are expected to behave here: a
// block the person adds reaches every element its selectors match.
//
// Only blocks Stacki adds start global. An existing block keeps whatever
// scope the person wrote; Stacki never rewrites a person's selectors or
// scoping to keep styles applying.

// The `<style>` attribute that makes a block global: written bare, as Astro
// documents it, never `is:global=""`.
export const STYLE_GLOBAL_ATTRIBUTE = 'is:global';
