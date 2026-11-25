# Testing a CMS connection against a real server

Why: unit tests with mocks passed while real people hit login and address problems. A
connection is only "works" once Stacki's own code has talked to a real server. CI cannot run a
real server, so CI holds a fake that answers exactly like the recorded real replies
(`test/electron/content/payloadConnection.test.js`); this page is how a maintainer repeats the
real run. Everything below uses a throwaway local server and throwaway credentials; nothing
touches a real site, and nothing here is committed.

## Payload (verified against 3.93.0, SQLite, no external database)

```sh
mkdir -p "$SCRATCH/payload" && cd "$SCRATCH/payload"
# create-payload-app needs a terminal; drive it through a pty when run from a script.
npx -y create-payload-app@3.93.0 -n cms -t blank --db sqlite --db-connection-string file:./cms.db --use-npm --no-agent --no-git
cd cms
# In src/collections/Users.ts use:  auth: { useAPIKey: true, tokenExpiration: 60 }
# Add a content collection with versions: { drafts: true } and fields of each type under test
# (text, richText, number, checkbox, select, date, relationship, upload, group, array, localized text).
npx next dev -p 3101 &  echo $! > ../server.pid
curl -s -X POST localhost:3101/api/users/first-register -H 'content-type: application/json' \
  -d '{"email":"admin@example.test","password":"<throwaway>"}'
# Enable an API key for that user: PATCH /api/users/1 {"enableAPIKey":true,"apiKey":"<throwaway>"}
```

Run Stacki's own provider against it. Compile just the provider into a scratch folder (this never touches
the repository's `dist`), then call the same functions the IPC handlers call:

```sh
npx tsc -p "$SCRATCH/tsconfig.json"   # extends electron/tsconfig.json; files: payloadService.ts, payloadAccess.ts
node --input-type=module -e '
import { createRequire } from "node:module";
const { checkPayloadAccount, payloadRemoteService } = createRequire(import.meta.url)("'"$SCRATCH"'/dist/electron/content/payloadService.js");
const target = { baseUrl: "http://localhost:3101", collection: "users", auth: { kind: "apiKey", key: process.env.KEY } };
console.log(await checkPayloadAccount(target, []));
const service = payloadRemoteService(target, { named: [] });
console.log((await service.collections()).map((c) => `${c.name}:${c.count}`).join(" "));'
kill "$(cat ../server.pid)"        # then run it again: it must say nothing is answering
rm -rf node_modules                 # about 900 MB
```

## What a real Payload does that mocks get wrong

| Behaviour (Payload 3.93) | Consequence in Stacki |
| --- | --- |
| `GET /api/<collection>/me` with a wrong key, a wrong collection prefix or garbage is HTTP **200** with `{"user":null}` | Connection check requires a non-null `user`, never trusts the status |
| A wrong key with `?draft=true` reads **published only** (no error) | Never skip the `/me` check; drafts would silently go missing |
| `PATCH` without `?draft=true` on a collection with drafts **publishes** | Every write must send `draft=true` (and `_status` untouched) |
| 5 failed email+password logins lock the user for 10 minutes (HTTP 401, same message as a wrong password) | Prefer API keys; never retry a password login in a loop |
| No REST endpoint describes a collection's fields (`/api/access` lists names only; GraphQL introspection types richText as `JSON`) | Field types come from the site's `payload-types.ts` or config, or from sampled documents |
| `limit=0` returns every document; `totalDocs`, `hasNextPage` and `page` paginate | Cap every list (`limit` at most 100) |
| `depth=0` returns related ids, `depth=2` populates them (no key leaks) | Read with `depth=0` and resolve titles in a second bounded request |
| `?locale=all` returns `{en, fr}` objects per localized field | Write one locale at a time with `?locale=<code>` |
| Lexical rich text is JSON and round-trips unchanged through `PATCH` | Edit text nodes in place; never regenerate the tree |
| `/api/<collection>/` with a trailing slash works; `/admin/api/...` is a 404 | The address is the server root, not `/admin` |
| The **sixth** login with a wrong password (the fifth still says "incorrect") is HTTP 401 with `This user is locked due to having too many failed login attempts.`; the right password is refused the same way for ten minutes | A failed login is remembered and not sent again for a minute (five for a locked account); a lock says "Too many attempts; try again in about 10 minutes" |
| An **expired, revoked or switched-off credential is an anonymous visitor**: `/me` is `{"user":null}`, a read of a public collection is HTTP 200 with **published content only** (drafts silently missing), a protected read or any write is 403 | Re-check `/me` every two minutes; renew a password login once on 401/403; report a switched-off key |
| Logging in returns `{ token, exp, user }` (`exp` in seconds); `Authorization: JWT <token>` and `Bearer` both work | The token is kept in memory only |
| `GET /api/access` lists the collections the account can see (with `readVersions` on those with versions); `/api/<slug>/versions` is a 404 on a collection without versions | Collections come from `/api/access`; a connection may name more |
| GraphQL introspection (on by default) gives field types, `required`, select enums, array and block types, the locale enum (`LocaleInputType`) and `_status`; it does **not** mark localized scalars (only relationships get a `locale` argument) and calls rich text and JSON the same `JSON` | Types come from introspection, localized fields from sampling `?locale=all`, rich text from the value's shape |
| `PATCH ?draft=true` on a collection **without** drafts changes the live document (HTTP 200, "Draft saved successfully") | Such a collection says its edits are live (`appliesLive`) |
| `PATCH` with `_status: "published"` publishes the latest draft; `_status: "draft"` unpublishes; `DELETE /api/<slug>/versions/<id>` is a 404; `POST /api/<slug>/versions/<id>` restores (as a draft with `?draft=true`) | Discard puts the newest published version back (the live content is unchanged), or deletes a document that was never published |
| A draft can be created with no required field (`POST ?draft=true` `{_status:"draft"}`); a collection without drafts validates and names the field (`errors[0].data.errors[].label`) | Create works for drafts collections; for others the person sees `Name: This field is required.` |
| `limit=100000` is honoured (every document); `where[id][in]=1,2,3`, `select[_status]=true` and `where[title][like]=` work | Lists page by 100 with `page`; statuses use one `where[id][in]` request per page |
| A media upload needs every required field (usually `alt`) in the multipart `_payload` part; its `url` is a path (`/api/media/file/x.png`) | The file's name is the first `alt`; the address is made absolute |

