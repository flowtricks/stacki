// Goal: list rows are titled, subtitled and pictured the way the site's Studio lists them —
// from the schema's `preview.select`, through references, with values a `prepare` function
// would have used shown as they are — and a path is never anything but plain field names.
// Method: projections are built from previews shaped like real ones and compared; rows the
// query could return are read back into titles, subtitles and pictures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewOf, previewProjection } = require('#dist/electron/content/sanityPreview.js');

test('a projection reads title, subtitle and picture, through references', () => {
  const projection = previewProjection({
    title: 'name',
    media: 'image',
    parts: [{ key: 'campus', path: 'campus.name' }],
  });
  assert.match(projection, /"title": coalesce\(coalesce\(name\), title, name, heading/);
  assert.match(projection, /"media": coalesce\(image\.asset->url\)/);
  assert.match(projection, /"part0_campus": coalesce\(campus->name, campus\.name\)/);
  assert.match(previewProjection(undefined), /^"preview": \{"title": coalesce\(title, name/);
});

test('a path that is not plain field names is refused', () => {
  const bad = { title: 'name} | *[0', media: undefined, parts: [] };
  assert.throws(() => previewProjection(bad), /plain field names/);
});

test('rows read back as title, subtitle and an https picture', () => {
  const row = {
    preview: {
      title: 'Matt Smith',
      media: 'https://cdn.sanity.io/images/p/d/a.jpg',
      part1_campus: 'St. Amant',
      part0_jobTitle: 'Lead Pastor',
      part2_links: ['a', 'b'],
    },
  };
  assert.deepEqual(previewOf(row), {
    title: 'Matt Smith',
    subtitle: 'Lead Pastor · St. Amant · 2 links',
    imageURL: 'https://cdn.sanity.io/images/p/d/a.jpg',
  });
  const plain = previewOf({ preview: { title: 'A', media: 'http://x' } });
  assert.equal(plain.subtitle, undefined, 'no parts, no subtitle');
  assert.equal(plain.imageURL, undefined, 'only https pictures');
  assert.equal(previewOf({ preview: { part0_links: ['a'] } }).subtitle, '1 link');
});
