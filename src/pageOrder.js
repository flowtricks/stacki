// How pages are listed, everywhere they're listed: the Pages panel, its search
// results, and the switcher in the title bar. `index` is the folder's own page
// so it leads; a name starting with a digit is a status page or a numbered
// draft (404, 500, 2024-recap) and belongs at the end rather than jumping the
// queue alphabetically. Everything else sits between, natural-sorted so
// page-2 comes before page-10.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function pageRank(name) {
  const base = String(name || '').replace(/\.(astro|mdx?)$/i, '');
  if (/^index$/i.test(base)) return 0;
  if (/^\d/.test(base)) return 2;
  return 1;
}

export function comparePageNames(a, b) {
  const an = String(a || '').replace(/\.(astro|mdx?)$/i, '');
  const bn = String(b || '').replace(/\.(astro|mdx?)$/i, '');
  return pageRank(an) - pageRank(bn) || collator.compare(an, bn);
}
