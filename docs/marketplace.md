# The Stacki marketplace

The marketplace lists community Stacki apps. **Every marketplace app must be open source under the
MIT license, and Stacki does not review, vet or take responsibility for marketplace apps**: the owner
approves a listing, not the code's safety, and people install the apps they trust. It is served by a Cloudflare Worker on
**stacki.build**, backed by a D1 database of submissions and approved versions. Stacki reads one JSON
index from

```
https://stacki.build/api/marketplace/index.json
```

and the Worker lists in it only what the owner approved. Developers submit an app through the form
at **https://stacki.build/marketplace/submit**; the owner reviews and approves it, and every later
version, on **https://stacki.build/marketplace/admin**. On approval the Worker downloads the release's
zip, checks it, and records the SHA-256 of those exact bytes. Stacki installs a listed version only
when the downloaded asset's SHA-256 equals the one in the index, so a release replaced after review
installs nothing.

How the marketplace appears in Stacki, and the update policy, are in [the Apps guide](apps.md)
("The marketplace" and "Update policy"). The contract is `shared/properties/appMarketplace.ts`; an
example index is `test/fixtures/marketplace/apps.json`. The Worker and the forms live in the
marketing-site repository; this file is the contract both sides hold.

## The index format

```json
{
  "version": 1,
  "apps": [
    {
      "id": "heat-map",
      "name": "Heat map",
      "description": "Shows where visitors click on each page, over the canvas.",
      "author": "octocat",
      "icon": "https://stacki.build/api/marketplace/icons/heat-map-1.1.0.png",
      "categories": ["analytics", "canvas"],
      "license": "MIT",
      "source": { "owner": "octocat", "repository": "heat-map", "asset": "heat-map.zip" },
      "versions": [
        { "version": "1.1.0", "tag": "v1.1.0", "sha256": "<64 lowercase hex characters>" },
        { "version": "1.0.0", "tag": "v1.0.0", "sha256": "<64 lowercase hex characters>" }
      ]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `version` | `1`. |
| `apps` | At most 500 entries; each `id` once. |
| `id` | The app's manifest `id`: lowercase letters, digits, `.`, `-`, `_`; at most 64 characters. |
| `name` | 1 to 60 characters. |
| `description` | 1 to 280 characters. |
| `author` | The developer's GitHub login; Stacki shows their GitHub picture. Set on approval (see below). |
| `icon` | A PNG, SVG or WebP file served by the Worker under **`https://stacki.build/api/marketplace/icons/`**, an address of at most 300 characters with no empty, `.` or `..` segments. The Worker names each file `<id>-<version>.<ext>` (`heat-map-1.1.0.png`) and serves the bytes of the icon the approved bundle's manifest names, so the index never points a browser at a host nobody reviewed. The entry shows the newest approved version's icon. Square, at most 256 KiB. |
| `categories` | At most 4, each lowercase letters, digits and hyphens, at most 32 characters. |
| `source` | The app's public GitHub repository and the release asset's `.zip` file name. No `account`: an approved app downloads without credentials. |
| `license` | Optional; when present, exactly `"MIT"`, which Stacki shows as an **MIT** pill. Any other value refuses the entry, and so the index. |
| `versions` | 1 to 20 approved versions. `version` is the manifest's `version` inside the zip; `tag` is the release tag; `sha256` is the asset's SHA-256 in lowercase hex. Versions and tags are unique. Stacki offers the highest version. Optional per version: `stacki`, the manifest's `">=MAJOR.MINOR.PATCH"` minimum, which Stacki 1.1.0 and later show on the row and enforce (an older Stacki cannot install or update to it); and `asset`, that version's release asset file name, for repositories whose asset names carry the version (`feedback-pins-1.9.0.zip`). Stacki 1.0.x ignores both, so `source.asset` stays a concrete file name: the newest approved version's. |

The whole file is at most 1 MiB. Stacki refuses an index that breaks any rule: the Apps panel says the marketplace isn't available, with the reason in small print.
A download is also refused unless the zip's manifest has the entry's `id` and the approved `version`.

## Submitting an app

1. Publish the app through GitHub releases in a **public** repository with an **MIT `LICENSE`** (see
   "Publishing through GitHub releases" in [the Apps guide](apps.md)). The bundle's `stacki-app.json`
   must name an `icon`: the marketplace refuses an app without one. Give it a `description` too; the
   listing uses it. Do not replace a release's asset once submitted: its digest would no longer match.
