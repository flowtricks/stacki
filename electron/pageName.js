// What a typed page name is saved as.
//
// Astro routes on the filename, so `[slug]`, `[...rest]` and the dots inside
// them have to survive being typed — a sanitizer that drops them turns a
// dynamic route into a static one, and Astro stops consulting `getStaticPaths`
// for it. `/` survives too, so a page can be made inside a folder.
//
// Everything else is tidied to `-`, and each segment loses a leading dot or
// dash: that keeps `..` from being spellable and stops a name from producing a
// hidden file. The caller still checks where the result lands.

const pageFileName = (name) =>
  String(name || '')
    .trim()
    .replace(/\.astro$/i, '')
    .replace(/[^a-zA-Z0-9/_\-[\].]+/g, '-')
    .split('/')
    .map((seg) => seg.replace(/^[.\-]+/, ''))
    .filter(Boolean)
    .join('/');

module.exports = { pageFileName };
