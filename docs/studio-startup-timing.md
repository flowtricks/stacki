# Hosted Studio startup timing

Why opening the hosted Studio and its preview feel slow, what was measured, and what changed.
Numbers marked **local** come from the real image run under `docker run --cpus=1 -m 3g` on an
Apple-silicon Mac (Colima, arm64) with a copy of the example site; they show proportions, not
Cloudflare's wall clock. Nothing here was deployed or measured on Cloudflare's hosts.

## What a cold open waits for

The editor cannot show the project until the container's Astro server answers
`/studio/api/project`, so "Opening your studio" is the container's whole cold start:

| Stage                                        | Measured                                                                                         | Note                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Worker: session, GitHub permission           | 0 ms (`EDITOR_ACCESS=github`); about one GitHub call per isolate per 5 min in `repository` mode  | cached                                                  |
| Container scheduling and image pull          | not measurable from here                                                                         | image was 2.95 GB uncompressed                          |
| Worker bootstrap (token mint, R2 reads)      | not measurable from here                                                                         | two R2 reads were serial, one was repeated              |
| Repository: `git fetch --depth=1` + checkout | **3.2 s + 1.6 s local** (227 MB, 2,650 files, 204 MB of it images) plus the download from GitHub | CPU-bound on one vCPU                                   |
| Draft files and assets from R2               | not measurable from here                                                                         | two inventories, then two restores, one after the other |
| Link the image's `node_modules`              | 0.3 s local                                                                                      | already baked into the image, never installed at boot   |
| Astro dev server listening                   | **5.2 to 6.0 s local**                                                                           |                                                         |
| First `/studio/api/project`                  | **0.98 s local** cold, 0.22 s warm; 337 KB, 44 pages, 91 components                              |                                                         |
| First page compile (home, 2.7 MB HTML)       | **2.8 to 3.1 s local** cold, 0.11 s warm                                                         | what the canvas waited for after the editor opened      |

Local sum of the measurable stages is about 14 s; the 24 s in the report is that plus the host
pull, bootstrap and R2 time. The preview "taking longer" screen is the first page compile and
the image requests behind the editor opening, which started only when the canvas asked.

The browser side is not the cause: `studio.js` is 12.4 MB (3.4 MB gzip, 3.1 MB brotli), served
with an ETag, so a returning visitor revalidates and does not download it. It is large because
`typescript` is in it (3.5 MB, 28 %), all five languages (2.5 MB, 20 %) and Shiki grammars
(0.7 MB). Splitting those needs lazy loading in shared Desktop code and a change to the demo and
release asset lists; it was not done here.

A container sleeps after its last connection closes, so every visit after that pays the whole
table. That was three minutes.

## What changed

| Change                                                                                                      | Effect                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Container sleeps after **10 min** idle, not 3 (`CONTAINER_SLEEP_AFTER`)                                     | A return within ten minutes is warm: no cold start at all                                                                      |
| After Astro answers, the container itself reads the project catalog and compiles the home page, in parallel | First project read and first canvas page are warm (0.98 s to 0.22 s, 2.8 s to 0.11 s, local) and finish before the editor asks |
| Draft and asset inventories fetched together, and restored together                                         | One R2 round trip fewer, and the two restores overlap                                                                          |
| Bootstrap reads R2 once, not twice, and in parallel                                                         | Saves one R2 read on every cold start                                                                                          |
| Image installs production dependencies only and drops source maps                                           | 2.95 GB to 2.11 GB uncompressed (-28 %), 840 MB less to pull; the container still boots and serves (checked)                   |
| Real stages on screen: container, repository, drafts, dependencies, server, compile                         | The boot screen and the canvas say what is happening, with the step counter ("5/6") on the status row; Retry appears after 90 s, not 10 s                   |
| The container reports each stage with a timestamp; the Durable Object keeps them                            | `/studio/api/startup` answers in milliseconds without waking the container, and polling it also starts a stopped container     |

The container also prints `[start] <stage> at <ms>` lines, and `/studio/api/startup` returns
`history` with `sinceStartMs` per stage, so the next cold start on Cloudflare gives the missing
rows of the table above: sign in, then read that route from the editor's network tab, or
`npx wrangler tail --config cloudflare/wrangler.jsonc` while a cold start runs.

## Limits (all in code)

| Constant                                       | Value                                                | File                                      |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `READINESS_LIMITS` (container waits for Astro) | 200 attempts, 250 ms doubling to 2 s, 180 s deadline | `src/features/startup/readiness.ts`       |
| `STARTUP_POLL_LIMITS` (editor reads the stage) | 300 reads, 1 s growing to 3 s, 15 min deadline       | `src/features/startup/startupPoll.ts`     |
| `STARTUP_LIMITS.slowAfterMs` / `retryAfterMs`  | 20 s / 90 s                                          | `src/features/startup/startupStages.ts`   |
| `STARTUP_REPORT_LIMITS`                        | 5 s per report, 8 in flight                          | `src/features/startup/startupReporter.ts` |

## Not done, and why

- **Show the editor from a cached project before the container is up.** The editor's panels all
  talk to the container, so a cached shell would raise errors until it answers. It needs a
  read-only mode for that window and a browser to verify it.
- **Start Astro while drafts restore.** Faster by about the Astro start, but a request could read
  a half-restored draft. Not worth the risk of lost edits.
- **Skip images in the clone.** Astro needs them on disk when a page imports them.
- **Split `studio.js`.** See above.