## Phase 1: Payload end to end (Desktop provider), proved against a real server

Real server: Payload 3.93.0, SQLite, localhost:3101, throwaway users and key, created from the same project
as above plus `posts` (drafts and versions, localized `title` and `tagline`, rich text, select, radio,
number, checkbox, date, email, code, json, point, hasMany select, group, array, relationship, upload),
`pages` (no drafts, blocks), `media` (upload), `categories`, `users` (auth, API keys on, tokens last 60 s);
563 posts when listed. Setup is the recipe above (fields as in `Posts.ts` / `Pages.ts`), then a seed script that
registers the first user, enables its API key and POSTs the content. Stacki's provider code was compiled to a
scratch folder and driven directly (no Electron was started); a proxy in front of the server produced the
failures a real server does not produce on demand (cut replies, slow replies, 500s, redirects).

Result of the last run: **57 of 57 capabilities passed against the real server**. Everything below the first
table was found by the run, not by reading documentation.

| Capability | Result | Evidence (real server) |
| --- | --- | --- |
| Connection: API key | PASS | user=admin@example.test mode=apiKey graphql=true locales=en,fr cols=media+u,categories,posts+d,pages,users |
| Connection: email+password login | PASS | user=admin@example.test mode=password |
| Connection: wrong API key | PASS | noUser: Payload did not accept this key. Check the key, that “Enable API key” is on for that user, and that “users” is the collection it belongs to. |
| Connection: wrong auth collection | PASS | badAddress: No Payload API at http://localhost:3101/api/admins/me. Use the CMS server’s own address (not the website or /admin), and the collection that holds the account… |
| Connection: closed port | PASS | network: Nothing is answering at http://localhost:3999. Is the CMS running, and is the port right? |
| Connection: wrong password then retry (no loop) | PASS | 1:login 2:loginPaused 3:loginPaused; real login afterwards HTTP 200 |
| Connection: locked account (5 raw wrong passwords, then Stacki login with RIGHT password) | PASS | raw=401,401,401,401,401,401 -> locked: Too many attempts; try again in about 10 minutes. |
| Connection: expired JWT used on a protected route (token lifetime 60s; clock held back so Stacki thinks it is fresh) | PASS | docs=1 |
| Connection: session revoked server-side (logout all sessions) must not turn into silent published-only reads | PASS | logout HTTP 200; drafts before 100 after revoke 100 |
| Connection: token refresh before expiry (clock moved forward past exp) | PASS | ok 5 |
| Collections: list with counts | PASS | media:7 categories:3 posts:569 pages:2 users:5 |
| Shared parser accepts collections | PASS | ok |
| List: 563+ docs, cap 500, pages of 100, unique ids | PASS | n=500 unique=500 sortedDesc=true first=posts.8 Post 008 alpha |
| List: shared parser (renderer boundary) accepts it | PASS | cells={"views":8,"kind":"news","featured":true} |
| List: status draft/published/changed | PASS | {"changed":8,"draft":345,"published":147} |
| List: small collection and non-drafts collection | PASS | pages.2:About:published pages.1:Home:published |
| List: upload collection has picture URL | PASS | http://localhost:3101/api/media/file/sample%20one-4.png |
| List: unknown collection | PASS | notFound Payload has no such document or collection. |
| Read: post with every field type | PASS | title:object={"en":"Post 001 alpha"} / slug:string="post-1" / tagline:object={"en":"Tagline 1"} / body:text="Body of post 1" / views:number=1 / featured:boolean=false / k… |
| Read: values | PASS | {"title":true,"body":true,"views":true,"featured":true,"kind":true,"contact":true,"author":true,"categories":true,"cover":true,"coverAsset":true,"meta":true,"links":true,… |
| Read: select options & types from GraphQL | PASS | [{"title":"News","value":"news"},{"title":"Guide","value":"guide"}] |
| Read: blocks | PASS | [{"heading":"Welcome","_key":"6af6fc1973ae4c05fd86d00e","_type":"hero"}] appliesLive=true |
| Read: user docs never expose key/hash | PASS | name,hasAPIKey,email,resetPasswordRequestedAt |
| Read: missing document | PASS | notFound |
| Template: empty fields | PASS | 19 fields id=new-item |
| Write (drafts collection): live UNCHANGED, draft exists | PASS | live views 2->2 status published; draft views 9999; versions 1->2; returned status changed |
| Write: localized field only the changed locale | PASS | draft title {"en":"Loc en","fr":"Titre français"}; live {"en":"Loc en"} |
| Write: rich text simple paragraphs round-trip | PASS | "First line\nSecond line" children=2 |
| Write: rich text with formatting stays read-only and is refused | PASS | readOnly=true text=bold write->invalid; bold kept=true |
| Write: json, group, array, select many, relationship, point | PASS | {"extra":{"a":1},"meta":{"description":"new meta"},"links":["Z"],"tags":["y"],"cats":[2],"where":[2.5,1.5],"liveExtra":null} |
| Write: invalid JSON text | PASS | invalid Payload rejected this: Extra is not valid JSON. |
| Write: unknown field | PASS | invalid |
| Write (NON-drafts collection pages): applies LIVE and says so | PASS | live=About us (live edit) appliesLive=true status=published |
| Write: validation error from Payload | PASS | invalid: Payload rejected this: Name: This field is required. |
| Create (drafts collection) | PASS | posts.572 draft doc.status=draft |
| Delete | PASS | removed=1 raw=404 again=0 |
| Create (non-drafts collection, required name) | PASS | invalid: Payload rejected this: Name: This field is required.; count 2->2 |
| Publish | PASS | status=published live views=9999 |
| Unpublish | PASS | draft |
| Discard (changed doc) | PASS | status=published live views 7->7 draft views 7 |
| Discard (never published) removes it | PASS | result=undefined raw=404 |
| Action on non-drafts collection | PASS | invalid |
| History + restore as draft | PASS | versions=20 restored status=changed live updatedAt same=true |
| Relationship search | PASS | Guides / all=categories.3,categories.2,categories.1,users.4,users.3,users.5,users.2,users.1 |
| Upload small image | PASS | {"id":"image-media-8","url":"http://localhost:3101/api/media/file/sample%20one-5.png","filename":"sample one-5.png"} |
| Write cover = uploaded asset | PASS | cover=8 expected 8 |
| Upload over the limit | PASS | tooLarge That is larger than Payload or Stacki accepts (50 MB). |
| Failure: connection cut mid-list-reply | PASS | PayloadError/malformed: http://localhost:3102 answered, but not like Payload. Use the CMS server’s address, not the website’s. |
| Failure: request dropped during a write | PASS | network: The connection to http://localhost:3102 was cut off. Try again. |
| Failure: server answers 500 HTML | PASS | server: Payload answered with a server error (500). Check the CMS server and try again. |
| Failure: 200 with HTML body | PASS | malformed: http://localhost:3102 answered, but not like Payload. Use the CMS server’s address, not the website’s. |
| Failure: truncated JSON | PASS | malformed |
| Failure: 302 redirect | PASS | redirect: Payload moved: http://localhost:3102 redirects to https://elsewhere.example/api/x. Use that address instead. |
| Failure: 429 and 413 | PASS | rateLimited tooLarge |
| Failure: slow server (20s read timeout) | PASS | timeout after 20.0s: The CMS took too long to answer. Check your connection and try again. |
| Failure: recovers after the outage | PASS | 5 |
| Huge document (400k-char text, 3000 links) | PASS | snippet len 99000 ro=always links 3000 ro=undefined |

Also done against the real server by hand, outside that script: the real server process was killed with `kill -9`
while a list was in flight (Stacki said "The connection to http://localhost:3101 was cut off. Try again."), and a
write and a list sent afterwards both said "Nothing is answering at http://localhost:3101. Is the CMS running, and
is the port right?" with nothing partly written.

### Defects found against the real server, and fixed

| Defect | How it showed | Fix |
| --- | --- | --- |
| Field types and relations were all "string": the GraphQL answer was read with the wrong helper, so no collection matched its type | The first real run listed `author`, `cover`, `body` as strings and wrote an object to `categories` (HTTP 500) | Collection types are matched by name; a test reads the recorded introspection |
| Relationships looked localized (they carry a `locale` argument in GraphQL) and a write sent them per locale | HTTP 500 on `categories` | Localized fields come from sampling `?locale=all`, never from GraphQL arguments |
| Rich text was shown as raw JSON and a point as a list of numbers when the newest documents did not hold them | `body` read back as a JSON string | One document that has the field is fetched (`where[field][exists]=true`) as evidence |
| An expired login was read as an anonymous visitor with HTTP 200: published content only, drafts silently missing | Found by waiting out a 60 s token; my first "expired token" test passed for the wrong reason | The account is re-checked (`/me`) every two minutes, a login that no longer works is renewed once, a switched-off key is reported; 403 on a password connection renews the login once |
| Repeated clicks on Test connection with a wrong password would have sent the wrong password again and again (five lock the account for ten minutes) | Designed against the recorded lock; test shows one wrong login reaches the server, the rest are answered from memory | A failed login is remembered for a minute (five for a locked account) |

### What was only tested against the fake server (CI)

`test/helpers/fakePayload.js` is a small model of the replies recorded in `test/fixtures/cms/payload/`
(sanitized: no keys, tokens, hashes). It reproduces the traps above (200 with a null user, PATCH without
`draft=true` publishing, anonymous reads after expiry, lockout on the sixth attempt, `limit=0`). Suites that run
in CI without a server: `payloadConnection`, `payloadService`, `payloadValues` (electron/content), `payloadStatus`,
`payloadPanelFlow`, `cmsKeyForm` (renderer, in jsdom), `cmsConnections` (shared contracts and the preview
environment). `payloadPanelFlow` mounts the real CMS view, answers its bridge from the real provider talking to
the fake server, lists a collection, opens an item, types a value and checks that the server received
`PATCH ?draft=true` with one field while the live document stayed as it was.

### Not done, or not proved

| What | State |
| --- | --- |
| Click-through in the running app (Settings, CMS connections, Payload; the CMS panel) | **Needs a human.** No Electron window was started |
| Canvas click-to-edit of Payload text | **Not built.** Sanity's works through stega source maps; Payload has none, so canvas text cannot be traced to a document and field. The dev server gets `STACKI_PAYLOAD_URL/COLLECTION/API_KEY` (API-key connections only) and the card shows the `.env` and fetch snippet to use in an Astro page; the loop and data-picker catalogs list Sanity and Astro collections only |
| Writing `PAYLOAD_URL` / `PAYLOAD_API_KEY` into the site's `.env` | Not done; the card shows the lines to add (the key is never printed) |
| Stacki Studio | The Studio panel and form compile (Studio check shows no errors in these files) but Studio's server keeps Sanity-only connection books (`studio/src/features/cms/cmsConnectionBook.ts`), so Test connection says it is unavailable and Payload cannot be browsed from Studio yet |
| Custom CMS | Unchanged: saves the connection; browsing says "not available yet" |
| Locale switcher | A localized top-level field is edited as one entry per locale in one form (so no switcher is needed); a localized field inside a group, array or block is shown as JSON and read-only |
| Rich text | Plain paragraphs are editable; any formatting, heading, link, list or upload makes the field read-only with a text preview (Payload's own editor is the place to edit) |
| JSON field | Edited as JSON text, validated on write |
| Relationship search in the picker | The service searches by title (`references(types, query)`), the picker shows the latest 100 per collection and does not pass a query yet |
| More than 500 documents | The panel lists the 500 most recently edited |
| A real https server, certificates, a path prefix, Postgres or Mongo ids | Not tried (SQLite numeric ids only); ids that are not whole numbers are sent as text |
| Payload `useAsTitle` | Not available over REST; titles come from `title`, `name`, `label`, `heading`, `slug`, `filename`, `email`, `alt` in that order |
| Strapi and Directus | Not started. Each needs its own provider with the same pieces: auth and lockout rules, a schema source (Strapi has `/api/content-type-builder` for admins and `GET /api/<plural>` samples; Directus has `/fields` and `/collections`), pagination, draft/publish semantics, uploads, and the same fake-server fixtures recorded from a real instance. `payloadClient.ts` (timeouts, size caps, redirects, login backoff, error mapping), `payloadValues.ts` (value translation) and the test harness are the template |

## Needs a human

- Click through Settings, CMS connections, Payload in the running app (this agent never starts Electron).
- A deployed https Payload behind a real certificate and a real proxy path prefix.
