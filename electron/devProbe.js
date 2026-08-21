// Is the dev server serving a page, or an error?
//
// A compile error replaces the site with the dev server's own error screen —
// served with a 5xx, and carrying none of the HMR client the real page has. So
// nothing inside it can hear the file being fixed, and the preview sits on the
// error until something reloads it. Deciding when to reload means being able to
// ask this question, and the HTTP status is the only answer that doesn't depend
// on recognising the error screen's markup or parsing the server's log — both of
// which change with every version of Astro and Vite.

/**
 * Ask the dev server for a URL and report only the verdict.
 *
 * A server that doesn't answer at all counts the same as one answering 500:
 * either way there is no page there yet, which is what the caller is deciding
 * on. The body is drained and dropped — it can be a megabyte of stack trace,
 * and none of it is wanted.
 */
async function probeUrl(url, fetchImpl = fetch) {
  if (!url || typeof url !== 'string') return { ok: false, status: 0 }
  try {
    const res = await fetchImpl(url, { redirect: 'follow' })
    try {
      await res.arrayBuffer()
    } catch {
      /* nothing to drain */
    }
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

module.exports = { probeUrl }
