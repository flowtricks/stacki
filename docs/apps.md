# Stacki Apps

Stacki Apps are small web apps that run inside Stacki, the visual editor for Astro sites, and work
with the editor the way its own panels do: they read and change the selection, draw on the canvas,
open panels, hear when the project changes, and edit pages through the same commands as a click, so
undo, saving and conflicts behave identically. An app runs in Stacki Desktop and Stacki Studio
alike, from the same files.

Apps are first-party: every app can use the whole API, now and as it grows. Nothing asks the person
to approve permissions. What Stacki does check protects the project and the computer from
accidents: bundle limits and safe paths, validated messages, the role that may use an app, and a
sandbox that keeps an app's code apart from Stacki's own.

This page is the full guide and reference. The "Build an app" prompt in the Apps panel is a short
introduction that links here.

## How an app runs

- An app is a folder of static files: an HTML entry page plus scripts, styles, images and fonts. No
  build step is required.
- Stacki opens the entry page in a sandboxed frame. The app talks to Stacki by `postMessage`,
  through the SDK Stacki serves at `stacki-sdk.js`.
- A running app shows **docked** in the Apps panel (rail key **E**) or **popped out** in a popup
  over the canvas. See [Window: docked or popup](#window-docked-or-popup).

## Bundle format

An app is distributed as one `.zip` file. Its root holds `stacki-app.json` (a zip of the folder
itself, with one top folder, works too):

```text
my-app.zip
├── stacki-app.json      the manifest (required)
├── index.html           the entry page (named by the manifest)
├── app.js
├── app.css
├── icon.svg             the icon (optional: a square PNG, SVG or WebP)
└── overlay.html         an overlay frame page (optional)
```

What Stacki checks before anything is installed:

| Check | Limit |
|---|---|
| Archive size | 10 MiB |
| Files | 200 |
| One file, uncompressed | 5 MiB |
| All files, uncompressed | 20 MiB |
| Path length / depth | 200 characters / 8 folders |
| Path segments | letters, digits, `_`, `.`, `-`; no leading dot, no `..`, no backslashes |
| Compression | stored or deflate; no encryption, no zip64, no symbolic links |
| File types | `html js mjs css json map txt md svg png jpg jpeg gif webp avif ico woff woff2 ttf otf wasm glb gltf mp3 mp4 webm` |
| Manifest (`stacki-app.json`) | 16 KiB |
| Icon | square; at most 256 KiB; PNG and WebP at most 512 × 512 pixels |
| Reserved | `stacki-sdk.js` and the `__stacki/` folder (Stacki serves its own SDK and UI kit) |

Each file's CRC is checked. Anything else, executables included, is refused: a bundle's files are
only ever served to its own frame.

**Remote code is refused.** An app installs fully into `.stacki/apps/<id>/` and runs from there, so
its code cannot change under the person who installed it or stop working when someone else's server
does. The check refuses, naming the file and the URL:

- in HTML, a `<script src>` or any `<link href>` (stylesheet, preload, icon) to an `http:`, `https:`
  or protocol-relative (`//`) address, and the same imports inside inline `<script>` and `<style>`;
- in JavaScript, `import … from`, `export … from`, bare `import '…'`, `import('…')` and
  `importScripts('…')` of such an address;
- in CSS, `@import` and `url()` of such an address (fonts and images included).

Vendor every library: copy it into the bundle and load it by a relative path. A `fetch` of an API at
run time is not code; it is declared in `network` instead ([External services](#external-services)).

## The manifest: `stacki-app.json`

```json
{
  "manifestVersion": 1,
  "id": "heat-map",
  "name": "Heat map",
  "version": "1.2.0",
  "description": "Shows where visitors click, on the canvas.",
  "icon": "icon.svg",
  "entry": "index.html",
  "window": { "mode": "popup", "width": 360, "height": 480 },
  "author": { "github": "octocat" },
  "stacki": ">=1.1.0",
  "source": { "kind": "github", "owner": "octocat", "repository": "stacki-heat-map", "asset": "heat-map.zip" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `manifestVersion` | yes | Always `1`. |
| `id` | yes | Lowercase letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most 64 characters. Roles grant apps by this id (`app:heat-map`). Never change it between versions. |
| `name` | yes | Up to 60 characters. |
| `version` | yes | `MAJOR.MINOR.PATCH`, optionally `-prerelease`. Updates offer only a higher version. |
| `description` | no | Up to 280 characters. |
| `icon` | no | A bundle path to a square PNG, SVG or WebP image, at most 256 KiB and, for PNG and WebP, at most 512 × 512 pixels (an SVG needs a square `viewBox`). It shows wherever the app appears: the Apps panel, install and update prompts, role settings and the command palette. Without one, Stacki draws a tile with the name's first letter on a color that follows the app's id. |
| `entry` | yes | The bundle path of the HTML page to open. |
| `window` | no | `{ "mode": "panel" \| "popup", "width": 240–1600, "height": 160–1200 }`, every field optional. `mode` is where the app first opens (default `"panel"`). `width` is the side panel's width while the app is docked, and the popup's width. `height` is the popup's height. A popup with no size opens at 360 × 480. See [Window: docked or popup](#window-docked-or-popup). |
| `author.github` | no | The author's GitHub username (letters, digits and single inner hyphens, at most 39 characters). The Apps panel shows its profile picture; without it, a GitHub app shows its repository owner's picture, and otherwise an initial. |
| `source` | no | Where the app is published: a GitHub repository's releases and the asset name. |
| `stacki` | no | The oldest Stacki the app runs on, as `">=MAJOR.MINOR.PATCH"` (for example `">=1.1.0"`); only this form, a minimum release, is accepted. A Stacki older than that refuses to install or update to the bundle, saying "Needs Stacki 1.1.0 or later. Update Stacki."; an update check reports it instead of offering it. A copy already installed keeps working. The marketplace shows the requirement on the app's row ("Stacki 1.1.0+") and disables Install on an older Stacki; the app's details show "Needs: Stacki 1.1.0 or later". Absent: any Stacki. Stacki 1.0.x ignores the field, so it is enforced from 1.1.0 on. |
| `commands` | no | Up to 16 global commands: `[{ "id": "open-images", "title": "Image library", "shortcut": "Mod+Alt+Shift+1", "panel": "images" }]`. `shortcut` must be in the reserved range; any other is refused at install. See [Shortcuts and commands](#shortcuts-and-commands). |
| `shortcutClaims` | no | Up to 32 shortcuts the app keeps while it has focus, such as `["Mod+Z", "Mod+K"]`. See [Shortcuts and commands](#shortcuts-and-commands). |
| `settings` | no | Up to 16 values each installer fills in, such as their own API key: `[{ "id": "api-key", "label": "API key", "kind": "secret", "required": true }]`. See [App settings](#app-settings). |
| `secretsAllowlist` | no | Up to 32 lines the secret scan skips, each `{ "file", "lineSha256" }`. See [Secret scanning](#secret-scanning). |
| `network` | no | Up to 16 external services the app calls at run time, each `{ "host", "purpose" }`: a bare host name (no `https://`, port or path) and up to 120 characters of why. The frame can connect to these hosts only. Absent or empty: the app works fully offline. See [External services](#external-services). |
| `permissions` | no | Up to 24 switches admins turn on or off per role in Settings, Roles: `[{ "id": "resolve-threads", "label": "Resolve threads", "description": "…", "default": true }]`. `id` is lowercase letters, digits and `-`, starting with a letter, at most 48 characters; `label` at most 60; `description` (optional) at most 160; `default` is required. The app enforces them itself. See [Permissions](#permissions). |
| `auth` | no | Up to 4 sign-in providers for `stacki.auth.connect`: a Stacki [connection](#connections), `{ "provider": "google" \| "hubspot", "scopes" }`, which the installer connects with one click; or a custom provider with its own endpoints and the installer's own client. See [Connections](#connections). |

## Window: docked or popup

An app's window is the same window as the Variables panel's. The toggle at the right of its header
switches between **docked** in the side panel and **popped out** into a popup. The popup can be
dragged by its header and resized from any edge or corner.

- **One frame.** Docking and popping out move the window, not the app's frame. The app keeps running,
  with its state, and is not reloaded. It needs no event for the switch.
- **Other rail panels.** A popup stays open while you use other panels. A docked app hides while
  another rail panel shows, and keeps running. Opening the Apps panel shows it again.
- **Panel width.** While a docked app shows, the side panel takes the manifest's `width`, clamped to
  the panel's own range of 260 to 600 pixels. Closing the app, popping it out or switching panels
  restores your own panel width. With no `width`, the panel keeps your width.
- **Defaults and your choice.** `window.mode` sets where an app first opens. After that, Stacki
  remembers your last mode, your popup's position and size, and a panel width you dragged while the
  app was docked. Each is remembered per project and app, and wins over the manifest.
- `window.kind` from early manifests is refused with a message naming `window.mode`.

## Look and feel

An app sits next to Stacki's own panels, so build its UI from the **Stacki UI kit**: Stacki's own
components, the ones its panels use, served to the app. A change to Stacki's design reaches every app
that uses the kit with Stacki's next release, with nothing to update in the app. Use the kit by
default, and don't import another UI framework for basic controls (buttons, fields, switches, tabs,
menus).

Stacki serves the kit from inside every app's own origin, so nothing loads from a CDN and the
sandbox's policy allows it as it is:

| File | What it is |
|---|---|
| `__stacki/ui.js` | Stacki's components (its React components, compiled when Stacki is built) as custom elements |
| `__stacki/ui.css` | The CSS those components use: the same files the editor loads, scoped to the kit |
| `__stacki/tokens.css` | The design tokens alone, as `--stacki-*` custom properties |

Link `ui.css`, and load `ui.js` after `stacki-sdk.js`. Use the relative path, `__stacki/ui.css`, as
for the SDK; it works in Desktop and Studio alike. A bundle may not ship its own `__stacki/` folder.
`ui.js` works as a plain script in `<head>`, with or without `defer`: each element reads what you
write inside it when it connects and again whenever it changes, so content the parser writes after
the script ran, or that your code replaces later, always shows.

```html
<link rel="stylesheet" href="__stacki/ui.css" />
<script src="stacki-sdk.js"></script>
<script src="__stacki/ui.js"></script>
```

| Element | Stacki's component | Use |
|---|---|---|
| `<stacki-dropdown>` | The custom dropdown (`Dropdown.tsx`) | `value`, `placeholder`, `label`, `searchable`, `disabled`; `<option>` and `<optgroup>` children are its options, or set them as data with the `options` property. An option's `icon` (`<option icon>` or the `icon` field) shows in its row and in the closed trigger when it is chosen: `component`, `tag:<tag>` or a kit icon's name (see **Option icons**). Fires `change`; read `.value`. While the menu is open, fires `highlight` with `event.detail.value` each time the row under the pointer or the arrow keys changes, and `event.detail.value === undefined` when the pointer leaves the rows or the menu closes (see **Previewing a highlighted option**) |
| `<stacki-switch>` | The switch with its label beside it (`Switch.tsx`, the editor's switch rows) | `checked`, `label`, `label-hidden`, `disabled`. `label` shows beside the switch, and a click on it toggles; `label-hidden` keeps it to the accessible name. Fires `change`; read `.checked` |
| `<stacki-tabs>` | The sliding tabs (`SegmentedTabs.tsx`) | `value`, `label`, `fill`; `<button value="…">Label</button>` children are its tabs. Each tab is as wide as its label; `fill` stretches the row to its container in equal shares. Fires `change`; read `.value` |
| `<stacki-search>` | The search field (`SearchField.tsx`) | `value`, `label`, `placeholder`. Fires `input` then `change` once for every change of its value, clearing included; read `.value` |
| `<stacki-input>`, `<stacki-textarea>` | The editor's text fields | `value`, `placeholder`, `label`, `type`, `rows`, `disabled`. Fire `input` and `change`; read `.value` |
| `<stacki-button>` | The editor's buttons | `variant="primary"`, `"ghost"` or `"danger"` (none is the plain button), `disabled`, `icon`, `aria-label`, `pressed`; its text is the label. With an `icon` and no text it is an icon button: name it with `aria-label` (or `label`). With `pressed` (`pressed="false"` for off) it is a toggle: a click flips `.pressed`, sets `aria-pressed`, draws the editor's pressed fill and fires `change` |
| `<stacki-menu>` | The editor's menu, from a ⋯ button | `label` (the button's name), `icon`, `disabled`; `<button value="…" icon shortcut checked disabled danger>Label</button>` children are its rows, `<hr>` a separator and `<header>` a heading row; or set them as data with the `items` property. Icons line up on the left, a `shortcut` shows muted before the check, a `checked` row's check ends the row. It opens inside the window, right-aligned under a button on the right. Fires `select` with `event.detail.value` |
| `<stacki-popover>` | The editor's popover (`Popup.tsx`), from a button | `label`, `icon`, `open`, `disabled`; its children are the panel: your own markup, in Stacki's style. Escape or a click outside closes it. Fires `toggle` with `event.detail.open`; read or set `.open` |
| `<stacki-confirm>` | The editor's confirmation (`ConfirmDialog.tsx` on `Popup.tsx`) | `title`, `message` (or its text), `confirm-label`, `cancel-label`, `tone="danger"`. Draws nothing until `.ask()` or `.ask({ anchor })` opens it; the promise resolves `true` for the confirm button and `false` for Cancel, Escape or a click outside. Fires `close` with `event.detail.confirmed`; read `.open`. Or call `stackiConfirm(options)` with no markup |
| `<stacki-reset-label>` | The blue reset label (`ResetLabel.tsx`) | `active` when the value is set; its text is the label. A click offers Reset; fires `reset` |
| `<stacki-tooltip>` | The tooltip (`Tooltip.tsx`) | `text`: the text, with its full version on hover. The popup closes when the pointer leaves, and also on any press, click, scroll or wheel, Escape, the window losing focus or the tab being hidden, a change to the element's `text` or other attributes, and when the element is removed, so a list you re-render never leaves one stuck open. One shows at a time |

**Your own markup in Stacki's style.** Inside an element with the class `stacki-ui`, plain controls
take Stacki's look too: `<div class="stacki-ui"><button class="primary">Add</button><input /></div>`.
The kit's CSS applies only inside `stacki-ui` and its own elements, never to the rest of the page.

**The tokens are always there.** Stacki adds them to every HTML page an app serves, as variables
only, so `color: var(--stacki-text-faint)` works in the app's own CSS even in an app that links
nothing. They sit at zero specificity, so an app's own `:root` rule wins. Their values come from
Stacki's own stylesheets.

| Tokens | Names |
|---|---|
| Fills | `bg` (canvas), `bg-panel` (side panels), `bg-raised`, `bg-popover`, `bg-input`, `bg-hover`, `bg-active` |
| Text | `text`, `text-muted`, `text-faint` |
| Accent and states | `accent`, `accent-hover`, `accent-soft`, `accent-text`, `danger`, `success`, `warning`, `selection`, `selection-text` |
| Lines | `line` (the 1px divider between a header and its body, or between sections), `border` (the same colour) |
| Radii | `radius` (8px), `radius-control` (fields, 6px), `radius-option` (menu rows, 5px), `radius-round` (pills) |
| Spacing | `space-1` (4px), `space-2` (6px), `space-3` (8px), `space-4` (12px) |
| Type | `font`, `font-mono`, `font-size` (12px), `font-size-small`, `font-size-tiny`, `font-weight-medium`, `font-weight-strong` |
| Sizes, shadow, focus | `row-height`, `shadow-popover`, `focus-color`, `focus-ring`, `focus-ring-offset` |

Follow Stacki's patterns where the kit has no element for something:

- **Controls use fills, never borders.** A field, a button or a tab is a background fill
  (`--stacki-bg-input`, `--stacki-bg-hover`, `--stacki-bg-active`).
- **No grey header fills.** A header or a divider between sections stays a 1px line, as in Stacki's
  panels; don't paint a header band.
- **Custom dropdowns, never the native `<select>`.** `<stacki-dropdown>` is Stacki's menu.
- **No browser popups.** Never call `alert()`, `confirm()` or `prompt()` — use `stacki-confirm`.
- **Checks on the right.** A menu row or a list row ends with its check, so icons line up on the left.
- **The accent for the one main action and for focus**, the faint text for hints, and the editor's
  type size (12px) for everything else.

**Content is data.** What you write inside an element is read, never drawn as written: refill it
whenever you like. `dropdown.replaceChildren(...options)` gives a dropdown new options and keeps its
control; `button.textContent = 'Saved'` relabels a button. For options from code, set them as data:

```js
const show = document.querySelector('stacki-dropdown');
show.options = ['All', { value: 'mine', label: 'My pins' }, { value: 'old', label: 'Archived', disabled: true, group: 'More' }];
show.options = [{ value: 'card', label: 'Card', icon: 'component' }, { value: 'cta', label: 'Sign up', icon: 'tag:a' }];
show.options = undefined; // back to the <option> children
```

`options` takes up to 500 strings or `{ value, label?, disabled?, group?, icon? }` objects and throws a
`TypeError` (or `RangeError` past the bound) for anything else; reading it answers the options
shown, normalized.

**Previewing a highlighted option.** `highlight` tells you which option the person is on before
they choose, so you can preview it outside the field (outline a target on the canvas, show a
sample). It fires once per change, never per mouse move: with the row's value when the pointer or
the arrow keys reach it, and with `undefined` when the pointer leaves the rows, the row is
disabled, or the menu closes. Opening the menu fires nothing, and the value only changes on a
choice (`change`). Always end the preview on `undefined`.

```js
const target = document.querySelector('stacki-dropdown');
target.addEventListener('highlight', (event) => {
  if (event.detail.value === undefined) {
    clearPreview();
  } else {
    preview(event.detail.value);
  }
});
```

**Option icons.** A dropdown option's `icon` is drawn as Stacki's Navigator draws it, so a list of
elements or components looks like the editor's: `component` is the Navigator's component cube,
`tag:<tag>` its icon for that element tag (`tag:a`, `tag:img`, `tag:h2`, `tag:ul`, `tag:section`,
`tag:button`, `tag:form`; a tag the Navigator has no icon of its own for, such as `tag:my-widget`,
shows its custom-element icon), and any other value is one of the kit's icon names (below). A value
none of these knows shows no icon and throws nothing; a non-string `icon`, or one over 64
characters, throws when set as data. The icon is drawn at the size of Stacki's own dropdown icons,
before the label.

**Menus from code.** `items` takes up to 64 entries: `{ value, label, icon?, shortcut?, checked?,
disabled?, danger? }` rows, `{ kind: 'separator' }` and `{ kind: 'heading', label }`. A heading is a
muted label over the rows below it, such as the account a connection uses. Anything else throws a
`TypeError`; `items = undefined` goes back to the children.

```js
menu.items = [
  { kind: 'heading', label: `Signed in as ${account}` },
  { value: 'refresh', label: 'Refresh data', icon: 'refresh', shortcut: '⌘R' },
  { kind: 'separator' },
  { value: 'disconnect', label: 'Disconnect', danger: true },
];
```

**Popovers.** The panel is your markup, kept as it is: Stacki moves the same nodes into the popover
while it is open and back when it closes, so your listeners and field values stay.

```html
<stacki-popover label="Filter" icon="filter">
  <stacki-switch label="Only mine"></stacki-switch>
  <stacki-dropdown value="open" label="Status"><option value="open">Open</option><option value="all">All</option></stacki-dropdown>
</stacki-popover>
```

**Questions.** Never call `alert()`, `confirm()` or `prompt()` — use `stacki-confirm`. The browser's
popups block Stacki's window and look like none of Stacki. `stackiConfirm(options)`, from `ui.js`,
asks once and resolves `true` or `false`:

```js
const button = document.querySelector('#delete');
button.addEventListener('click', async () => {
  const yes = await stackiConfirm({
    title: 'Delete this pin?',
    message: 'Its replies go too.',
    confirmLabel: 'Delete',
    tone: 'danger',
    anchor: button, // Optional: a popover beside the button; without it the question is centred in the app.
  });
  if (yes) {
    await deletePin();
  }
});
```

Options are `title`, `message`, `confirmLabel` (default `Continue`), `cancelLabel` (default
`Cancel`), `tone` (`'default'` or `'danger'`) and `anchor` (an element); each text is at most 2000
characters, and anything else throws a `TypeError` (or `RangeError`). A `danger` question draws its
confirm button red and starts on Cancel, so a stray Return cannot confirm it; any other question
starts on its confirm button, so Return answers yes. Tab stays on the two buttons, and focus goes
back to the control that asked. To tell the person something without a question, show it in your
own UI (a line of text, a `--stacki-warning` note), never `alert()`.

**Icons.** `icon` on a button, a menu, a menu row or a popover names one of the editor's icons:
`check`, `close`, `copy`, `edit`, `external`, `filter`, `help`, `more`, `pin`, `plus`, `refresh`,
`search`, `settings`, `trash`, `upload` or `warning`.

**Theme.** The editor draws one theme today, dark. `stacki.ui.theme()` answers `{ theme, tokens }`,
and `theme.change` carries a new theme when the editor's changes. `ui.js` follows it for you: it sets
`data-theme` on the app's root, which the tokens key on.

### Example: a filter, a switch and an action

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="__stacki/ui.css" />
    <script src="stacki-sdk.js"></script>
    <script src="__stacki/ui.js"></script>
  </head>
  <body>
    <stacki-tabs value="open" label="Pins">
      <button value="open">Open</button>
      <button value="resolved">Resolved</button>
    </stacki-tabs>
    <stacki-dropdown value="all" label="Show">
      <option value="all">Everyone's pins</option>
      <option value="mine">My pins</option>
    </stacki-dropdown>
    <stacki-switch label="Show pins on the canvas" checked></stacki-switch>
    <stacki-search label="Find a pin"></stacki-search>
    <stacki-button variant="primary">Add pin</stacki-button>
    <stacki-button variant="ghost" icon="settings" aria-label="Settings"></stacki-button>
    <stacki-menu label="Pin options">
      <button value="copy" icon="copy">Copy link</button>
      <button value="resolved" checked>Resolved</button>
      <button value="delete" icon="trash" danger>Delete</button>
    </stacki-menu>
  </body>
</html>
```

```js
document.querySelector('stacki-tabs').addEventListener('change', (event) => show(event.target.value));
document.querySelector('stacki-search').addEventListener('input', (event) => filter(event.target.value));
document.querySelector('stacki-menu').addEventListener('select', (event) => act(event.detail.value));
document.querySelector('stacki-button[icon="settings"]').addEventListener('click', () => stacki.app.openSettings());
```

## The SDK

Load the SDK from the app's own origin, before your code:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script src="stacki-sdk.js"></script>
  </head>
  <body>
    <p id="selected">Nothing selected</p>
    <script src="app.js"></script>
  </body>
</html>
```

The SDK defines `window.stacki`:

```ts
interface Stacki {
  readonly apiVersion: 1;
  /** Calls any method by name. Resolves with its result; rejects with an Error whose `code` is an AppErrorCode. */
  request(method: string, params?: object): Promise<unknown>;
  /** Hears an event. Returns a function that stops listening. */
  on(event: AppEventName, listener: (data: unknown) => void): () => void;
  // One helper per method, by namespace: stacki.selection.get(), stacki.node.addClass({ … }), …
  readonly app: {
    info(): Promise<AppInfo>;
    badge(p: { count: number }): Promise<{ applied: true }>;
    /** Opens this app's details at its App settings section. */
    openSettings(): Promise<{ applied: true }>;
  };
  readonly role: { get(): Promise<AppRoleView>; can(p: { permission: string }): Promise<boolean> };
  readonly person: { get(): Promise<AppPerson> };
  /** The people the app may mention: role members and recent commit authors. */
  readonly people: { list(): Promise<AppMember[]> };
  /** The app's settings as this person filled them in, secrets included. */
  readonly settings: { get(): Promise<Record<string, string>> };
  readonly storage: {
    get(p: { key: string; scope?: AppStorageScope }): Promise<{ value: string | undefined }>;
    set(p: { key: string; value: string; scope?: AppStorageScope }): Promise<AppEditOutcome>;
    remove(p: { key: string; scope?: AppStorageScope }): Promise<AppEditOutcome>;
    keys(p?: { scope?: AppStorageScope }): Promise<{ keys: string[] }>;
  };
  /** `on` calls these for you; call them directly only to manage subscriptions yourself. */
  readonly events: { subscribe(p: { events: AppEventName[] }): Promise<{ events: AppEventName[] }>; unsubscribe(p: { events: AppEventName[] }): Promise<{ events: AppEventName[] }> };
  readonly canvas: {
    getViewport(): Promise<AppViewport>;
    setDevice(p: { device: AppDevice }): Promise<AppViewport>;
    setWidth(p: { widthPx: number }): Promise<AppViewport>;
    scrollTo(p: ({ nodeId: string; occurrence?: number } | { ref: AppNodeRef } | { x: number; y: number }) & { block?: 'center' | 'start' }): Promise<AppEditOutcome>;
    capture(p: { on: boolean; cursor?: 'crosshair' | 'default' | { image: string; hotspot?: { x: number; y: number } }; mode?: 'capture' | 'observe'; reason?: string }): Promise<AppEditOutcome>;
    /** A PNG of one element as the canvas draws it (Desktop). */
    snapshot(p: ({ nodeId: string; occurrence?: number } | { ref: AppNodeRef }) & { widthMax?: number }): Promise<AppSnapshotOutcome>;
    /** Deep outlines reach inside closed components on hover, until they reset (Outline modes). */
    setOutlineMode(p: { mode: 'deep' | 'normal' }): Promise<AppEditOutcome>;
    /** Outlines one element as the editor draws it, inside closed components too; nothing clears it (Highlights). */
    highlight(p?: (({ ref: AppNodeRef } | { nodeId: string; occurrence?: number }) & { style?: 'selected' | 'hover' }) | Record<string, never>): Promise<AppEditOutcome>;
    /** Call on pointerdown: the person drags the item onto the canvas; answers the drop (Drag to insert). */
    startInsertDrag(p: ({ kind: 'element'; tag: string; attributes?: Record<string, string> } | { kind: 'component'; name: string; props?: Record<string, string> }) & { label?: string; preview?: string }): Promise<{ applied: true; nodeId: string | undefined } | { applied: false; reason: string }>;
    /** Sent by startInsertDrag for you, once per pointer move and at the drop. */
    insertDrag(p: { phase: 'move' | 'drop' | 'cancel'; x?: number; y?: number }): Promise<{ over: boolean } | { applied: true; nodeId: string | undefined } | { applied: false; reason: string }>;
  };
  readonly panels: { open(p: { panel: AppLeftPanel }): Promise<AppPanels>; close(): Promise<AppPanels>; openRight(p: { panel: AppRightPanel }): Promise<AppPanels>; get(): Promise<AppPanels> };
  readonly selection: { get(): Promise<AppSelection>; set(p: { nodeId?: string }): Promise<AppEditOutcome> };
  readonly page: {
    get(): Promise<AppPageView | undefined>;
    list(): Promise<AppPageSummary[]>;
    /** Any page or component, read from disk without opening it. */
    getTree(p: { path: string }): Promise<AppPageView | undefined>;
    /** Elements carrying an attribute, across every page and component. */
    findByAttribute(p: { name: string; limit?: number }): Promise<{ matches: AppAttributeMatch[]; truncated: boolean }>;
    /** Opens a page in the canvas; resolves once it is open. */
    open(p: { path: string }): Promise<AppEditOutcome>;
  };
  /** Enters a component's own canvas; resolves once it is open. */
  readonly component: { open(p: { path: string }): Promise<AppEditOutcome> };
  readonly node: {
    get(p: { nodeId: string }): Promise<AppNodeView | undefined>;
    // Every edit takes an optional `label`, the undo step's name ("Undo labels").
    setAttribute(p: { nodeId: string; name: string; value: string; label?: string }): Promise<AppEditOutcome>;
    removeAttribute(p: { nodeId: string; name: string; label?: string }): Promise<AppEditOutcome>;
    addClass(p: { nodeId: string; className: string; label?: string }): Promise<AppEditOutcome>;
    removeClass(p: { nodeId: string; className: string; label?: string }): Promise<AppEditOutcome>;
    setStyle(p: { nodeId: string; css: string; label?: string }): Promise<AppEditOutcome>;
    insert(p: ({ kind: 'element'; tag: string; attributes?: Record<string, string> } | { kind: 'component'; name: string; props?: Record<string, string> }) & ({ position?: undefined } | { position: 'before' | 'after'; anchor: string } | { position: 'inside'; anchor: string; index?: number } | { replace: string }) & { label?: string }): Promise<{ applied: true; nodeId: string | undefined } | { applied: false; reason: string }>;
    remove(p: { nodeId: string; label?: string }): Promise<AppEditOutcome>;
    duplicate(p: { nodeId: string; label?: string }): Promise<AppEditOutcome>;
    /** The element's boxes on the canvas, in the canvas viewport. */
    measure(p: { nodeId: string; occurrence?: number } | { ref: AppNodeRef }): Promise<{ rects: AppRect[] }>;
    /** A key that stays with the element across edits and sessions. */
    key(p: { nodeId: string }): Promise<AppNodeKeyOutcome>;
    find(p: { key: string } | { ref: AppNodeRef }): Promise<{ nodeId: string | undefined; ref?: AppNodeRef }>;
  };
  readonly history: { undo(): Promise<AppEditOutcome>; redo(): Promise<AppEditOutcome> };
  readonly overlay: {
    set(p: { items: AppOverlayItem[] }): Promise<{ applied: true }>;
    clear(): Promise<{ applied: true }>;
    /** To an overlay `frame` item (name it), or from inside one to its app (leave `itemId` out). */
    post(p: { itemId?: string; data: string }): Promise<{ delivered: number }>;
  };
  readonly ui: {
    notify(p: { message: string; kind?: 'info' | 'success' | 'error' }): Promise<{ applied: true }>;
    /** Opens one of the app's pages in a modal or popup; `closed` resolves with what it closed with. */
    openFrame(p: { page: string; width: number; height: number; modal?: boolean; data?: string }): Promise<AppFrameHandle>;
    /** From inside a custom frame: closes it, handing `result` to the opener. Or closes `frameId`. */
    closeFrame(p?: { frameId?: string; result?: string }): Promise<AppEditOutcome>;
    /** The editor's theme and every design token's value in it. */
    theme(): Promise<{ theme: 'dark'; tokens: Record<string, string> }>;
  };
  /** Copies text to the system clipboard; a sandboxed frame cannot. */
  readonly clipboard: { write(p: { text: string }): Promise<{ applied: true }> };
  /** Project files; see "Project files". */
  readonly files: {
    list(p?: { dir?: string }): Promise<{ entries: AppFileEntry[]; truncated: boolean }>;
    read(p: { path: string }): Promise<AppFileContent>;
    write(p: { path: string; content: string; encoding?: 'utf8' | 'base64'; label?: string }): Promise<AppFileOutcome>;
    delete(p: { path: string; label?: string }): Promise<AppFileOutcome>;
    move(p: { from: string; to: string; label?: string }): Promise<AppFileOutcome>;
    mkdir(p: { path: string; label?: string }): Promise<AppFileOutcome>;
  };
  /** Sign-ins; see "Signing in". */
  readonly auth: {
    connect(p: { provider: string }): Promise<AppAuthStatus>;
    token(p: { provider: string }): Promise<AppAccessToken>;
    disconnect(p: { provider: string }): Promise<AppEditOutcome>;
    status(): Promise<AppAuthStatus[]>;
  };
  /** A request to a declared host, made by Stacki; see "Calling services from Stacki". */
  readonly net: { fetch(p: AppNetRequest): Promise<AppNetResponse> };
  readonly shortcuts: {
    /** Keeps these keys in the app while it has focus; resolves with all its claims, the manifest's included. */
    claim(shortcuts: string[]): Promise<{ shortcuts: string[] }>;
    /** The SDK calls these for you. */
    run(p: { shortcut: AppShortcut }): Promise<AppEditOutcome>;
    focus(p: { editable: boolean }): Promise<{ applied: true }>;
  };
  readonly commands: {
    /** Commands that last while the app runs, beside the manifest's. */
    register(p: { commands: AppCommand[] }): Promise<{ commands: string[] }>;
    /** The SDK calls this for a reserved key pressed in the app. */
    trigger(p: { shortcut: string }): Promise<{ ran: boolean }>;
  };
  readonly overrides: {
    /** Answers `point` in Stacki's place while the app runs. */
    register<P extends AppOverridePoint>(point: P, handler: (context: AppOverrideContexts[P], request: { call: number; signal: AbortSignal }) => Promise<AppOverrideResults[P]> | AppOverrideResults[P]): Promise<{ owner: boolean }>;
    unregister(point: AppOverridePoint): Promise<AppEditOutcome>;
    /** The SDK calls this with the handler's answer. */
    resolve(p: { call: number; point: AppOverridePoint; result: AppOverrideResults[AppOverridePoint] }): Promise<AppEditOutcome>;
  };
}
```

### Types

```ts
type AppDevice = 'desktop' | 'tablet' | 'phone';
type AppLeftPanel = 'pages' | 'navigator' | 'properties' | 'components' | 'assets' | 'cms' | 'variables' | 'selectors' | 'code' | 'history' | 'apps' | 'instructions' | 'audits' | 'ai';
type AppRightPanel = 'style' | 'settings';
type AppChangeSource = 'page' | 'styles' | 'cms' | 'assets' | 'files';
type AppEventName =
  | 'canvas.outline'
  | 'selection.change'
  | 'hover.change'
  | 'canvas.change'
  | 'panels.change'
  | 'page.change'
  | 'project.change'
  | 'overlay.click'
  | 'role.change'
  | 'shortcut.press'
  | 'command.run'
  | 'override.request'
  | 'override.cancel'
  | 'frame.close'
  | 'storage.change'
  | 'person.change'
  | 'canvas.click'
  | 'canvas.capture'
  | 'theme.change'
  | 'auth.change'
  | 'overlay.drag'
  | 'overlay.message'
  | 'overlay.hover'
  | 'settings.change';
type AppShortcut = 'undo' | 'redo' | 'save' | 'palette' | 'escape';
type AppOverridePoint = 'assets.pick' | 'cms.bind';
type AppMediaKind = 'image' | 'video' | 'audio' | 'file';

interface AppOverrideContexts {
  'assets.pick': { nodeId: string | undefined; field: string | undefined; accepts: AppMediaKind[]; current: string; acceptsURL: boolean };
  'cms.bind': { purpose: 'field' | 'loop-source'; current: string | undefined; paths: string[]; selection: string | undefined };
}
type AppOverrideFallback = { kind: 'default' } | { kind: 'cancel' };
interface AppOverrideResults {
  'assets.pick': { kind: 'picked'; url: string; alt?: string } | AppOverrideFallback;
  'cms.bind': { kind: 'picked'; path: string } | AppOverrideFallback;
}
interface AppCommand { id: string; title: string; shortcut?: string; panel?: string }
interface AppFrameHandle { id: string; closed: Promise<string | undefined>; close(result?: string): Promise<AppEditOutcome> }

interface AppInfo {
  id: string;
  name: string;
  version: string;
  /** In a custom frame: its id and the `data` it was opened with. */
  frame: { id: string; data: string | undefined } | undefined;
  /** The manifest's `shortcutClaims`. */
  shortcutClaims: string[];
  /** The editor the app runs in, and its version. */
  host: { kind: 'desktop' | 'studio'; version: string };
  /** What this editor can do for apps; see "Desktop and Studio". */
  can: {
    setAttribute: boolean;   // node.setAttribute and node.removeAttribute
    addClass: boolean;       // node.addClass and node.removeClass
    setStyle: boolean;
    insertElement: boolean;  // node.insert with kind 'element'
    insertAttributes: boolean; // node.insert with attributes or props
    insertReplace: boolean;  // node.insert with replace
    openPalette: boolean;
    undo: boolean;           // history.undo and history.redo
    setWidth: boolean;
    scrollTo: boolean;
    snapshot: boolean;       // canvas.snapshot
  };
}
/** Who is using the editor; see "The person". */
interface AppPerson { id: string; name: string | undefined; email: string | undefined; github: string | undefined }
/** Someone an app may mention; see "The person". */
interface AppMember { login: string | undefined; name: string | undefined; email: string | undefined; avatarURL: string | undefined }
type AppStorageScope = 'project' | 'local';
type AppChangeOrigin = 'self' | 'other';
interface AppRoleView {
  id: string;
  name: string;
  isAdmin: boolean;
  /** This app's own manifest `permissions`, resolved for the current person's role (see Permissions). */
  permissions: Record<string, boolean>;
}
interface AppViewport { widthPx: number; heightPx: number; scale: number; device: AppDevice | 'custom' | 'canvas' }
interface AppPanels { left: AppLeftPanel | undefined; right: AppRightPanel }
interface AppSelection { nodeId: string | undefined }
type AppEditOutcome = { applied: true } | { applied: false; reason: string };

/** One element of the open page. Node ids come from Stacki: keep them, do not build them. How long they last: see [Durable node keys](#durable-node-keys). */
interface AppNodeView {
  id: string;
  kind: string;                         // 'element', 'component', 'text', 'expr', 'map', …
  name: string;                         // the tag or component name; '' for text
  classes: string[];
  attributes: Record<string, string>;   // plain string attributes only
  text: string | undefined;             // a text node's words, up to 500 characters
  children: AppNodeView[];
}
interface AppPageView { path: string; editable: boolean; nodes: AppNodeView[]; truncated: boolean }
interface AppPageSummary { path: string; route: string; title: string | undefined }
interface AppRect { x: number; y: number; width: number; height: number }   // canvas viewport, CSS pixels before the zoom
interface AppPoint { x: number; y: number }                                 // 0–1 within an element's box
interface AppCanvasClick { nodeId: string | undefined; at: AppPoint | undefined; x: number; y: number; layers: AppNodeLayer[] }
interface AppNodeRefStep { file: string; nodeId?: string; key?: string; copy?: number }
interface AppNodeRef { steps: AppNodeRefStep[] } // the open page's element first; 1–32 steps
interface AppNodeLayer { file: string; nodeId: string; key: string | undefined; component: string | undefined; instancePath: AppNodeRefStep[]; ref: AppNodeRef }
interface AppOverlayDrag extends AppCanvasClick { itemId: string; phase: 'start' | 'move' | 'end'; cancelled: boolean }
type AppSnapshotOutcome = { applied: true; url: string; width: number; height: number } | { applied: false; reason: string };
type AppNodeKeyOutcome = { applied: true; key: string } | { applied: false; reason: string };
interface AppAttributeMatch { path: string; nodeId: string; value: string }
```

### Methods

| Method | Params | Result |
|---|---|---|
| `app.info` | none | `AppInfo` |
| `app.badge` | `{ count }` (0–9999; 0 clears) | `{ applied: true }` |
| `app.openSettings` | none | `{ applied: true }`: the app's details open at its App settings section; see [App settings](#app-settings) |
| `people.list` | none | `AppMember[]`, up to 200; see [The person](#the-person) |
| `clipboard.write` | `{ text }` (up to 262,144 characters) | `{ applied: true }`; see [The sandbox](#the-sandbox) |
| `person.get` | none | `AppPerson` |
| `storage.get` | `{ key, scope? }` | `{ value }` (undefined when unset) |
| `storage.set` | `{ key, value, scope? }` | `AppEditOutcome` |
| `storage.remove` | `{ key, scope? }` | `AppEditOutcome` |
| `storage.keys` | `{ scope? }` | `{ keys }`, sorted |
| `role.get` | none | `AppRoleView` |
| `role.can` | `{ permission }` | `boolean`: whether the role has one of this app's own [permissions](#permissions); an id the manifest does not declare fails |
| `settings.get` | none | `Record<string, string>`: the app's [settings](#app-settings) as this person filled them in, secrets included; an unset one is absent |
| `events.subscribe` | `{ events: AppEventName[] }` (1–16) | `{ events }` now heard |
| `events.unsubscribe` | `{ events: AppEventName[] }` | `{ events }` still heard |
| `canvas.getViewport` | none | `AppViewport` |
| `canvas.setDevice` | `{ device }` | `AppViewport` |
| `canvas.setWidth` | `{ widthPx }` (240–6000) | `AppViewport` |
| `canvas.scrollTo` | `{ nodeId, occurrence?, block? }`, `{ ref, block? }` or `{ x, y, block? }` (`block` `'center'`, the default, or `'start'`) | `AppEditOutcome`; see [Navigating](#navigating) |
| `canvas.snapshot` | `{ nodeId, occurrence?, widthMax? }` or `{ ref, widthMax? }` (`widthMax` 16–800, default 320) | `AppSnapshotOutcome`: a PNG data URL of at most 200 KiB; see [Navigating](#navigating) |
| `panels.open` | `{ panel: AppLeftPanel }` | `AppPanels` |
| `panels.close` | none | `AppPanels` |
| `panels.openRight` | `{ panel: AppRightPanel }` | `AppPanels` |
| `panels.get` | none | `AppPanels` |
| `selection.get` | none | `AppSelection` |
| `selection.set` | `{ nodeId }` (omit to clear) | `AppEditOutcome` |
| `page.get` | none | `AppPageView` or undefined |
| `page.list` | none | `AppPageSummary[]` |
| `page.open` | `{ path }` (a page from `page.list`) | `AppEditOutcome`, once the page is open; see [Navigating](#navigating) |
| `component.open` | `{ path }` (a project `.astro` component) | `AppEditOutcome`, once the component is open; see [Navigating](#navigating) |
| `page.getTree` | `{ path }` (a page or component from `page.list` or the project's components) | `AppPageView` or undefined; see [Reading other pages](#reading-other-pages) |
| `page.findByAttribute` | `{ name, limit? }` (`limit` 1–500, default 500) | `{ matches: AppAttributeMatch[], truncated }` |
| `node.get` | `{ nodeId }` | `AppNodeView` or undefined |
| `node.setAttribute` | `{ nodeId, name, value }` | `AppEditOutcome` |
| `node.removeAttribute` | `{ nodeId, name }` | `AppEditOutcome` |
| `node.addClass` | `{ nodeId, className }` | `AppEditOutcome` |
| `node.removeClass` | `{ nodeId, className }` | `AppEditOutcome` |
| `node.setStyle` | `{ nodeId, css }` (the inline `style`; empty removes it) | `AppEditOutcome` |
| `node.insert` | `{ kind: 'element', tag, attributes? }` or `{ kind: 'component', name, props? }`, plus optionally `{ position: 'before' \| 'after' \| 'inside', anchor, index? }` or `{ replace }`, and `label?` | `AppInsertOutcome`: `{ applied: true, nodeId }` or `{ applied: false, reason }` |
| `node.remove` | `{ nodeId }` | `AppEditOutcome` |
| `node.duplicate` | `{ nodeId }` | `AppEditOutcome` |
| `node.measure` | `{ nodeId, occurrence? }` or `{ ref }` | `{ rects: AppRect[] }`, up to 500 (one for a ref); empty when it is not on the canvas |
| `node.key` | `{ nodeId }` | `AppNodeKeyOutcome`; see [Durable node keys](#durable-node-keys) |
| `node.find` | `{ key }` or `{ ref }` | `{ nodeId }`, undefined when no element of the open page carries it; for a ref, `{ nodeId, ref }`: the open page's element holding it and the ref with current ids, both undefined when a step is gone; see [Node refs](#node-refs) |
| `canvas.capture` | `{ on, cursor?, mode?, reason? }` (`mode` `'capture'`, the default, or `'observe'`; `reason` the chip's text, up to 60 characters) | `AppEditOutcome`; see [Canvas clicks](#canvas-clicks) and [Observing clicks](#observing-clicks) |
| `canvas.setOutlineMode` | `{ mode }`: `'deep'` or `'normal'` | `AppEditOutcome`; see [Outline modes](#outline-modes) |
| `canvas.highlight` | `{ ref }` or `{ nodeId, occurrence? }`, each with `style?` (`'selected'`, the default, or `'hover'`); nothing (or `{}`) clears it | `AppEditOutcome`; see [Highlights](#highlights) |
| `canvas.startInsertDrag` | `node.insert`'s item (`{ kind: 'element', tag, attributes? }` or `{ kind: 'component', name, props? }`) with `label?` and `preview?` | The SDK's helper answers the drop: `AppInsertOutcome`; see [Drag to insert](#drag-to-insert) |
| `canvas.insertDrag` | `{ phase: 'move' \| 'drop', x, y }` or `{ phase: 'cancel' }`, the pointer in the frame's pixels | `{ over }` for a move, `AppInsertOutcome` for the drop; the SDK's `startInsertDrag` sends these for you |
| `history.undo` | none | `AppEditOutcome` |
| `history.redo` | none | `AppEditOutcome` |
| `overlay.set` | `{ items: AppOverlayItem[] }` | `{ applied: true }` |
| `overlay.clear` | none | `{ applied: true }` |
| `overlay.post` | `{ itemId, data }` from the app, `{ data }` from an overlay frame (`data` up to 65,536 characters) | `{ delivered }`: how many frames heard it; see [Messages to overlay frames](#messages-to-overlay-frames) |
| `ui.notify` | `{ message, kind? }` (up to 280 characters) | `{ applied: true }` |
| `ui.openFrame` | `{ page, width: 240–1600, height: 160–1200, modal?, data? }` | `{ frameId }` |
| `ui.closeFrame` | `{ frameId?, result? }` (`result` up to 4096 characters) | `AppEditOutcome` |
| `ui.theme` | none | `{ theme, tokens }`: the editor's theme and every design token's value in it; see [Look and feel](#look-and-feel) |
| `shortcuts.run` | `{ shortcut: AppShortcut }` | `AppEditOutcome` |
| `shortcuts.focus` | `{ editable }` | `{ applied: true }` |
| `shortcuts.claim` | `{ shortcuts: string[] }` (up to 32) | `{ shortcuts }` claimed now |
| `commands.register` | `{ commands: AppCommand[] }` (up to 16) | `{ commands }` ids |
| `commands.trigger` | `{ shortcut }` (a reserved key) | `{ ran }` |
| `overrides.register` | `{ point: AppOverridePoint }` | `{ owner }` |
| `overrides.unregister` | `{ point }` | `{ applied: true }` |
| `overrides.resolve` | `{ call, point, result }` | `AppEditOutcome` |
| `files.list` | `{ dir? }` (a project folder; omit for the project root) | `{ entries: AppFileEntry[], truncated }`, up to 1000; see [Project files](#project-files) |
| `files.read` | `{ path }` | `AppFileContent`: `{ path, encoding, content, sizeBytes }`, `utf8` text or `base64` |
| `files.write` | `{ path, content, encoding?, label? }` (`encoding` `utf8`, the default, or `base64`) | `AppFileOutcome` |
| `files.delete` | `{ path, label? }` (a file or an empty folder) | `AppFileOutcome` |
| `files.move` | `{ from, to, label? }` (one file; `to` must not exist) | `AppFileOutcome` |
| `files.mkdir` | `{ path, label? }` | `AppFileOutcome` |
| `auth.connect` | `{ provider }` | `AppAuthStatus`, once the person finished signing in; see [Signing in](#signing-in) |
| `auth.token` | `{ provider }` | `AppAccessToken`: `{ accessToken, tokenType, expiresAtMs }`, refreshed by Stacki first when it is about to lapse |
| `auth.disconnect` | `{ provider }` | `AppEditOutcome` |
| `auth.status` | none | `AppAuthStatus[]`, one per declared provider |
| `net.fetch` | `AppNetRequest`: `{ url, method?, headers?, body?, encoding?, auth? }` | `AppNetResponse`: `{ status, url, headers, body, encoding }`; see [Calling services from Stacki](#calling-services-from-stacki) |

Edits run the editor's own gestures: each is one undo step, is saved before the promise resolves,
and answers `applied: false` with a reason when the page cannot be edited or the element is gone.
`node.setAttribute` writes plain attributes: use `addClass` and `setStyle` for `class` and `style`;
event handlers (`on…`) and Astro directives (`client:load`, `set:html`, …) are code, not
attributes, and are refused.

`node.insert` adds an element by tag or a project component by name. Without a position it lands
where the insert palette would put it for the selection. `position: 'before'` or `'after'` puts it
beside `anchor`; `'inside'` puts it in `anchor` at child `index` (0-based), or last when `index` is
left out. `replace: nodeId` puts it where that node stands and removes that node. A place that
cannot hold the new node (a `<div>` inside a `<p>`, anything inside an `<img>`) is refused with the
reason, not moved. `attributes` (an element) or `props` (a component) give the new node up to 32
string values, under the same name rules as `node.setAttribute`. `class` and `style` are allowed,
since a new node has none of its own yet, and `class` must be class names only. Every insert,
including its replacement and any import it adds or leaves unused, is one undo step and one save.
An insert answers `nodeId`, the new node's id as `node.get` and the selection name it on the open
page once the promise resolves; it is `undefined` only when the editor cannot tell which node it
made (Studio, if its server's answer does not arrive in time or names a different node).
`node.insert` never adds `<script>` or `<style>`: they are code, which runs in visitors' browsers
and in the canvas, so write them with `files.write` (needs the role's `code:edit`). Studio does not
yet set attributes or props, or replace a node; check `app.info().can.insertAttributes` and
`can.insertReplace`.

Not every editor has every edit yet: read `app.info().can` at startup instead of finding out by
failing ("Desktop and Studio").

### Events

Subscribe with `stacki.on(name, listener)`; it calls `events.subscribe` for the first listener of an
event and `events.unsubscribe` when the last one stops. Every event is an `AppEventName`.

| Event | Data |
|---|---|
| `selection.change` | `AppSelection` |
| `hover.change` | `AppSelection` (the element under the pointer or the navigator row) |
| `canvas.change` | `AppViewport` |
| `panels.change` | `AppPanels` |
| `page.change` | `{ path: string \| undefined }`: another page or component was opened |
| `project.change` | `{ source: AppChangeSource, paths?: string[], origin: AppChangeOrigin }`: the open page, stylesheets and variables, CMS content, assets, or other project files changed. `paths` names the project files, relative to the project, when Stacki knows them and there are at most 64; absent means unknown or many. `origin` is `self` for the change this app's own edit made, so it can skip its echo, and `other` for everything else (another app, Git, another editor) |
| `overlay.click` | `{ itemId: string, nodeId: string \| undefined }` for an `interactive` overlay item |
| `overlay.drag` | `AppOverlayDrag`: a `draggable` overlay item of this app is being dragged; see [Dragging](#dragging) |
| `overlay.hover` | `{ itemId: string \| undefined }`: the pointer moved onto an `interactive` overlay item, or off every one; at most once per frame |
| `settings.change` | `{ ids: string[] }`: this person saved the app's settings (its details, where `app.openSettings` leads, or the setup prompt); `ids` are the settings whose values changed. Read them with `settings.get` |
| `overlay.message` | `{ itemId, data, from }`: an `overlay.post` message, `from: 'app'` in an overlay frame, `from: 'overlay'` in the app's own frames; see [Messages to overlay frames](#messages-to-overlay-frames) |
| `role.change` | `AppRoleView` |
| `shortcut.press` | `{ shortcut: string }`: a key the app claims, pressed while it has focus |
| `command.run` | `{ id, panel, shortcut }`: one of the app's commands ran |
| `override.request` | `{ call, point, context }`: answer with `overrides.resolve` (the SDK does, for a handler) |
| `override.cancel` | `{ call }`: Stacki stopped waiting; close the picker |
| `frame.close` | `{ frameId, result }`: a custom frame closed |
| `storage.change` | `{ key, scope, origin }`: one of this app's stored values changed; `key` is undefined when more than 64 changed at once (a pull): read again |
| `person.change` | `AppPerson`: the person hid or showed their details |
| `canvas.click` | `AppCanvasClick`: a canvas click, while the app captures them |
| `canvas.capture` | `{ on, reason }`: the app's capture started or ended. `reason` is `'app'` (its own `canvas.capture` call, either way), `'escape'` (the person pressed Escape) or `'replaced'` (another app took the canvas) |
| `canvas.outline` | `{ mode, reason }`: the outline mode this app set changed. `reason` is `'app'` (its own call), `'panel'` (another rail panel opened), `'replaced'` (another app was opened, brought to the panel or set a mode), `'project'` (the project closed) or `'restored'` (the person came back to the app, which had asked for deep mode) |
| `theme.change` | `{ theme, tokens }`: the editor's theme changed; what `ui.theme` now answers |
| `auth.change` | `AppAuthStatus`: this person connected or disconnected one of the app's providers, in its details or another window |

### Errors

A rejected request's `Error` has a `code`:

| Code | Meaning |
|---|---|
| `bad-request` | The message was malformed. |
| `unsupported-version` | The app speaks a newer API version than this Stacki. |
| `unknown-method` | No such method. |
| `role-denied` | The current role may not use this app, or may not see the panel asked for. |
| `bad-params` | The params failed validation; the message says which. |
| `busy` | 32 requests are already waiting; wait for answers. |
| `failed` | The command itself failed; the message says why. |

### Example: follow the selection

```js
const label = document.getElementById('selected');
async function show({ nodeId }) {
  if (nodeId === undefined) {
    label.textContent = 'Nothing selected';
    return;
  }
  const node = await stacki.node.get({ nodeId });
  label.textContent = node ? `<${node.name || node.kind}> ${node.classes.join(' ')}` : 'Not on the page';
}
stacki.on('selection.change', show);
stacki.selection.get().then(show);
```

### Example: add a class and undo it

```js
const { nodeId } = await stacki.selection.get();
if (nodeId) {
  const outcome = await stacki.node.addClass({ nodeId, className: 'is-highlighted' });
  if (!outcome.applied) {
    await stacki.ui.notify({ message: outcome.reason, kind: 'error' });
  }
}
// Later: the same step the person's ⌘Z would undo.
await stacki.history.undo();
```

## Shortcuts and commands

Keys pressed while an app has focus are the app's first. In order:

1. **The app's own handler.** A `keydown` listener on an element or the document that calls
   `preventDefault()` keeps the key in the app; Stacki does nothing.
2. **Claims.** A shortcut in the manifest's `shortcutClaims` or claimed with
   `stacki.shortcuts.claim([...])` (at most 32) is the app's. Stacki knows claims before the key
   arrives, so Desktop's Edit menu, which takes ⌘Z, ⇧⌘Z and ⌘E before a focused frame sees them,
   hands a claimed key to the app as `shortcut.press` instead of running Stacki's command. Handle
   claimed keys in `stacki.on('shortcut.press', …)`: the SDK raises it for a key press too.
3. **Text fields.** In an `input`, `textarea`, `select` or `contenteditable` element, undo and redo
   are the field's own, as everywhere else in Stacki.
4. **Forwarded editor shortcuts.** Only these reach Stacki, and each runs once:

| Key (⌘ on macOS, Ctrl elsewhere) | Shortcut | Stacki runs |
|---|---|---|
| ⌘Z | `undo` | Undo, the menu's and keyboard's command |
| ⇧⌘Z, ⌘Y | `redo` | Redo |
| ⌘S | `save` | Writes pending edits now |
| ⌘E | `palette` | Opens the insert palette on an editable page |
| Escape | `escape` | Stacki's Escape: leaves the preview or the component you drilled into |

Every other key stays in the app. Shortcuts are written as text: modifiers `Mod` (⌘ on macOS, Ctrl
elsewhere), `Alt` and `Shift`, then a letter, a digit or `Escape`, `Enter`, `Backspace`, `Delete`,
`Tab`, `Space` or an arrow (`ArrowUp`, …), in any case and order: `"mod+shift+k"` is `Mod+Shift+K`.

### The reserved range

App commands run on keys no Stacki shortcut uses, from anywhere in the editor: its panels, the canvas
and any app's frame, whether or not the app has focus or is running.

| macOS | Windows and Linux | Shortcut text |
|---|---|---|
| ⌘⌥⇧1 … ⌘⌥⇧9 | Ctrl+Alt+Shift+1 … 9 | `Mod+Alt+Shift+1` … `Mod+Alt+Shift+9` |

The range avoids ⌘⇧3 to 6 (macOS screenshots), ⌘⇧7 to 9 (rich text lists) and ⌥⌘0 to 6 (rich text
headings). A command `shortcut` outside it is refused when the app installs, with the range named.

### Commands

Declare commands in the manifest (`commands`), or for as long as the app runs with
`stacki.commands.register({ commands })`. A command runs from its key or from the insert palette's
Apps tab, where it is listed under its app with its key. If the app is not running, Stacki opens it
(docked or popup, as it last was) and delivers `command.run` once the app listens.

**Each `commands.register` call replaces the app's earlier runtime commands**, keys and all: pass
the whole list every time (after a sign-in adds one, say), and pass `[]` to remove them. The
manifest's commands are not affected, and runtime commands end when the app stops.

```js
stacki.on('command.run', ({ id, panel }) => {
  if (id === 'open-images') {
    showPanel(panel); // 'images', from the manifest
  }
});
```

A role without the app has none of its commands. When two apps want one key, the one installed first
keeps it; the other's details in the Apps panel mark the command with an amber dot, whose hint says
which app holds the key. An admin can give a
command another key in the range, or none, in the app's details. These choices are kept per person
and project in the editor's storage, like an app's window position: a key is a person's habit, and a
rebind does not change a file every teammate pulls.

## Overrides

While an app runs, docked or popped out, it can answer some of Stacki's own pickers in their place:

| Point | Where | Context | Answer |
|---|---|---|---|
| `assets.pick` | Every "Choose image…" (or video, audio, file) button: the Settings and Properties fields, CMS entries, backgrounds | `{ nodeId, field, accepts, current, acceptsURL }` | `{ kind: 'picked', url, alt? }`: an `https://` URL, or a project path in `public/` or `src/` |
| `cms.bind` | The data picker a field's dot opens, a data chip pressed to re-edit it, and a loop's Source | `{ purpose, current, paths, selection }` | `{ kind: 'picked', path }`: a data path such as `post.data.title` or `astro:posts` |

Any point may also answer `{ kind: 'default' }` (Stacki's own picker opens) or `{ kind: 'cancel' }`
(nothing changes). A pick is written through the field's own pick, the same call Stacki's picker
makes, so it is one undo step. An `alt` is written to an `<img>` (or a component with an `alt`
prop) in that same step: one undo takes back the image and its alt text together. A URL for a field that takes project files only (`acceptsURL: false`)
opens Stacki's picker instead.

Rules:

- **One owner.** The app that registered a point most recently, among running apps, answers it.
  Others queue behind it and answer again when it unregisters or closes.
- **Bounded.** Stacki waits 5 minutes for an answer, then opens its own picker and sends
  `override.cancel`. An app that closes, reloads or crashes mid-request gets the same. At most 4
  requests wait on one app.
- **Roles.** An app answers only for a role that may use it and that sees the point's panel (Assets
  for `assets.pick`, CMS for `cms.bind`).
- **Visible.** The button shows "via <App name>" while an app answers it. **Alt-click** (Option-click)
  opens Stacki's own picker; the waiting data picker also offers "Use Stacki's picker".

### Example: an image picker

```js
await stacki.overrides.register('assets.pick', async (context, { call, signal }) => {
  if (!context.accepts.includes('image')) {
    return { kind: 'default' };
  }
  const frame = await stacki.ui.openFrame({ page: 'picker.html', width: 720, height: 520, modal: true, data: JSON.stringify(context) });
  signal.addEventListener('abort', () => frame.close()); // Stacki stopped waiting
  const chosen = await frame.closed; // picker.html calls stacki.ui.closeFrame({ result: url })
  return chosen ? { kind: 'picked', url: chosen, alt: 'Photo' } : { kind: 'cancel' };
});
```

## Custom frames

`stacki.ui.openFrame({ page, width, height, modal, data })` opens one of the app's own HTML pages in
a modal over the editor (`modal: true`) or a popup beside it, with Stacki's header (the app's name and
a close button) on top. At most 2 are open per app; each is a sandboxed frame with the app's grants and
nothing more. Inside, `stacki.app.info()` returns `frame: { id, data }`, and
`stacki.ui.closeFrame({ result })` closes it and resolves the opener's `closed` (also sent as
`frame.close`). Closing it with Stacki's button resolves `closed` with `undefined`. A frame closes with
its app.

## Canvas overlays

Apps draw on the canvas with a **declarative overlay**: a list of items Stacki draws in the same
layer as its selection and hover outlines, from the same measurements, so items follow scrolling,
resizing and zoom with no lag. Each `overlay.set` replaces the app's whole overlay.

```ts
type AppOverlayAnchor =
  | { nodeId: string; occurrence?: number; at?: AppPoint } // an element: every place it renders, or one copy; `at` a point within it
  | { ref: AppNodeRef; at?: AppPoint } // one copy of an element anywhere on the canvas, inside components too (see Node refs)
  | { rect: { x: number; y: number; width: number; height: number } }; // a fixed rectangle in the canvas viewport (see below)

type AppOverlayItem =
  | { kind: 'box'; id: string; anchor: AppOverlayAnchor; color?: string; fill?: string; label?: string; dashed?: boolean; interactive?: boolean; draggable?: boolean }
  | { kind: 'label'; id: string; anchor: AppOverlayAnchor; text: string; placement?: 'top' | 'bottom' | 'center'; color?: string; background?: string; interactive?: boolean; draggable?: boolean; cluster?: boolean }
  | { kind: 'pin'; id: string; anchor: AppOverlayAnchor; label?: string; tone?: 'accent' | 'success' | 'muted' | 'danger'; avatarURL?: string; active?: boolean; interactive?: boolean; draggable?: boolean; cluster?: boolean }
  | { kind: 'heat'; id: string; anchor: AppOverlayAnchor; columns: number; rows: number; values: number[]; color?: string }
  | { kind: 'frame'; id: string; anchor: AppOverlayAnchor; path: string; interactive?: boolean };
```

- A `rect` is in canvas viewport coordinates: `x` and `y` count from the top-left corner of the
  visible page, in the page's CSS pixels before the canvas's zoom, so a rectangle stays put as the
  page scrolls and Stacki scales it with the zoom.
- Colors are hex: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
- A `heat` map has `columns × rows` values from 0 to 1 (at most 64 × 64 and 1024 cells).
- A `frame` opens one of the app's own HTML files in its own frame over the element: use it for
  interactive controls a description cannot express, such as a 3D model rotator. It loads the SDK
  like any app page. Without `interactive`, clicks pass through it to the canvas.
- **Hand a `frame` its data with `overlay.post`**, never through storage or the URL: see [Messages to
  overlay frames](#messages-to-overlay-frames). `stacki.storage` is for values that outlive the
  app; a frame that polls it, or is re-set to reload, lags and flickers.
- `interactive` boxes, labels and pins send `overlay.click`; `draggable` ones send `overlay.drag`
  (see [Dragging](#dragging)). Only boxes, labels and pins take `draggable`.
- Only clicks and drags are an item's. Wheel and trackpad scrolling and pinch zoom always reach the
  canvas, over any item: over an interactive or draggable one, Stacki hands the wheel to the page as
  if it had landed there. A label takes the pointer on its drawn text only, never across the element
  it is anchored to, and a small label, box or pin is clickable across at least 24 × 24 pixels.
- An item is above the canvas, so a click on an interactive or draggable item is the item's even
  while an app captures canvas clicks (see [Canvas clicks](#canvas-clicks)); a click anywhere else
  is the capture's.
- `interactive` boxes and labels also send `overlay.hover` with the item's id when the pointer moves
  onto one, and `{ itemId: undefined }` when it leaves: show a hover card for a pin. It is sent at
  most once per animation frame, the latest hover winning, and never twice for the same item.
- Limits, which keep the canvas fast: 64 items, 64 distinct elements, 2 frames, labels up to 120
  characters, unique item ids.

Drawing in Stacki's own layer costs no extra documents and never lags a scroll; frames are there for
the cases that need real code, at the cost of one document each.

```js
const { nodeId } = await stacki.selection.get();
if (nodeId === undefined) {
  await stacki.overlay.clear(); // Nothing selected: nothing to anchor to.
} else {
  await stacki.overlay.set({
    items: [
      { kind: 'box', id: 'focus', anchor: { nodeId }, color: '#f97316', label: 'Most clicked', interactive: true },
      { kind: 'heat', id: 'clicks', anchor: { nodeId }, columns: 4, rows: 2, values: [0.1, 0.4, 0.9, 0.2, 0, 0.3, 0.6, 1] },
    ],
  });
}
stacki.on('overlay.click', ({ itemId }) => console.log('clicked', itemId));
```

### Messages to overlay frames

`overlay.post` is how an app hands data to an overlay `frame` item, and how the frame answers. A
`frame` item is a whole document: setting the overlay again with a changed item reloads it, and the
frame cannot read the app's memory or its window. So set the item once, then post it the data it
should show, as often as it changes. `overlay.post({ itemId, data })` from the app reaches
the frame that draws `itemId`; inside that frame, `overlay.post({ data })` (no `itemId`) reaches the
app's own frames, its window and custom frames. Each side hears the other with `overlay.message`:

```js
// The app: keep the frame, send it new state.
await stacki.overlay.set({ items: [{ kind: 'frame', id: 'rotator', anchor: { nodeId }, path: 'rotator.html', interactive: true }] });
stacki.on('overlay.message', ({ itemId, data }) => {
  if (itemId === 'rotator' && data === 'ready') {
    void stacki.overlay.post({ itemId: 'rotator', data: JSON.stringify({ angle }) });
  }
});

// rotator.html: say when it can listen, then follow the app.
stacki.on('overlay.message', ({ data }) => turnTo(JSON.parse(data).angle));
await stacki.overlay.post({ data: 'ready' });
```

- `data` is a string of up to 65,536 characters: send JSON for structured state.
- Only frames of the same app hear a message, and only those that listen to `overlay.message`. The
  answer, `{ delivered }`, counts them: 0 means the frame has not loaded or not subscribed yet, so
  have the frame say when it is ready, as above.
- A frame item posts only as itself: naming another item fails.

### Point anchors

`at` pins an item to a spot within its element: `x` and `y` each run 0 (left, top) to 1 (right,
bottom) of the element's box, so `{ x: 0.33, y: 0.5 }` is a third of the way across, halfway down.
Stacki works the point out in the same measurement pass that draws the element's box, so it stays on
that spot through scrolling, resizing, reflow and zoom with no lag. Only a `label` or a `pin` takes a
point (a point has no size to draw a box or heat map on); `placement: 'center'` centres a label on it,
and a pin's tail points at it. With no `occurrence` the item is drawn on every copy of a repeated
element, at the same point of each.

```js
await stacki.overlay.set({
  items: [{ kind: 'label', id: 'pin-7', anchor: { nodeId, at: { x: 0.33, y: 0.5 } }, text: '7', placement: 'center', interactive: true }],
});
```

### Pins

A `pin` is a comment marker drawn the way design tools draw one: a round 24-pixel badge whose tail
points at the anchor point (an element's top-left corner when the anchor has no `at`).

- `label`: up to 3 characters, such as the comment's number, in white on the badge.
- `tone`: the fill, one of the editor's own colours: `'accent'` (the default), `'success'`,
  `'muted'` or `'danger'`.
- `avatarURL`: an `https://` image, at most 2048 characters, shown in the badge while the pointer is
  on it, such as the author's picture. Any https host works, as for images in an app's own pages;
  Stacki loads it with no referrer.
- `active: true` draws a ring around the badge: the pin's comment is open or selected.
- On hover the badge grows a little. Pins cluster with the same app's labels and pins by the rules in
  [Crowding](#crowding) (`cluster: false` keeps one apart), send `overlay.click` when `interactive`
  and `overlay.drag` when `draggable`.

```js
await stacki.overlay.set({
  items: comments.map((comment, index) => ({
    kind: 'pin',
    id: comment.id,
    anchor: { nodeId: comment.nodeId, at: comment.at },
    label: String(index + 1),
    tone: comment.resolved ? 'muted' : 'accent',
    avatarURL: comment.author.pictureURL,
    active: comment.id === openCommentId,
    interactive: true,
    draggable: true,
  })),
});
```

For geometry of your own, `node.measure({ nodeId })` answers the element's boxes (one per place it
renders) in canvas viewport coordinates, like a `rect` anchor. It is a one-off read: it lags a scroll
by a round trip, which an anchor does not. An element the canvas was not already measuring is
measured for the call, waiting at most a second; one that is not rendered answers `rects: []`.

### Crowding

Labels and pins of one app on elements (or points within them) that land within 24 pixels of each other on
screen collapse into one count bubble, so a page with thirty pins stays legible. Clicking the bubble
lists its labels; an `interactive` label in the list sends `overlay.click` as itself. Zooming in
spreads the pins apart again. Bubbles are worked out per app, from the drawn positions, so they
follow scroll and zoom. Labels on a `rect`, and labels with `cluster: false`, are never collapsed.
A label in a bubble cannot be dragged (see [Dragging](#dragging)).

## Canvas clicks

An app can take the next clicks on the canvas, the way a design tool places a comment: click the
thing, then type. `canvas.capture({ on: true })` starts capturing; while it lasts, a click on the
canvas does not select. It goes to the app as `canvas.click`:

```ts
interface AppCanvasClick {
  nodeId: string | undefined; // the open page's element under the click; undefined over markup the open file does not own
  at: AppPoint | undefined;   // where in that element's box, 0–1 each way: ready to use as an anchor's `at`
  x: number;                  // the click in the canvas viewport, as a `rect` anchor's x and y
  y: number;
  layers: AppNodeLayer[];     // every file's element under the click, innermost first: see Layers below
}
```

- `cursor` is `'crosshair'` (the default), `'default'`, or the app's own image:
  `{ image: 'pin.svg', hotspot: { x: 8, y: 23 } }`. `image` is a PNG or SVG in the app's bundle, at
  most 4 KiB and 32 × 32 pixels (an SVG sets `width` and `height` in pixels on its `<svg>`);
  `hotspot` is the pixel that points, 0–31 each way, the top left by default. Stacki reads and checks
  the file when the capture starts and answers `applied: false` with the reason when it is missing,
  too large or not such an image; where the canvas cannot draw it, the crosshair shows instead.
  While an app captures, the canvas shows that cursor and a chip reading "App name: Click to place ·
  Esc to cancel"; a double click does not open a component.
- `reason` is the chip's text in place of "Click to place": one line of up to 60 characters saying
  what the click is for (`'Click to pin a comment'`, `'Click an element to see its stats'`). Stacki
  puts the app's name before it, and " · Esc to cancel" after it while capturing.
- One app captures at a time. The rules are the overrides': the most recent `capture({ on: true })`
  wins, Escape cancels, and closing the app releases the capture.
- Every start and end reaches the app as `canvas.capture` with `{ on, reason }`, so a panel and its
  popup agree on the state. `reason` says why: `'app'` for the app's own `capture` call, whether it
  starts or ends the capture; `'escape'` when the person pressed Escape; `'replaced'` when another
  app took the canvas. Closing the app sends nothing, since its frames are gone.
- A capture lasts until it ends: for one placement, call `capture({ on: false })` in your
  `canvas.click` listener.
- It works on the Desktop canvas and in Studio's preview alike.

```js
const place = document.querySelector('#place');
place.onclick = () => stacki.canvas.capture({ on: true });
stacki.on('canvas.capture', ({ on }) => (place.disabled = on));
stacki.on('canvas.click', async ({ nodeId, at }) => {
  await stacki.canvas.capture({ on: false });
  place.disabled = false;
  if (nodeId !== undefined) {
    addPin({ nodeId, at }); // Then draw it with an anchor { nodeId, at }.
  }
});
```

### Observing clicks

`capture` takes the canvas from the editor: a click selects nothing. An app that works beside the
editor (comments placed while the person navigates, enters components and uses the Navigator)
observes instead:

```js
await stacki.canvas.capture({ on: true, mode: 'observe', reason: 'Click an element to see its stats', cursor: { image: 'pin.svg', hotspot: { x: 8, y: 23 } } });
```

- Every click does what it always does: it selects, a double click enters a component, the context
  menu and the Navigator work, and Escape leaves a component as usual (it does not end the
  observing; call `capture({ on: false })`).
- The app also hears each **single** click as `canvas.click` (`nodeId`, `at`, `x`, `y`, `layers`),
  relative to the file open on the canvas, which may be a component: its `nodeId` and the last of
  its `layers` are that file's. The click reaches the app once the double-click window (350 ms) has
  passed; a double click reaches it as nothing, so entering a component stays instant and is never
  a placement.
- The cursor applies as in a capture. The chip reads "App name: " and the `reason` you pass, or
  "App name is listening for clicks" without one, and offers no Escape. The rules of one owner at a
  time, and of closing the app, are a capture's.
- With a component open, `page.get` answers that component, `node.key` keys its elements, and
  `selection.change` follows the selection inside it, as on a page.

### Layers

`nodeId` names only what the open page owns. A click on a nav link that the page's `<Layout>`
renders through `Nav` and `NavLink` has `nodeId` of the `<Layout>`; `layers` names every file's
element on the way down, innermost first, ending at the open page's:

```ts
interface AppNodeLayer {
  file: string;                    // 'src/components/NavLink.astro', relative to the project
  nodeId: string;                  // its id as page.getTree({ path: file }) gives it
  key: string | undefined;         // its data-stacki-key, when it has one
  component: string | undefined;   // 'NavLink' when this layer is a component instance
  instancePath: AppNodeRefStep[];  // the instances it sits in, the open page's element first
  ref: AppNodeRef;                 // addresses this one copy: see Node refs
}
```

For that click, `layers` is the `<a>` in `NavLink.astro`, the `<NavLink>` in `Nav.astro`, the `<Nav>`
in `BaseLayout.astro` and the `<Layout>` in the page: four layers. Content a page passes into a
component's slot is the page's own, so a click on it has one layer. A layer Stacki cannot name in
its file is left out; `layers` is empty when the canvas cannot say, and holds at most 32. Overlay
drags (`overlay.drag`) carry `layers` too.

### Node refs

A layer's `ref` names one copy of an element anywhere on the canvas, inside component instances
too: the open page's element first, then each element down to it, each with the copy it is inside
the step before (`copy`, 0 unless a loop renders it more than once there). Two links NavLink renders
in the header's Nav and the footer's Nav are two refs. Store the ref as it is and pass it back:

- `node.measure({ ref })` answers that copy's box, `canvas.scrollTo({ ref, block? })` brings it into
  view, `canvas.snapshot({ ref })` photographs it, and an overlay anchor `{ ref, at? }` draws on it,
  following scroll and edits.
- `node.find({ ref })` answers `{ nodeId, ref }`: the open page's element that holds it (the element
  itself, or the instance it renders inside) and the ref with each step's current id and key; both
  are undefined when a step's element is gone.
- A step finds its element by `key` first, else by `nodeId`. Ids from other files are positions in
  that file, so an edit before the element in the same file moves them; give each step a key to
  outlast that. Key the open page's element with `node.key({ nodeId })`; for an element inside a
  component, open the component (`component.open`), key the element there, and put the key in the
  step. A copy is counted inside its own instance, so adding copies elsewhere on the page never moves
  a ref.
- An app may write a ref by hand: `{ steps: [{ file, key?, nodeId?, copy? }] }`, each step naming
  its element by key, id or both.

```js
stacki.on('canvas.click', async ({ layers, at }) => {
  const [inner] = layers; // The NavLink's <a>, not the page's <Layout>.
  if (inner !== undefined) {
    addPin({ ref: inner.ref, at }); // Draw it with an anchor { ref, at }; store the ref with the comment.
  }
});
```

## Outline modes

The canvas outlines what the open page owns: hovering a nav link that `<Layout>` renders through
`Nav` and `NavLink` outlines the `<Layout>`. An inspecting app can ask for **deep** outlines:

```js
await stacki.canvas.setOutlineMode({ mode: 'deep' });
stacki.on('canvas.outline', ({ mode, reason }) => (deepToggle.checked = mode === 'deep'));
```

- In `deep` mode, hovering inside a closed component outlines exactly what the editor would with
  that component open for editing: the deepest node of its own file under the pointer (the same
  layers a `canvas.click` names). A component instance there gets the green component outline and
  its name (`NavLink` in Nav, `Icon` in Footer); a plain element gets the element outline and its
  first class or tag (`.footer_link`). The page's layout counts as the page, as the editor treats
  its chrome, so a link in the layout's Footer is Footer's. On the page's own markup outside any
  closed component, hovers draw as always.
- Deep mode is for looking. A click still selects what the open page owns (the closed instance), or
  goes to the app while it captures clicks, so Delete, cut, paste, duplicate, drag and the context
  menu never reach an element inside a closed component. The page's own elements work as always.
- The app that sets it owns it. It goes back to `normal` by itself when that app sets `normal`,
  closes or stops, when the person opens another rail panel than Apps, when another app is opened or
  brought to the panel (or sets a mode), and when the project closes. The app hears each change as
  `canvas.outline` `{ mode, reason }`; a stopped app hears nothing.
- Stacki remembers each app's last request. When the person comes back to an app that asked for
  `deep` (its panel shown again, its popup focused or shown), deep mode is restored and the app hears
  `canvas.outline` `{ mode: 'deep', reason: 'restored' }`. Setting `normal` yourself forgets the
  request, and so do the app stopping and the project closing.
- Desktop and Studio alike.

## Highlights

An app can point at an element the way the editor's own outlines do, without selecting it: a
"Pin to" menu that outlines each choice as the person hovers it.

```js
row.onmouseenter = () => stacki.canvas.highlight({ ref: layer.ref });
menu.onmouseleave = () => stacki.canvas.highlight(); // Nothing clears it.
```

- `canvas.highlight` takes a ref (a `canvas.click` layer's, so elements inside closed components
  work), an open-page `{ nodeId, occurrence? }`, or nothing to clear.
- It is drawn as the editor draws a selected node, labelled as the editor labels it: a component
  instance in the green selected outline with ⬡, its name and the component chip, an element in
  the selected element outline with its first class or tag. `style: 'hover'` draws the hover look
  instead. It has a slot of its own, so the person's real selection still shows beside it; the
  hover outline gives way while it shows.
- Display only: it selects nothing, changes nothing and is no undo step.
- One shows at a time: the latest app's replaces another's, and an app clears only its own. It is
  also cleared when its app stops, when the person opens another rail panel than Apps, and when the
  outline mode resets to normal. A target that is gone, or not drawn on the canvas, answers
  `applied: false` with the reason.
- Desktop and Studio alike.

## Drag to insert

An app can offer elements and components that the person drags onto the canvas, as the editor's own
insert does. Call the SDK's helper on `pointerdown`:

```js
tile.addEventListener('pointerdown', async (event) => {
  event.preventDefault();
  const outcome = await stacki.canvas.startInsertDrag({ kind: 'component', name: 'Card', props: { title: 'New' }, label: 'Add card' });
  if (outcome.applied) {
    await stacki.selection.set({ nodeId: outcome.nodeId });
  }
});
```

- The item is exactly `node.insert`'s (an element by tag with `attributes`, or a component by name
  with `props`) and is checked the same way when the drag starts: a host or role that cannot insert
  it refuses at once with `applied: false`, so nothing is dragged that cannot land. `preview` is the
  chip's text beside the pointer (the tag or name by default); `label` names the undo step.
- While the pointer moves, the canvas shows where the drop lands: a line before or after an
  element, or the element filled for a drop inside it (last). The top and bottom quarters of an
  element put the drop beside it; a component instance, an image or other void element and text
  take it only beside them. The target is what a click would select, so nothing ever drops inside a
  closed component.
- Releasing over a target inserts there, as `node.insert` does: one undo step, saved, heard as your
  own `project.change`, answering `{ applied: true, nodeId }`. Releasing anywhere else, or Escape
  (in the app or the editor), answers `applied: false` with the reason, and inserts nothing.
- One drag at a time; a stopped app's drag ends. The helper sends `canvas.insertDrag` steps itself,
  since the pointer stays with the app's frame while pressed: an app never calls it directly.
- Desktop inserts components and elements; Studio inserts components (its element insert is not
  available to apps yet, and the drag refuses at the start with that reason).

## Dragging

A `draggable` box, label or pin can be pressed and moved, so a pin moves the way pins move in every comment
tool. Stacki never moves the item: it tells the app where the pointer is, and the app redraws the item
with `overlay.set`, then writes the new place once when the drag ends, so a move is one undo step.

```ts
interface AppOverlayDrag {
  itemId: string;
  phase: 'start' | 'move' | 'end';
  nodeId: string | undefined; // under the pointer now: the same geometry as `canvas.click`
  at: AppPoint | undefined;
  x: number;
  y: number;
  cancelled: boolean;         // true only on an `end` that Escape, a lost pointer or Stacki cut short: put it back
}
```

- Only the app that drew the item hears its drag, and one drag runs at a time.
- A press that moves less than 4 pixels on screen is a click: an `interactive` item sends
  `overlay.click` as before, so clicking a pin stays reliable. A drag never also clicks.
- A drag sends one `start`, any number of `move`s, and one `end`, in that order. `move` comes at most
  once per frame, for the latest pointer position: a slow page drops moves, it does not queue them.
- The drag ends with `cancelled: true` (and the last geometry the app heard) on Escape, when the
  pointer is lost, when the app stops, and when an `overlay.set` leaves the item out or no longer
  `draggable`. Redrawing the item on each `move` keeps the drag going.
- While a drag runs the pointer belongs to it, over the whole canvas and beyond: the page under it
  does not hover or select, and the item shows a grabbing cursor (a grab cursor before).
- A label collapsed into a count bubble ([Crowding](#crowding)) cannot be dragged: zoom in until it
  stands alone, or give a label you want draggable `cluster: false`. The label being dragged never
  joins a bubble while the drag lasts.
- It works on the Desktop canvas and in Studio's preview alike.

```js
const moving = new Map(); // itemId → where the pointer has it now

stacki.on('overlay.drag', async ({ itemId, phase, nodeId, at, cancelled }) => {
  if (phase !== 'end') {
    moving.set(itemId, { nodeId, at }); // Drawn under the pointer while it moves.
  } else {
    moving.delete(itemId); // Cancelled: drawn back where it was.
    if (!cancelled && nodeId !== undefined) {
      await movePin(itemId, { nodeId, at }); // One write, one undo step.
    }
  }
  await stacki.overlay.set({ items: drawPins(moving) }); // Each pin with draggable: true.
});
```

## Navigating

An app can take the person back to a saved place: open the page or component, restore the breakpoint,
then bring the element into view and select it.

```js
await stacki.page.open({ path: 'src/pages/pricing.astro' }); // or stacki.component.open({ path: 'src/components/Card.astro' })
await stacki.canvas.setDevice({ device: 'tablet' });
const { nodeId } = await stacki.node.find({ key });
if (nodeId !== undefined) {
  await stacki.canvas.scrollTo({ nodeId, block: 'center' });
  await stacki.selection.set({ nodeId });
}
```

- `page.open({ path })` opens a page from `page.list`, as the Pages panel does, leaving any component
  the person was in. `component.open({ path })` enters a component's own canvas, as opening it from
  the Components panel does: the component shows with its default props, not one page instance's.
  Both resolve once `page.get()` names the file, waiting at most 5 seconds, and answer `applied: false`
  with the reason otherwise. Opening another page needs a role with the Pages panel; entering a
  component needs one that may edit components.
- **Which file is open.** `page.get()` names the file being edited, and `page.change` fires when it
  changes. Inside a component that is the component's file, with the component's tree: its node ids,
  `node.key`, `node.find`, overlay anchors and `canvas.click` are all the component's. An app keeping
  comments per file keys them by `page.get().path`: a path under `src/pages/` is a page, any other
  `.astro` file is a component or layout.
- `canvas.scrollTo({ nodeId, occurrence?, block? })` waits until the canvas draws the element (a page
  just opened, a breakpoint just changed), at most 5 seconds. `block: 'center'`, the default, uses
  the editor's own reveal: it scrolls a panel the element sits in, and moves only when the element is
  not already in view. `block: 'start'` puts the element's top at the canvas's top. `{ x, y }` scrolls
  the page to that point of the document, in its CSS pixels.
- `canvas.setDevice` changes the breakpoint at once; the `scrollTo` after it waits for the new layout.
- `selection.set({ nodeId })` selects and outlines the element, as a click on it does; omit `nodeId` to
  clear the selection.
- `canvas.snapshot({ nodeId, occurrence?, widthMax? })` answers a PNG of the element as the canvas
  draws it now, at most `widthMax` pixels wide (16–800, default 320) and 200 KiB, as a `data:` URL for
  a comment's thumbnail. Only the part in view is taken (scroll to it first), with Stacki's outlines
  and overlays as they show. One per second per app. Desktop only: Studio answers `applied: false`,
  and `app.info().can.snapshot` says which.

## Durable node keys

**How long a node id lasts.** A node id names an element of the open page for as long as that page
stays open and the element exists. On Desktop it survives edits, made in Stacki or outside it, as long
as Stacki can map the element's source through the change; in Studio an id is the element's position,
so an edit that moves it, or an element before it, changes it. Reopening a page, switching branches,
and a change Stacki cannot map all give new ids. Never keep an id between sessions.

**Keys outlast that.** `node.key({ nodeId })` answers a key that stays with the element across edits,
moves, wraps, renames, outside edits, Git merges and sessions, and `node.find({ key })` answers the
element of the open page that carries it now. Use the key to remember an element (a comment's
target, an annotation, a test id) and `find` to get its current id back.

- The key is written into the markup, as one `data-stacki-key="k…"` attribute on the element, the
  first time an app asks for that element's key. That is one undo step, saved like any edit. Asking
  again for an element that has a key writes nothing. Nothing is written for an element no app asked
  about.
- Keys are random (`k` and 12 letters or digits), so they say nothing about the page and never meet.
- Elements and component instances carry keys; text and expressions hold no attributes and are
  refused. Where attribute edits are refused (Studio, for now), `node.key` answers
  `applied: false` for an element that has no key yet.
- **Identical twins.** Two elements with the same tag, classes and text are told apart once keyed:
  each has its own key. What can make two elements share a key is copying a keyed one (duplicate,
  copy and paste, or by hand). `node.find` then answers the first in document order, which for a
  duplicate placed after the original is the original, and `node.key` on the later copy writes it a
  fresh key. Before an app keys them, twins are told apart only by their ids, for as long as those
  last.
- Stacki hides the attribute from every list a person reads: the Settings tab's Attributes, an
  instance's fields, the selector chips and the element tip (`shared/core/internalAttributes.ts`
  holds the rule). Hidden is not removed: editing, renaming, deleting or pasting other attributes
  leaves it on the element with its value.
- The attribute ships in the built site's HTML. It is inert there, but anyone who reads the markup
  sees it; remove it with `node.removeAttribute` when the app is done with the element.
- To find keyed elements on other pages, use `page.findByAttribute({ name: 'data-stacki-key' })`.

Why a key in the markup rather than a structural fingerprint (tag, classes, first words, position)
with a mapping stored beside the project: a fingerprint writes nothing, but it is a guess. It breaks
when the element's surroundings change, and it cannot tell identical twins apart at all, which is
exactly when a comment app needs to. A key travels with the element's own source, so anything that
keeps the element keeps the key. The cost is one attribute in the markup, written only on request.

## Reading other pages

`page.get()` is the page open on the canvas. Two methods read the rest of the project without opening
anything:

- `page.getTree({ path })` answers any page or component as `page.get()` would: the same
  `AppPageView`, read from disk. `path` is relative to the project, as `page.findByAttribute`'s
  matches name it. For the open page it answers the live tree. Node ids of another page are the ids
  opening it would give, until it is edited: use them to show where something is, and `node.key` to
  remember it.
- `page.findByAttribute({ name, limit? })` scans every page and component for elements carrying the
  attribute `name`, and answers `{ matches: [{ path, nodeId, value }], truncated }` in project order.
  It is how an app finds its own marks (`data-stacki-key`, or an attribute it writes) without reading
  everything itself.

Bounds: at most 2000 files are considered, one call reads at most 32 MiB from disk, and a search
answers at most 500 matches (`limit`, default 500). Parsed files are cached by modification time and
size, so a second call reads only what changed. `truncated: true` means the answer may be missing
matches: the limit was reached, or files were left for the next call because of the byte budget; the
next call carries on where the cache leaves off.

Both need a role that sees the Pages panel (`panel:pages`); without it they answer `role-denied`.

## Project files

`stacki.files.*` reads and changes the project's own files: a sitemap generator writes
`public/sitemap.xml`, an importer adds Markdown entries, a refactor moves a component.

```js
const { entries } = await stacki.files.list({ dir: 'src/content/blog' });
const { content } = await stacki.files.read({ path: 'src/content/blog/hello.md' });
const outcome = await stacki.files.write({ path: 'public/robots.txt', content: 'User-agent: *\n', label: 'Write robots.txt' });
if (!outcome.applied) {
  await stacki.ui.notify({ message: outcome.reason, kind: 'error' });
}
```

```ts
interface AppFileEntry { path: string; kind: 'file' | 'directory'; sizeBytes: number }
interface AppFileContent { path: string; encoding: 'utf8' | 'base64'; content: string; sizeBytes: number }
type AppFileOutcome = { applied: true; paths: string[] } | { applied: false; reason: string };
```

- **Paths** are relative to the project and use `/`. Refused, as named and again once symbolic links
  resolve: absolute paths, `..`, anything under `.git/` or `node_modules/`, `.env` files (use
  [settings](#app-settings) for secrets), `.stacki/apps/` except the app's own folder
  `.stacki/apps/<id>/`, and other apps' stored data in `.stacki/app-data/` (use
  [storage](#storage)). A listing leaves refused entries and links out.
- **Text or binary.** `files.read` answers UTF-8 text when the file is valid text, else `base64`;
  `files.write` takes either.
- **Bounds.** One file is at most 5 MiB; a listing answers at most 1000 entries (`truncated` says
  more were there); an app changes at most 120 files and 32 MiB a minute, after which a change
  answers `applied: false` until the minute passes.
- **Roles.** Files are raw code: every `files.*` call needs a role with `code:edit` and answers
  `role-denied` otherwise.
- **The editor's own save path.** A change goes through the same path as the editor's saves, so open
  editors and the canvas reload what changed, and `project.change` fires with `source: 'files'`, the
  `paths` and `origin: 'self'` for the app that made it.
- **Undo.** On Stacki Desktop each change is one undo step named by its `label` (or "<App>: write
  <path>"), and ⌘Z puts the files back as they were. A change whose files together hold more than
  about 3 MiB is made without a step, and Stacki says so. Stacki Studio keeps no step for a file
  change: its history is the shared document's.

## External services

**Declare every host in `network`.** An app calls external services from its own frame, with `fetch`
or `WebSocket`, and the manifest lists each one with why:

```json
"network": [
  { "host": "api.example.com", "purpose": "Read your site's analytics" }
]
```

The frame's content security policy allows connections (`fetch`, `WebSocket`, frames and form posts)
to the declared hosts over HTTPS and WSS, and to the token endpoints of the app's `auth` providers,
and to nothing else, so the list is the whole truth: a call to an undeclared host fails. The install
confirmation, the app's details and the marketplace rows show it to the person before and after they
install: "Uses external services: api.example.com (Read your site's analytics)", or "Works fully
offline" when the list is empty. The marketplace's review copies the list into the index entry's
`network` field.

**Vendor every library.** Scripts, stylesheets and fonts load from the bundle only; the bundle check
refuses remote code ([Bundle format](#bundle-format)). Images and media may still load from any
HTTPS address: they run no code, and an app shows the project's own images wherever they are hosted.

Requests carry the opaque origin `null`, so the service must allow cross-origin requests; for one
that does not, use [`stacki.net.fetch`](#calling-services-from-stacki), to the same declared hosts. Stacki
never hands an app its own sign-ins: an app asks the person for theirs, as a [secret
setting](#secrets) or a [sign-in](#signing-in).

**Breaking change.** Apps used to connect to, and load code from, any HTTPS address. An app that
calls a service it does not declare, or loads a library, stylesheet or font from a CDN, now fails:
declare the hosts in `network` and vendor the files.

## Connections

**Don't host your own backend for auth.** An app that routes sign-ins through its author's server (a
Cloudflare Worker, a serverless function, any self-hosted auth proxy) makes every installer depend
on that server and trust it with their tokens. Stacki signs in for the app instead.

For Google and HubSpot, Stacki has registered OAuth apps of its own. Name one in the manifest and the
installer clicks **Connect**: they never create an OAuth client or paste a key.

```json
"auth": [
  { "provider": "google", "scopes": ["openid", "email", "<the Analytics read-only scope>"] }
]
```

| Field | Meaning |
|---|---|
| `provider` | `"google"` or `"hubspot"`. Stacki supplies the endpoints; leave out `authorizeURL` and `tokenURL`. |
| `scopes` | A subset of what Stacki's app for that provider may ask for; any other scope is refused at install. |
| `label` | Optional: what the button names, "Connect <label>"; the provider's name by default. |
| `id` | Optional: the id calls use (`auth.token({ provider })`); the provider's name by default. |
| `clientIdSetting`, `clientSecretSetting` | Optional: the [advanced fallback](#the-advanced-fallback-your-own-client) to the installer's own client. |

The scopes each connection offers:

- **Google**: `openid`, `email`, `profile`, and Google's Analytics read-only and Search Console
  read-only scopes, each written as Google's full scope address.
- **HubSpot**: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`,
  `crm.objects.companies.read`, `crm.objects.deals.read`, `forms`, `content` and
  `scheduler.meetings.meeting-link.read` (meeting links).

Declare the API hosts the app calls in `network`, as for any service ([External
services](#external-services)).

### How a connection works

The Stacki broker, a small service on Stacki's own site, holds each provider's client secret and a
fixed redirect address registered with the provider. It keeps nothing: no code, no token, no record
of a sign-in.

1. The editor makes a PKCE verifier and keeps it. It sends the broker the challenge, its own random
   `state`, the scopes and its return address: its loopback listener on Desktop (as for any sign-in,
   below), or a local Studio's callback route.
2. The broker checks the scopes against its allowlist and the return address against the loopback
   address, signs all of it into a short-lived handoff, and sends the browser to the provider with
   the handoff as the provider's `state`.
3. The provider returns to the broker's fixed redirect. The broker checks the handoff's signature and
   sends the browser on to the editor's return address with the code, the editor's state and the
   handoff. The editor refuses a state that is not its own.
4. The editor posts the code, the handoff and its verifier to the broker, which exchanges the code
   with the client secret only when the verifier matches the challenge it signed. A code seen in
   transit is useless without the verifier, which never leaves the editor except to the broker over
   TLS.
5. The tokens go back to the editor, which seals them locally, in the same vault as secret settings.
   A refresh goes through the broker too, statelessly: the editor sends its refresh token, and the
   broker adds the secret.

Before the browser opens, the editor asks the broker whether the provider is set up (its `status`
route, answered at most once a minute). When the broker is unreachable or the provider is not set
up, `auth.connect` and `auth.status` answer at once with `{ connected: false, code: 'unconfigured',
message }` for that provider, instead of opening a page that cannot finish. The Connections section
shows the message. An app should show it too, and offer to try again later.

Why a loopback return, rather than a custom URL scheme or the broker holding the result for the
editor to collect: another program on the computer can register a URL scheme and take the code, and
holding results would make the broker store sign-ins. The fixed redirect also suits HubSpot, which
cannot register a loopback address on a random port.

### The advanced fallback: your own client

A connection may also name `clientIdSetting` (and `clientSecretSetting`) with [settings](#app-settings).
They stay out of the way: the **Connections** section of the app's details offers them under
**Advanced: use your own OAuth client**. When the installer fills in the client id, Stacki signs in
with their client straight through the loopback redirect instead of the broker; clearing it goes back
to Stacki's connection. This works only with providers that accept loopback redirects on any port,
such as Google's desktop clients. HubSpot registers exact redirect URLs only, so it cannot: a HubSpot
connection that names `clientIdSetting` is refused at install, and every HubSpot app signs in through
the broker's fixed redirect. (A fixed loopback port of the installer's choosing was considered and
left out: a port any program on the computer could listen on first is a worse place to receive a
code than a random one, and HubSpot takes no PKCE to make an intercepted code useless.)

### Custom providers

For a service Stacki has no connection for, an app names the provider's own endpoints, and each
installer signs in with their own OAuth client:

| Provider field | Meaning |
|---|---|
| `id` | `^[a-z][a-z0-9_-]*$`, up to 32 characters. |
| `label` | The service's name, as the button says it: "Connect <label>". |
| `authorizeURL`, `tokenURL` | The provider's endpoints, `https://` only. |
| `scopes` | Up to 32 scopes, joined with spaces in the request. |
| `pkce` | Must be `true`. |
| `clientIdSetting` | Required: the id of a `text` or `secret` setting holding the installer's client id. |
| `clientSecretSetting` | The id of a `secret` setting holding the client secret, for a provider that requires one. |
| `authorizeParams` | Up to 8 extra authorize parameters, such as `{ "access_type": "offline", "prompt": "consent" }` for a refresh token. Stacki sets `client_id`, `redirect_uri`, `response_type`, `scope`, `state` and the PKCE parameters itself. |

## Signing in

`stacki.auth.connect({ provider })`, or **Connect <label>** in the app's details under
**Connections**, signs this person in, through a [connection](#connections) or a custom provider:

1. Stacki uses PKCE (S256) and a random `state`, and refuses a callback whose state does not match.
   One sign-in per app waits at a time, for at most five minutes.
   - **Stacki Desktop** opens the system browser and listens for the callback at `/callback` on the
     loopback address `127.0.0.1`, over plain HTTP on a random port, for that one sign-in only
     (RFC 8252).
   - **Stacki Studio** uses its own callback route, `/studio/api/apps/oauth/callback`. A hosted Studio
     does not keep sign-ins yet and says so, as it does for secret settings.
2. Stacki exchanges the code itself (Desktop's main process or the Studio server, through the broker
   for a connection), and seals the tokens in the same vault as secret settings, per project and
   app, never in `.stacki/`.
3. `stacki.auth.token({ provider })` gives the app a short-lived access token only, refreshed by
   Stacki when it is about to lapse. The refresh token and any client secret never reach the app.
   Better still, let `stacki.net.fetch` attach the token, and the app never handles it ([Calling
   services from Stacki](#calling-services-from-stacki)).

```ts
type AppAuthStatus =
  | { provider: string; connected: false }
  // A Stacki connection that cannot sign in now: its broker is unreachable or not set up (see Connections).
  | { provider: string; connected: false; code: 'unconfigured'; message: string }
  | { provider: string; connected: true; account: string | undefined; expiresAtMs: number | undefined };
interface AppAccessToken { accessToken: string; tokenType: string; expiresAtMs: number | undefined }
```

`account` is the email or name the sign-in reported, when it reported one. Removing an app forgets
its sign-ins; **Disconnect** forgets one.

## Calling services from Stacki

`stacki.net.fetch` makes a request for the app from Desktop's main process or the Studio server.
Use it for a service that sends no CORS headers (HubSpot's API, for one), which an app frame's own
`fetch` can never read, and to call an API with a sign-in without the app ever holding the token:

```js
const reply = await stacki.net.fetch({
  url: 'https://<the API host>/v1/things',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ limit: 10 }),
  auth: 'hubspot',
});
if (reply.status === 200) {
  const things = JSON.parse(reply.body);
}
```

```ts
interface AppNetRequest {
  url: string;                       // https only
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';  // GET by default
  headers?: Record<string, string>;
  body?: string;                     // not for GET or HEAD
  encoding?: 'utf8' | 'base64';      // the body's; utf8 by default
  auth?: string;                     // a provider id: Stacki adds `Authorization: Bearer <its access token>`
}
interface AppNetResponse { status: number; url: string; headers: Record<string, string>; body: string; encoding: 'utf8' | 'base64' }
```

- **Hosts.** Only the hosts the manifest declares in `network`, and its providers' token hosts. A
  redirect is followed only to one of them, at most 3 times; the authorization is dropped when the
  host changes.
- **Bounds.** The body is at most 5 MiB each way; a request takes at most 30 seconds, redirects
  included; an app makes at most 120 requests a minute; at most 32 headers.
- **Headers.** Cookies are stripped both ways: none are sent, and `set-cookie` is never passed on.
  An app cannot send `cookie`, `host`, `origin`, `referer`, `content-length`, the connection and
  transfer headers, or `proxy-*` and `sec-*` headers, nor `authorization` together with `auth`.
- **Answer.** The final URL after redirects, lowercase headers, and the body as text, or `base64`
  when it is not text. A status the service answers (a 404 included) is an answer, not an error.

### Example: Google Analytics

The manifest names Stacki's Google connection, a setting for the GA4 property and the Analytics Data
API's host (the placeholders stand for Google's scope address and the API's host):

```json
"settings": [
  { "id": "property", "label": "GA4 property id", "kind": "text", "required": true, "placeholder": "123456789" }
],
"auth": [
  { "provider": "google", "label": "Google Analytics", "scopes": ["openid", "email", "<the Analytics read-only scope>"] }
],
"network": [
  { "host": "<the Analytics Data API host>", "purpose": "Read GA4 reports" }
]
```

```js
const DATA_API = 'https://<the Analytics Data API host>';

async function runReport(body) {
  const { property } = await stacki.settings.get();
  const reply = await stacki.net.fetch({
    url: `${DATA_API}/v1beta/properties/${property}:runReport`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    auth: 'google',
  });
  if (reply.status !== 200) {
    throw new Error(`runReport answered ${reply.status}`);
  }
  return JSON.parse(reply.body);
}

const [status] = await stacki.auth.status();
if (!status?.connected) {
  await stacki.auth.connect({ provider: 'google' });
}
const report = await runReport({
  dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
  dimensions: [{ name: 'pagePath' }],
  metrics: [{ name: 'screenPageViews' }],
});
```

An installer who would rather use their own Google client fills it in under **Advanced** when the
manifest also names `clientIdSetting` and `clientSecretSetting` ([the advanced
fallback](#the-advanced-fallback-your-own-client)).

### HubSpot

Name `{ "provider": "hubspot", "scopes": [...] }`: Stacki's broker holds HubSpot's client secret, so
the installer needs none. A HubSpot connection cannot use the installer's own client: HubSpot accepts
exact redirect URLs only, which Stacki's random-port loopback is not. HubSpot's API sends no CORS headers, so call it with `stacki.net.fetch` and
`auth: 'hubspot'`, and declare its API host in `network`.

## Roles

Projects can define roles (Settings, Roles). An app is visible and usable for a role only when the
role has the Apps panel (`panel:apps`) and the app (`app:<id>`, or `app:*` for every app). Admins
always can. A role that cannot see a panel cannot have an app open it either, and a role without the
Pages panel (`panel:pages`) cannot have an app read pages other than the open one
([Reading other pages](#reading-other-pages)).

```js
const role = await stacki.role.get();
render(role);
stacki.on('role.change', render);
function render(role) {
  document.body.classList.toggle('read-only', !role.isAdmin);
}
```

Only an admin can install, update or remove apps, and switch an app's **Update automatically**. Two more
features cover the official marketplace: `marketplace:view` shows the Apps panel's **Marketplace**
tab and marketplace results in the command palette, and `marketplace:install` lets the role install
an approved app from it. Each needs `panel:apps`, and installing needs `marketplace:view` too. Admin
has both; the built-in Client role has neither, and a roles file written before the marketplace
existed grants neither until an admin turns them on (Settings, Roles, the **Apps** group).

Two features cover offering apps to others. `apps:share` lets a role put an app installed from a file
or added to the project folder on GitHub ([Sharing an app privately with your org](#sharing-an-app-privately-with-your-org)) and
switch it to that release; it needs `panel:apps`. `marketplace:publish` lets a role make a repository
public, add its MIT license and submit it ([Publishing to the marketplace](#publishing-to-the-marketplace));
it needs `panel:apps` and `marketplace:view`. Admin has both; the built-in Client role has neither.
Filling in an app's own [settings](#app-settings) needs only the app.

## Permissions

An app can declare its own switches for admins to set per role, for actions inside the app that not
everyone should take. Declare them in the manifest's `permissions`; Stacki shows each app that
declares any as its own group under **Apps** in Settings, Roles: the app's icon and name, an **All**
switch, and one switch per permission with its label and description.

```json
{
  "manifestVersion": 1,
  "id": "feedback-pins",
  "name": "Feedback pins",
  "version": "1.2.0",
  "entry": "index.html",
  "permissions": [
    { "id": "resolve-threads", "label": "Resolve threads", "description": "Mark a pin's thread as resolved.", "default": true },
    { "id": "delete-any-comment", "label": "Delete anyone's comments", "description": "Without it, people delete only their own.", "default": false }
  ]
}
```

How a permission resolves for the person using the app:

- **Admin** has every permission, always.
- **A role that cannot use the app** (no `panel:apps`, or no `app:<id>` / `app:*`) has none; its
  switches are disabled in Settings, Roles until the app is allowed. Such a role cannot call the
  app's methods anyway (`role-denied`).
- **Any other role** has the value an admin set for it, else the permission's `default`.

Values are stored per role in `.stacki/roles.json` (`appPermissions`). Values for an app that is
uninstalled, or for a permission a newer version dropped, are kept and ignored, so reinstalling
restores them.

```js
const { permissions } = await stacki.role.get();          // { 'resolve-threads': true, 'delete-any-comment': false }
resolveButton.hidden = !permissions['resolve-threads'];
stacki.on('role.change', (role) => render(role.permissions)); // fires when an admin changes them, or the role changes

if (await stacki.role.can({ permission: 'delete-any-comment' })) {
  await deleteComment(comment);
}
```

**Stacki enforces only its own access.** App permissions are honest signals: Stacki stores them,
resolves them for the current person and tells the app, but never checks them on the app's behalf.
The app must respect them in its own features: hide or disable what a permission withholds, and
check again before acting. A Stacki API an app calls (`files.write`, `node.setAttribute`, …) is
gated only by Stacki's own features (such as `code:edit` or `panel:pages`), never by an app
permission, so an app that acts on behalf of a permission must check it before it calls.

## The sandbox

- The frame is `sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"`,
  without `allow-same-origin`: the app's origin is opaque, so its code cannot reach Stacki's own
  window, storage or sign-ins, and a mistake in an app cannot corrupt Stacki. `localStorage` and
  cookies are not available; keep state with `stacki.storage` ("Storage").
- An app reads its own bundle files with `fetch`: `await (await fetch('config.json')).json()`. The
  frame's origin is opaque, so the request is cross-origin; Stacki serves bundle files (they are the
  app's public code) with `Access-Control-Allow-Origin: *` from `stacki-app://<id>/` on Desktop and
  from Studio's app file route alike. A `<script src>` works too.
- Every app document is served with a content security policy whose `sandbox` directive keeps it
  opaque even when opened on its own. Inline scripts and styles and WebAssembly are allowed; scripts,
  styles and fonts load from the bundle only, and connections go only to the hosts the manifest
  declares ([External services](#external-services)).
- An app frame cannot navigate away from its own app; links to the web open in the browser.
  `allow-popups` is there so `window.open` and `target="_blank"` links work: Stacki Desktop routes
  every popup to the system browser, and Stacki Studio opens it in a new browser tab.
- Messages are validated and bounded, and at most 32 requests may wait at once.
- The frame cannot write to the clipboard itself: copy with `stacki.clipboard.write({ text })`, which
  Stacki performs for the app (up to 262,144 characters). Use it for every Copy button.

## Installing an app

In the Apps panel (rail key **E**), an admin adds an app from the header's **+** menu:

- **Load App From GitHub**: one field searches the GitHub account you signed
  in with for publishing (yours and your organizations'; the account chip at the field's left
  switches accounts) and also takes a pasted repository: `owner/repo`, `github.com/owner/repo` or
  a full github.com address, offered as **Use owner/repo** for any repository. Only
  repositories with the `stacki-app` topic are listed, under **Stacki apps**, and typing searches
  only those. Choose a repository with the arrows and Enter or a click, then
  a release (newest first; pre-releases are marked), then the app bundle (the one `.zip` is picked
  for you). Stacki checks the bundle and its `stacki-app.json` and shows its icon, name and version;
  **Install** installs it. Stacki Studio has no GitHub sign-in, so there you paste a public
  repository.
- **Build an app**: opens the AI chat with the app builder instructions as a purple chip in the message box, waiting for you to add your words and send (Stacki never sends it for you); click the chip to copy the instructions, for an agent outside the project. They are a short prompt that links to this guide, bundled in Stacki rather than in your project. The chip goes to the end of a message you were typing, or into an empty chat or a new one, so what you typed is never replaced. A role without the AI chat gets the prompt on the clipboard instead, with a notice saying so. This is the one item a role that cannot install gets.

An app file (a `.zip`) is no longer chosen from disk: publish it to a GitHub release and use **Load App From GitHub**, or write the app straight to `.stacki/apps/<id>/` to test it. Apps already installed from a file keep working, with their details, Share to GitHub and updates.

The search field above the list (**Search installed apps**) filters the installed apps by name,
description and id; browsing the marketplace is the panel's **Marketplace** tab.

Each installed app's row has **Open** and a **⋯** menu, in this order, each where it applies:

- **Details**: the app's details popup (a click on the row opens it too).
- **Share to GitHub…**: for an app uploaded from a file or added to the project folder that is not
  on GitHub yet, with `apps:share` ([Sharing an app privately with your org](#sharing-an-app-privately-with-your-org)).
- **Submit to marketplace**: with `marketplace:publish`. An app from GitHub opens **Publish to
  marketplace** at its own repository; an uploaded or folder app goes through Share to GitHub first
  (so it needs `apps:share` too), unless it is [already shared](#apps-already-shared). **An app the
  marketplace already lists has no Submit item at all**, whatever its source: the marketplace follows
  its repository's GitHub releases, so a new version is a new release there, never a submission. Its
  details show a quiet **Listed in the marketplace** row with the listed latest version and a link to
  the repository.
- **Remove app**: admins; it asks first, as **Uninstall app** in the details does.

An app's details popup has the app's icon and name at the top, with one line under the name: the
version, the author when the app names one, and its GitHub repository when it has one; then **Open**
and the same **⋯** menu. Below come short sections, built to be scanned: the description (three
lines, then **More**) and a few one-line facts (**Installed from**, **Stored in**, **Network**: "Works
offline" or how many services it reaches); **External services**, one line per host, when it reaches
any; the [secret scan](#secret-scanning) of an app added to the project folder; **App settings**;
**Connections**; **Commands**, one line per command with its shortcut field; **Updates** (an
available update with **Update**, and the **Update automatically** switch); a listed app's **About** also
has a **Listed in the marketplace** row; and, for admins, **Uninstall app** at the foot, which
asks first. Longer explanations sit behind a **?** beside a label. A section with nothing to show for
the app is left out. Escape or a click outside closes it.

Installed apps live in the project, in `.stacki/apps/<id>/`, with the lockfile
`.stacki/apps/apps.json` recording each app's version, source, release tag and the SHA-256 of what
was installed. Commit `.stacki/apps/` so everyone working on the project, in Desktop or Studio, has
the same apps.

### Apps added as a folder

The folder is what is installed. Any folder in `.stacki/apps/<id>/` holding a valid bundle (a
`stacki-app.json` whose `id` is the folder's name, and the files it names) is an installed app the
moment it is there, whether Stacki wrote it or you did: copied in by hand, written by an AI agent
building the app, brought by a `git pull`, or copied from another project. It is listed in the
Installed list with every other app and opens at once.

- **Source.** An app the lockfile names keeps its record: where it came from, its update-automatically
  switch and its SHA-256. A folder the lockfile does not name is listed with the source
  **Added to the project folder** (`"kind": "local"`), the SHA-256 of its files, and no updates.
  Stacki writes nothing for it: listing never changes the lockfile, so a pull or a copy never
  leaves it dirty. Its details show what it declares under **External services** and a
  [secret scan](#secret-scanning) of its files as one status line (the findings expand from it),
  as information, since no install step checked them.
- **Removed folders.** A lockfile entry whose folder is gone is not listed, and is dropped the next
  time Stacki writes the lockfile. **Uninstall** on a folder app removes its folder.
- **Broken folders.** A folder whose `stacki-app.json` is missing or invalid, whose `id` does not
  match the folder's name, or whose files break a [bundle rule](#bundle-format) is shown in the same
  list as a broken row with the reason, and in Desktop a **Show in Finder** button. It never runs.
- **Not apps.** Dotfiles (`.DS_Store`), the lockfile, `settings.json` and other plain files in
  `.stacki/apps/` are skipped; project storage lives in `.stacki/app-data/`, outside it.
- **Live.** Desktop watches `.stacki/apps/` and Studio checks it every second, so a new, removed or
  edited folder shows within about a second, with its manifest's current version. A running app
  acts only once its folder has been quiet for half a second, so an agent writing it file by file
  never closes it: a valid folder reloads the app in place, once, in the same window, mode and panel
  (a version bump included); a broken one keeps the last working version running, with the reason
  in a small notice in the app's window until the folder is valid again. Only a deleted folder
  closes the app.

## Updates

Stacki checks GitHub apps for a newer release when a project opens and every six hours after. A
newer version shows **Update available** in the Apps panel; **Update** installs exactly the bytes
that were checked (by SHA-256), and a release replaced in the meantime is checked again. Downloads
come only from GitHub, are bounded by the release's stated size and 10 MiB, and must match the
SHA-256 digest GitHub publishes for the asset. A private repository is read with the account that
connected it. A marketplace app is checked against the marketplace index instead: its update is the
newest version the Stacki owner approved.

### Update policy

An app is third-party code, so **nothing installs new code unless a person chose it**: an admin's
**Install** or **Update**, a role with `marketplace:install` installing from the marketplace, or that
app's **Update automatically** switch, which an admin turned on.

- **Update automatically is off for every app**, marketplace apps included, until an admin turns it on
  in the app's details (**Updates**: "Install new versions of this app as they are released. Only turn
  this on for a publisher you trust."). The switch is stored per app in the lockfile
  (`"autoUpdate": true`); a lockfile without it reads as off. An uploaded app, or one added to the
  project folder, is your own and has no source to update from, so it has no switch and never offers
  Update.
- **You see a new version.** The check runs when a project opens and every few minutes after, for GitHub
  and marketplace installs alike. A newer version reads **Update available · v1.2.0** on the app's row
  and in its details, with a dot on the rail's Apps button (for admins, who can act on it). A new
  version of a listed app needs no submission: a GitHub app's check reads the repository's latest
  release, and a marketplace app's reads the index's newest approved version, whose download must match
  the approved SHA-256.
- **Update** (the Refresh button on the row, and in the details) installs that version into
  `.stacki/apps/<id>/`, updates the lockfile and says so, or shows why it could not. A marketplace
  update is checked against the index again first: a version whose approval was withdrawn since
  installs nothing.
- **On**: the check installs the update itself and says so. A marketplace app installs only a version
  the index approves, and only when the download's SHA-256 equals the approved one; a newer release that
  is not approved yet is never installed. A GitHub-release app installs the newest release, recording
  the SHA-256 of the bytes the check downloaded and installed.
- **A version that asks for more is never installed silently.** Each check compares the new manifest
  with the installed one: external hosts in `network`, `auth` providers (or a changed provider
  endpoint) and role `permissions` it did not have before. If there are any, auto-update installs
  nothing: the lockfile records the update with those lines (`update.additions`), the row reads
  **Update needs your OK · v1.2.0**, the details list what is new ("New in v1.2.0: reaches
  api.example.com."), and only an admin's **Update** installs it. With auto-update off the same lines
  show on the available update, so the choice is informed. Asking for less, or the same, is an
  ordinary update. A held update is not downloaded again on later checks.
- Update only appears for an app from GitHub or the marketplace; an app you added from a file or the
  project folder never offers it.

## The marketplace

The Stacki marketplace lists community apps. **Every marketplace app is open source under the MIT
license, and Stacki does not review, vet or take responsibility for them**: install apps you trust.
The Marketplace tab says so in one muted line at its top, and so does the confirmation before an
install. In the Apps panel, a role with `marketplace:view` switches between **Installed** and
**Marketplace**. Each app shows its icon, name, author's picture, description and an **MIT** pill;
apps already in the project are marked **Installed**. **Install** asks first, then downloads the
newest listed version from the app's GitHub release and installs it only if its SHA-256 matches the
index, recording `source: { "kind": "marketplace", "id", "version" }` in the lockfile. In the command
palette's Apps tab, a search also lists matching marketplace apps under **Marketplace**; choosing one
opens it in the Marketplace tab.

The index is one JSON file that the marketplace's Worker on stacki.build serves
(`/api/marketplace/index.json`). Each entry may carry `"license": "MIT"`, the only value accepted; an
entry with any other license is refused, and so is the whole index. To list your app, use **Submit
an app** in the Apps panel's **+** menu ([Publishing to the marketplace](#publishing-to-the-marketplace)),
or the web form at stacki.build/marketplace/submit. The id, name, description and icon come from the
release's `stacki-app.json`, and an app without an `icon` is refused. See
[the marketplace guide](marketplace.md). When the index cannot be read (the site is down, there is no
network, or the reply is not a valid index) the Marketplace tab says it isn't available right now,
with **Retry**; installed apps keep working.

## App settings

An app that needs something from each person who installs it, such as their own API key, declares it
in the manifest instead of shipping it:

```json
"settings": [
  { "id": "api-key", "label": "API key", "description": "From your account page.", "kind": "secret", "required": true, "placeholder": "sk-your-key" },
  { "id": "endpoint", "label": "Endpoint", "kind": "url" }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `^[a-z][a-z0-9_-]*$`, at most 64 characters, unique in the app. |
| `label` | yes | 1 to 60 characters. |
| `description` | no | Up to 280 characters, shown under the field. |
| `kind` | yes | `text`, `secret` or `url` (an `http:` or `https:` address). |
| `required` | no | `true` holds the app back until it has a value. |
| `placeholder` | no | Up to 120 characters of example text in the empty field. The secret scan ignores it. |
| `advanced` | no | `true` shows the setting under a collapsed **Advanced** disclosure at the end of the app's App settings. |

An app declares at most 16 settings. Each person fills them in from the app's details in the Apps
panel, under **App settings**: proper fields, a secret masked with a show and hide toggle, and
**Save settings**. The app reads them with `stacki.settings.get()`:

```js
const settings = await stacki.settings.get();
const reply = await fetch(itemsURL, { headers: { Authorization: `Bearer ${settings['api-key']}` } });
```

**Where values live.** `text` and `url` values are shared with the project in
`.stacki/apps/settings.json`, so collaborators see the same endpoint. A `secret` value **never goes
in `.stacki/`**, which is committed to git. Stacki Desktop seals it with the operating system's
keychain (Electron's `safeStorage`) in its own user data folder, one file per project, keyed by the
project's path and the app id; it stays on that computer, so each person fills in their own. A local
Stacki Studio seals it with AES-256-GCM in the user's home folder (`~/.stacki/studio-app-secrets/`),
beside the media connections Studio already keeps there. A hosted Studio does not keep secret
settings yet and says so; text and URL settings still save. Removing an app forgets its settings.

Use `advanced` for settings most people never change; if an advanced setting is `required` and still
empty, the disclosure opens by itself so it is never hidden.

**Opening the settings from the app.** `stacki.app.openSettings()` opens the app's details at its App
settings section, over the app, wherever it runs: give the app a settings button rather than telling
people where to look. A role that cannot see the Apps panel is refused (`role-denied`). When the
person saves, the app hears `settings.change` with the ids that changed, so it can read them again:

```js
stacki.on('settings.change', async ({ ids }) => {
  if (ids.includes('api-key')) {
    settings = await stacki.settings.get();
    await reconnect();
  }
});
```

**A required setting that is missing** shows **Set up <App>** with the fields in the app's place,
instead of loading it. Once every required setting is saved, the app loads. This is one behaviour for
every app, rather than an event each app would handle its own way: an app that is running can rely on
`stacki.settings.get()` holding every required value.

## Secrets

An app's API key or token is a **`secret` setting**, not a separate mechanism: declare it in the
manifest's `settings` with `"kind": "secret"` and read it with `stacki.settings.get()` ("App
settings"). Each person fills it in from the app's details; it is sealed outside the project and
never committed, never shipped in the bundle, and never in an export or a share. A required secret
holds the app at **Set up <App>** until it is filled in, so a running app can rely on it. Never put a
key in the bundle or in `stacki.storage`: project storage is committed with the site.

## Storage

An app keeps what it needs between runs with `stacki.storage`: strings by key, in two scopes.

```js
const pins = JSON.parse((await stacki.storage.get({ key: 'pins/home' })).value ?? '[]');
pins.push({ id: crypto.randomUUID(), text: 'Bigger heading?', by: (await stacki.person.get()).id });
const saved = await stacki.storage.set({ key: 'pins/home', value: JSON.stringify(pins) });
if (!saved.applied) show(saved.reason);
stacki.on('storage.change', ({ key, origin }) => { if (origin === 'other') reload(key); });
```

| Scope | Where | Shared |
|---|---|---|
| `project` (the default) | `.stacki/app-data/<id>.json` in the project | With everyone, through Git: it commits, merges and pulls with the site |
| `local` | The editor's own storage: Desktop's user data folder; a Studio's home folder (`~/.stacki/studio-app-storage/`), per person | Never: this person, on this computer |

Project values sit beside the bundles, not in `.stacki/apps/<id>/`: that folder is replaced whole by
every update and read whole by a share, so data there would be lost or published. The file keeps one
key per line in sorted order, so two people changing different keys merge cleanly.

- **Keys** are named like paths: segments of letters, digits, `.`, `_` and `-` joined by `/`
  (`pins/home`), at most 128 characters and 8 segments; no segment starts with `.`.
- **Bounds:** a value is at most 256 KiB (UTF-8), and one app keeps at most 4 MiB and 1,000 keys per
  scope. A write past a bound answers `applied: false` with the bound it hit; a key or value that
  breaks the rules is `bad-params`.
- **Writes are atomic:** the file is written beside the old one and renamed over it, so a crash leaves
  the old values or the new ones. Each write is saved before the promise resolves.
- **Changes:** `storage.change` reaches only the app whose value changed, with `origin: 'self'` for
  this editor window's own write and `other` for anything else. Stacki watches the project's data
  folder, so a `git pull` or a teammate's edit arrives as `other`; a teammate in the same Studio
  hears it at once. Local values are heard in the editor that wrote them.
- **Removing an app** removes its project file and this person's local values. A hosted Studio's
  disk does not outlive a deployment, so its local values last until the next one.

## The person

`stacki.person.get()` says who is using the editor, so an app can sign a comment or show "mine":

```ts
interface AppPerson {
  id: string;                  // stable for this person in this project, the same from every app
  name: string | undefined;    // Git's user.name for the project
  email: string | undefined;   // Git's user.email for the project
  github: string | undefined;  // the GitHub account signed in for publishing (Studio: the session's account)
}
```

**What an app can see.** The name and email are the Git identity already written into every commit
the person makes; the GitHub account is the one Stacki publishes with. A hosted Studio knows only the
session's GitHub account (its own Git identity belongs to the deployment). The `id` is a hash of the
project (its `origin` remote, so every clone agrees) and the person (their GitHub account, else
their Git email, else a key for this computer): an app can group a person's work without knowing who
they are.

**Hiding it.** A person can turn on **Hide my details from apps** (Desktop: Settings, Privacy; Studio:
the account menu). Apps then get the `id` only; `name`, `email` and `github` are undefined, and the id
does not change. Running apps hear `person.change` when the setting flips.

**Other people.** `stacki.people.list()` answers the people an app may mention (an @-mention, an
assignee), at most 200:

```ts
interface AppMember {
  login: string | undefined;     // a GitHub login
  name: string | undefined;      // Git's name, for a commit author
  email: string | undefined;     // Git's email, for a commit author
  avatarURL: string | undefined; // the login's GitHub picture
}
```

Role members (the GitHub logins in `.stacki/roles.json`) come first, then the authors of the
project's recent commits, each person once: an author whose email is a member's GitHub noreply
address is that member. Each entry tells no more than `person.get` would tell of that person: a
member's login and picture, an author's Git name and email, as every commit already records them.
While the person using the editor hides their details from apps, the list holds logins and pictures
only, and authors known by name and email alone are left out.

## Desktop and Studio

`app.info()` says which editor the app runs in (`host`) and what it can do there (`can`), so an app can
grey out a button or pick its store at startup instead of finding out by failing:

```js
const { host, can } = await stacki.app.info();
attributeStore.hidden = !can.setAttribute;
```

Each flag is read from the same place that answers a method `applied: false`, so `can` and the answer
never disagree. Today Stacki Desktop can do everything. Stacki Studio cannot yet write attributes,
classes or inline styles, insert a plain element, open the insert palette or set the canvas width
(`canvas.setWidth` fails with the reason, as it answers a viewport); undo, redo, save, scrolling to
an element or a point, opening pages and components, inserting a component, removing and duplicating
work as on Desktop. `canvas.snapshot` is Desktop only.

## Undo labels

Every edit (`node.setAttribute`, `removeAttribute`, `addClass`, `removeClass`, `setStyle`, `insert`,
`remove`, `duplicate`) takes an optional `label`: one line, up to 60 characters. It names the undo
step the edit makes, so the app's work reads as its own when the person undoes or redoes it ("Undid
Pin feedback"), instead of as a generic attribute edit. An edit that folds into the step before it (a
burst of the same edit) keeps that step's name.

```js
await stacki.node.setAttribute({ nodeId, name: 'data-feedback', value, label: 'Pin feedback' });
```

## Rail badge

`stacki.app.badge({ count })` puts a count on the Apps rail button and on the app's row in the Apps
panel, so an app can say "4 open" while it is closed. The rail shows every app's counts summed (99+
past 99); `count: 0` clears it. A count is 0 to 9999, lasts while the project stays open in that
editor window, and goes when the app is removed.

## Secret scanning

Before an app leaves your computer, to the marketplace or to a private repository your organization
shares, Stacki scans its files for credentials. A key in an app is a key given to everyone who
installs it. The scan runs before **Share**, before **Make public** and before **Submit**, on the
app's files in `.stacki/apps/<id>/` for an uploaded app, or on the release zip for a repository; the
host scans again before acting, so the popup cannot be bypassed.

It looks, line by line, through every `html`, `js`, `mjs`, `css`, `json`, `map`, `txt`, `md`, `svg`
and `gltf` file for: `sk-` keys, Stripe `sk_live_`, `sk_test_` and `rk_` keys, GitHub tokens
(`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), AWS access keys (`AKIA` and 16 characters),
Google API keys (`AIza`), Slack tokens (`xoxb-` and the like) and webhooks, private key PEM blocks,
JSON Web Tokens, and long base64 or hex strings assigned to names like `key`, `token`, `secret`,
`password` or `auth`. Values that equal a setting's declared `placeholder` are not findings. The scan
reads at most 200 files and 20 MiB, and stops at 50 findings; past a bound it refuses rather than
passing. The marketplace's Worker runs the same patterns again at review.

Each finding shows its file, line and an excerpt with the match masked past its first four
characters, and blocks the next step. **There is no override.** Move the key into a `secret`
[setting](#app-settings), rebuild the app, then choose **I've removed it, rescan**.

A line that only looks like a key, such as a test fixture, can be listed in the manifest's
`secretsAllowlist`, where every reviewer sees it:

```json
"secretsAllowlist": [{ "file": "test/fixture.js", "lineSha256": "<SHA-256 of the line's exact text>" }]
```

`lineSha256` is the lowercase hex SHA-256 of the line's exact text, without its newline; the scan
report shows it under each finding. Changing the line ends the exception. At most 32 entries.

## Sharing an app privately with your org

An app you installed from a file, or added to the project folder, can be put on GitHub, so others
install it with **Load App From GitHub** and get its updates. Choose **Share to GitHub…** in the
app's **⋯** menu (needs `apps:share`).

- **Owner:** the account you publish with, or one of its organizations, from the chip.
- **Repository name:** the app id to start with; edit it freely. GitHub's rules apply: 1 to 100
  letters, digits, `.`, `-` and `_`, not `.` or `..`, not ending in `.git`.
- **Visibility:** **Private** is the default: people in the organization can install it with **Load
  App From GitHub**. **Public** lets anyone see and install it and adds an MIT `LICENSE`; it asks
  you to confirm before anything public is created.

The [secret scan](#secret-scanning) must be clean first, private sharing included: people in your
organization should not receive your personal keys either. Then Stacki, with your GitHub sign-in:

1. creates the repository with the chosen visibility,
2. adds the `stacki-app` topic,
3. commits the app's files (and the MIT `LICENSE` when public),
4. creates the release `v<version>` with the app's zip.

Each step shows its progress. If one fails, the popup says which, and lists exactly what had been
created, so you can finish or delete it on GitHub. When it is done, **Shared to owner/repo** offers
**Copy link** and **Invite people** (the repository's access settings on GitHub), and asks whether to
**install updates from this repository** (on by default): the app's lockfile source switches from the
uploaded file (or the project folder) to that release, update automatically off as always, so the project gets an update notice when
the repository publishes a new release. A public share also offers **Also submit to the marketplace**.
Sharing needs Stacki Desktop, which holds your GitHub sign-in.

## Apps already shared

An app installed from a file or added to the project folder can be a copy of an app that is already
on GitHub. Stacki treats it as **already shared** when the marketplace lists its `id` (the listing
names the repository, read from the index the Marketplace tab already caches, so there is no extra
request), or when its `stacki-app.json` names the repository it updates from in `source`. Such an app
has no **Share to GitHub…**. When it is not listed yet, its **⋯** menu offers **Submit to marketplace**,
which opens the same checklist as a GitHub app's, already on that repository; the first listing still
needs a submission and the owner's approval. When the marketplace lists it, its menu has no submit item
at all: the marketplace follows the repository's releases, and its details show a quiet **Listed in the
marketplace** row with the listed latest version and a link to the repository, beside the repository
under the version. A role that may publish needs `apps:share` only
for apps that are not on GitHub yet.

An `id` match never chooses the repository: a listed `id` always leads to the repository the
listing names, whatever the manifest says, and the marketplace itself refuses a different repository
under a listed `id`. A later version of a listed app is a new GitHub release of its repository; the marketplace picks it up
and lists it without a review when the release passes the checks of an approval ([the marketplace](marketplace.md)).

## Publishing to the marketplace

**Submit to marketplace** in an app's **⋯** menu (needs `marketplace:publish`) opens **Publish to
marketplace** at that app's repository; for an uploaded or folder app it leads into
[sharing](#sharing-an-app-privately-with-your-org) first. **Back** from the checklist shows the
popup's list, in two sections: **Your GitHub apps**, your `stacki-app` repositories with their Public
or Private pill (a pasted repository works too), and **Uploaded to this project**, apps installed
from a file or added to the project folder, which also lead into sharing first.

For a repository, a checklist must pass: the repository is public, carries the `stacki-app` topic,
has a release with the app's `.zip`, **uses the MIT license**, and its [secret scan](#secret-scanning)
is clean.

- **Private:** "This repository is private. The marketplace needs it public." **Make public** asks you
  to confirm, naming the repository and that all its code and history become public, then asks GitHub
  in one request. If your sign-in lacks the scope, you are not an admin of the repository, or the
  organization forbids public repositories, the popup says which and links to the repository's
  settings.
- **Not MIT:** "Marketplace apps must use the MIT license." When the repository has no license,
  **Add MIT license** commits a standard MIT `LICENSE` (this year, the owner's name or login) after
  you confirm. A repository under another license changes it on GitHub first.

When every check passes, the popup shows the repository and release, asks the marketplace whether it
would accept them ("Ready to submit: Heat map v1.2.0", or the marketplace's reason), and asks you to
tick: "I confirm this app is open source under the MIT license, I own the rights to publish it, and I
understand Stacki does not review, vet or take responsibility for marketplace apps." **Submit for
review** sends the release address and your acceptance, with your GitHub sign-in so the marketplace
knows who submits; the token is never stored. The result is **Submitted for review**, **Updated your
submission** for an app already pending or listed, the marketplace's own message when it refuses,
or, when the marketplace cannot take submissions yet, a state with **Open the web form**.

## Testing locally

The quickest loop: write the app straight to `.stacki/apps/<id>/` in a test project. It is
installed at once ([Apps added as a folder](#apps-added-as-a-folder)), and every save reloads it.
To test the zip a release would ship:

1. Write the app as a folder with `stacki-app.json` at its root.
2. Zip it from inside the folder: `cd my-app && zip -r ../my-app.zip .`
3. Attach the zip to a GitHub release of a test repository (`gh release create v0.0.1 my-app.zip`), open a test project in Stacki, press **E**, open the header's **+** menu, choose
   **Load App From GitHub**, then **Install**, then **Open**.
4. Change files, bump `version`, release again and update the app to replace it.
5. Use the developer tools on the app frame (in Desktop, View, Toggle Developer Tools) to see its
   console and messages.

## Publishing through GitHub releases

1. Put the app in a GitHub repository, with `source` in the manifest naming that repository and the
   asset file name.
2. Add the **`stacki-app`** topic to the repository, so **Load App From GitHub** lists it under
   **Stacki apps**: on the repository's GitHub page, click the gear beside **About**, type
   `stacki-app` under **Topics** and save, or run `gh repo edit --add-topic stacki-app`. Only
   tagged repositories are listed; any other can still be pasted. Either way, Stacki checks the
   release's bundle and its `stacki-app.json` before installing.
3. For each version: bump `version`, build the zip, and create a release whose asset has exactly
   that file name, for example with the GitHub CLI:
   `gh release create v1.2.0 heat-map.zip --title "Heat map 1.2.0"`.
4. Share `owner/repository`. Projects that connected the app see the update on their next check.

A minimal release workflow (`.github/workflows/release.yml`):

```yaml
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - run: cd app && zip -r ../heat-map.zip .
      - run: gh release create "$GITHUB_REF_NAME" heat-map.zip
        env:
          GH_TOKEN: ${{ github.token }}
```

## API versions

This guide is version 1 of the app API. Later versions add methods, events and fields without
removing these; the SDK sends its version with every request, and a Stacki that is older than the
app answers `unsupported-version`.
