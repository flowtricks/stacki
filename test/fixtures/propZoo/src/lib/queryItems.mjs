// The list helper a visual-builder export ships: applies filter, sort, limit,
// offset and curated picks to a collection's entries. Stacki reads the options
// object a component passes it (src/editor/optionsQuery.ts).
export function queryItems(items, options = {}) {
  let out = [...items];
  const filter = options.filter;
  if (filter && Array.isArray(filter.fields) && filter.fields.length > 0) {
    const test = (item, field) => String(item.data?.[field.fieldPath]) === String(field.value);
    out = out.filter((item) => (filter.filterFor === 'ANY' ? filter.fields.some((field) => test(item, field)) : filter.fields.every((field) => test(item, field))));
  }
  for (const rule of [...(options.sort ?? [])].reverse()) {
    out.sort((a, b) => (String(a.data?.[rule.field]) < String(b.data?.[rule.field]) ? -1 : 1) * (rule.direction === 'desc' ? -1 : 1));
  }
  const picked = options.curated?.itemIds;
  if (Array.isArray(picked) && picked.length > 0) {
    out = picked.map((id) => out.find((item) => item.id === id)).filter(Boolean);
  }
  const offset = options.offset ?? 0;
  return out.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
}
