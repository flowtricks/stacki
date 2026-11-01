// Goal: a CMS field holding a video link gets a card (title, description, author, host,
// thumbnail), only links to known video hosts are ever fetched, and every fetched value
// stays inside its bound — while a private video, a broken page or a bad thumbnail costs
// the card only what it could not get.
// Method: links are classified directly; the fetch runs against a fake `fetch` that answers
// like YouTube and Vimeo do, so no network is used; the parser is fed known-good and
// known-bad previews.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLinkPreview, metaDescription } = require('#dist/electron/content/linkPreview.js');
const {
  LINK_PREVIEW_LIMITS,
  parseLinkPreview,
  parseVideoLinkURL,
  videoLinkOf,
} = require('#dist/shared/properties/linkPreview.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function fakeFetch(routes) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const route = routes.find(([pattern]) => url.startsWith(pattern));
    if (!route) {
      return new Response('missing', { status: 404 });
    }
    const [, body, init] = route;
    const response = new Response(body, init);
    Object.defineProperty(response, 'url', { value: init?.landed ?? url });
    return response;
  };
  return { fetcher, asked };
}

test('only links to known video hosts are previewed', () => {
  for (const link of [
    'https://youtu.be/gQIJRzTjvCA',
    'https://www.youtube.com/watch?v=gQIJRzTjvCA',
    'https://m.youtube.com/watch?v=x',
    'https://vimeo.com/76979871',
    'https://player.vimeo.com/video/76979871',
    'https://www.loom.com/share/abc',
    'https://home.wistia.com/medias/abc',
    '  https://dai.ly/x8abc  ',
  ]) {
    assert.ok(videoLinkOf(link), link);
  }
  for (const text of [
    '',
    'Pastor Mark',
    'https://example.com/watch?v=1',
    'https://notyoutube.com/x',
    'https://youtube.com.evil.example/x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://localhost:4321/',
    'https://youtu.be/' + 'a'.repeat(LINK_PREVIEW_LIMITS.urlCharsMax),
  ]) {
    assert.equal(videoLinkOf(text), undefined, text);
  }
  assert.equal(videoLinkOf('https://youtu.be/x').host.name, 'YouTube');
  assert.throws(() => parseVideoLinkURL('https://example.com'), /not a link to a known video/);
  assert.throws(() => parseVideoLinkURL(7), /expected text/);
});

test('a YouTube card takes oEmbed details and the page description', async () => {
  const { fetcher, asked } = fakeFetch([
    [
      'https://www.youtube.com/oembed',
      JSON.stringify({
        title: 'On The Move Part 2',
        author_name: 'The Church International',
        thumbnail_url: 'https://i.ytimg.com/vi/gQIJRzTjvCA/hqdefault.jpg',
      }),
      { headers: { 'content-type': 'application/json' } },
    ],
    [
      'https://youtu.be/',
      '<meta property="og:description" content="It&#39;s time to take ground! &amp; more">',
      { landed: 'https://www.youtube.com/watch?v=gQIJRzTjvCA' },
    ],
    ['https://i.ytimg.com/', PNG, { headers: { 'content-type': 'image/png' } }],
  ]);
  const preview = await fetchLinkPreview('https://youtu.be/gQIJRzTjvCA', fetcher);
  assert.deepEqual(preview, {
    url: 'https://youtu.be/gQIJRzTjvCA',
    title: 'On The Move Part 2',
    source: 'YouTube',
    description: "It's time to take ground! & more",
    author: 'The Church International',
    thumbnail: `data:image/png;base64,${PNG.toString('base64')}`,
  });
  assert.match(asked[0], /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=https%3A/);
  assert.deepEqual(parseLinkPreview(preview), preview, 'the fetched card passes its own parser');
});

test('a Vimeo description comes from oEmbed, so the page is never fetched', async () => {
  const { fetcher, asked } = fakeFetch([
    [
      'https://vimeo.com/api/oembed.json',
      JSON.stringify({ title: 'Sermon', description: 'From oEmbed', author_name: 'TCI' }),
    ],
  ]);
  const preview = await fetchLinkPreview('https://vimeo.com/76979871', fetcher);
  assert.equal(preview.description, 'From oEmbed');
  assert.equal(preview.thumbnail, undefined);
  assert.equal(asked.length, 1);
});

test('a private video has no card, and what is optional fails quietly', async () => {
  const gone = fakeFetch([['https://www.youtube.com/oembed', 'Unauthorized', { status: 401 }]]);
  assert.equal(await fetchLinkPreview('https://youtu.be/private', gone.fetcher), undefined);
  const down = fakeFetch([['https://www.youtube.com/oembed', 'down', { status: 503 }]]);
  await assert.rejects(
    fetchLinkPreview('https://youtu.be/x', down.fetcher),
    /YouTube returned 503/,
  );
  const partial = fakeFetch([
    [
      'https://www.youtube.com/oembed',
      JSON.stringify({ title: 'T', thumbnail_url: 'http://insecure.example/x.png' }),
    ],
    // The page wandered off the video host: its description is not read.
    [
      'https://youtu.be/',
      '<meta name="description" content="elsewhere">',
      {
        landed: 'https://example.com/',
      },
    ],
  ]);
  const preview = await fetchLinkPreview('https://youtu.be/x', partial.fetcher);
  assert.deepEqual(preview, { url: 'https://youtu.be/x', title: 'T', source: 'YouTube' });
  assert.ok(!partial.asked.some((url) => url.startsWith('http://insecure')), 'no HTTP thumbnail');
  const huge = fakeFetch([
    [
      'https://www.youtube.com/oembed',
      JSON.stringify({ title: 'T', description: 'd'.repeat(9000) }),
    ],
  ]);
  const clipped = await fetchLinkPreview('https://youtu.be/x', huge.fetcher);
  assert.equal(clipped.description.length, LINK_PREVIEW_LIMITS.descriptionCharsMax);
  await assert.rejects(fetchLinkPreview('https://example.com/x'), /video host link/);
});

test('page descriptions are read from Open Graph, then standard tags', () => {
  assert.equal(metaDescription('<meta content="A" property="og:description">'), 'A');
  assert.equal(
    metaDescription('<meta name="description" content=" Plain &quot;x&quot; ">'),
    'Plain "x"',
  );
  assert.equal(
    metaDescription(
      '<meta name="description" content="B"><meta property="og:description" content="A">',
    ),
    'A',
  );
  assert.equal(metaDescription('<title>None</title>'), undefined);
});

test('the card parser rejects every shape it was not built for', () => {
  const good = { url: 'https://youtu.be/x', title: 'T', source: 'YouTube' };
  assert.deepEqual(parseLinkPreview(good), good);
  for (const [bad, message] of [
    [undefined, /expected object/],
    [[], /expected object/],
    [{ ...good, url: 'https://example.com' }, /known video host/],
    [{ ...good, title: undefined }, /title: expected text/],
    [{ ...good, source: 3 }, /source: expected text/],
    [{ ...good, title: 't'.repeat(LINK_PREVIEW_LIMITS.titleCharsMax + 1) }, /title: exceeds/],
    [{ ...good, thumbnail: 'https://i.ytimg.com/x.jpg' }, /image data URL/],
    [{ ...good, thumbnail: 'data:image/svg+xml;base64,PHN2Zz4=' }, /image data URL/],
  ]) {
    assert.throws(() => parseLinkPreview(bad), message);
  }
});