2. In Stacki, choose **Submit to marketplace** in the app's **⋯** menu in the Apps panel
   ("Publishing to the marketplace" in [the Apps guide](apps.md)). It checks that the repository is public, tagged
   `stacki-app`, released and MIT licensed, and that the [secret scan](apps.md#secret-scanning) is
   clean, and offers **Make public** and **Add MIT license** where it can. An app uploaded from a
   file, or added to the project folder, is shared to GitHub first. Or use the web form at stacki.build/marketplace/submit.
3. Before Submit, Stacki asks the Worker's check, `GET /api/marketplace/check?repository=owner/repo`,
   which answers `{ ok: true, app: { id, name, version, iconPresent } }` ("Ready to submit: Heat map
   v1.2.0") or `{ ok: false, code, message }`, shown as is.
4. Tick the terms, the same wording as the web form: "I confirm this app is open source under the
   MIT license, I own the rights to publish it, and I understand Stacki does not review, vet or take
   responsibility for marketplace apps." Submit sends
   `POST /api/marketplace/submissions` with `{ "repository": "<the release address>", "accept": true }`
   and the person's GitHub token as `Authorization: Bearer`, which the Worker uses to confirm who
   submits and never stores.
5. The reply is `201 { ok, id, status: "pending" }`, or `200 { …, updated: true }` when the app is
   already pending or listed ("Updated your submission"). A refusal is `{ ok: false, code, message }`
   (`terms`, `invalid`, `repository`, `license`, `github-token`, `too-large`, `content-type`,
   `rate-limited`, `busy`, `queue-full`) and Stacki shows the message as is; `unconfigured` (503), a
   404 or no answer reads as the marketplace not taking submissions yet, with **Open the web form**.
   Nothing is listed until the owner approves it. To submit a later version, submit again after
   releasing it.

A development build reads other addresses for the check and the submissions from
`STACKI_MARKETPLACE_CHECK_URL` and `STACKI_MARKETPLACE_SUBMISSIONS_URL`, under the same rules as the
index's variable below.

Everything else comes from the release, not the submission:

- **From `stacki-app.json`:** the app's `id`, `name` and `description` (the reviewer may override the
  description), and the icon.
- **Set by the reviewer on approval:** the categories; the author, which defaults to the manifest's
  `author.github`, then the repository owner; and the release asset, which is the only `.zip` in the
  release unless the reviewer names one.
- **Computed by the Worker:** the SHA-256, from the zip it downloads.

**An app id stays tied to its original repository and asset.** Once listed, a version from another
repository, or a release whose asset has another file name, is refused for that id.

## Approving an app (the owner)

Submissions are reviewed on **https://stacki.build/marketplace/admin**, which only the owner can
sign in to.

1. Read the submission: the notes, including the hosts it names, and the repository's source at the
   release tag. Try the release in a test project (Apps panel, **Upload app file**).
2. Approve it, optionally with categories, an author, a replacement description, a release tag, or
   the asset's file name when the release has several zips. The Worker reads the release from
   GitHub, downloads the asset, checks the bundle against Stacki's limits, refuses it if the manifest
   names no icon, computes the SHA-256, and only then writes the app or version to D1.
3. The index is cached for **60 seconds**; every approval (and every withdrawal) clears that cache,
   so the change is in the next read.
4. A later version of a listed app is approved the same way, from its submission or from the app on
   the admin page. Its `id` must match the listed app, and its version and tag must be new.

To withdraw a version, withdraw it on the admin page. **Withdrawing the newest version switches the
listing back to the previous one**, icon included; an app with no approved version left drops out of
the index. A project that has not installed a withdrawn version will not, and an update waiting for
**Update** installs nothing. Versions already installed stay installed; projects remove them in the
Apps panel.

The Worker keeps at most 20 approved versions per app (withdraw an old one before approving a 21st)
and at most 500 apps, and refuses to serve an index that would break the rules above.

## When the index cannot be read

A 404, a network failure or a reply that is not a valid index all read the same in the Apps panel:
"Marketplace isn't available right now", with **Retry** and the technical reason in one small muted
line. Installed apps keep working. An index that loads but lists no apps shows "No apps in the
marketplace yet", with a **Submit an app** link to the form.

## Testing an index before it is deployed

A development build of Stacki (Desktop run from source, or Studio run locally with
`NODE_ENV=development`) reads another index from `STACKI_MARKETPLACE_INDEX_URL`, an `https:`
address or `http://localhost` (a local `wrangler dev` of the Worker, say). A released build ignores
the variable, and no setting changes the index address. Icons in a test index must still be under
`https://stacki.build/api/marketplace/icons/`.
