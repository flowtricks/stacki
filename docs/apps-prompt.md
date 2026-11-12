You are building a Stacki app: a small web app that runs inside Stacki, a visual editor for Astro
sites. An app reads and changes the selection, edits pages, draws on the canvas and hears project
changes, through the same commands as Stacki's own panels. Ask me what the app should do if I have
not said.

**Build the UI with the Stacki UI kit**, Stacki's own components, so the app looks like part of Stacki: link `__stacki/ui.css` and load `__stacki/ui.js` after the SDK (Stacki serves both), use `<stacki-dropdown>`, `<stacki-switch>`, `<stacki-tabs>`, `<stacki-search>`, `<stacki-input>`, `<stacki-button>`, `<stacki-menu>`, `<stacki-popover>`, `<stacki-confirm>` and the `--stacki-*` tokens (a dropdown option's `icon: 'component'` or `icon: 'tag:<tag>'` draws Stacki's Navigator icon, and its `highlight` event gives the hovered or arrowed option's `event.detail.value` for a preview, `undefined` when it ends), and import no other UI framework ("Look and feel" in the guide). Never open the browser's own `alert`, `confirm` or `prompt` dialogs: ask with `await stackiConfirm({ title, message, confirmLabel, tone: 'danger', anchor })` from `ui.js`.

## Files

```text
my-app/
├── stacki-app.json
├── index.html
├── app.js
└── icon.svg   (optional: square PNG, SVG or WebP, at most 256 KiB)
```

`stacki-app.json`:

```json
{
  "manifestVersion": 1,
  "id": "my-app",
  "name": "My app",
  "version": "1.0.0",
  "entry": "index.html",
  "icon": "icon.svg",
  "author": { "github": "your-github-username" }
}
```

`id` is lowercase letters, digits, `.`, `_` and `-`. `icon` and `author` are optional. Add
`"window": { "mode": "popup", "width": 360, "height": 480 }` to open in a popup over the canvas
instead of the Apps panel; the user can dock or pop out either way.

## Talking to Stacki

`index.html` loads `<script src="stacki-sdk.js"></script>` (Stacki serves it), then your script.
The SDK defines `window.stacki`; every call returns a promise:

```js
const { nodeId } = await stacki.selection.get();           // undefined when nothing is selected
stacki.on('selection.change', ({ nodeId }) => show(nodeId));
if (nodeId !== undefined) {
  const node = await stacki.node.get({ nodeId });           // { id, kind, name, classes, attributes, text, children }
  await stacki.node.addClass({ nodeId, className: 'is-on' }); // one undo step, saved like a click
  await stacki.overlay.set({ items: [{ kind: 'box', id: 'a', anchor: { nodeId }, color: '#f97316', label: 'Here' }] });
}
await stacki.panels.open({ panel: 'assets' });
await stacki.ui.notify({ message: 'Done', kind: 'success' });
```

Namespaces: `canvas`, `panels`, `selection`, `page`, `node`, `history`, `overlay`, `ui`, `role`,
`app`, `events` (`subscribe` and `unsubscribe`, which `stacki.on` calls for you). Events:
`selection.change`, `hover.change`, `canvas.change`, `panels.change`, `page.change`,
`project.change`, `overlay.click`, `role.change`. Undo, redo and ⌘S pressed in the app reach
Stacki (text fields keep their own); commands go on ⌘⌥⇧1–9, and `stacki.overrides.register('assets.pick', …)`
replaces Stacki's image picker while the app runs. Copy with `stacki.clipboard.write({ text })`;
a settings button calls `stacki.app.openSettings()`; hand an overlay `frame` item its data with `stacki.overlay.post`, never storage. The app runs in a sandboxed frame: no
`localStorage`; popups open in the system browser.
**Local first.** Vendor every library into the bundle: a `<script src>`, `<link href>`, `import`
or CSS `@import`/`url()` of a remote address is refused at install. Declare every host the app
calls in the manifest's `"network": [{ "host", "purpose" }]`; the frame can reach no other.
**Never build an auth backend**: no Cloudflare Workers, serverless functions or other self-hosted
auth proxies. Prefer `"auth": [{ "provider": "google" | "hubspot", "scopes": [...] }]` (Stacki
connections: the installer just clicks Connect) and `stacki.auth.connect({ provider })`; use
`stacki.net.fetch({ url, auth: provider })` for APIs without CORS, so the app never holds the token.
`stacki.files.read/write/list/move/delete/mkdir` change project files (one undo step each).
Never put an API key in the app's files: declare a `"settings"` entry with `"kind": "secret"` and
read it with `await stacki.settings.get()`; Stacki's secret scan blocks sharing an app that holds one.
Keep state with `stacki.storage.set({ key: 'pins/home', value, scope: 'project' })` (committed with the site; `'local'` is this person's), sign work with `stacki.person.get()`, and check `(await stacki.app.info()).can` before an edit Studio may not have.
For actions only some people should take, declare `"permissions": [{ "id", "label", "description"?, "default" }]` in the manifest (admins set them per role) and check `await stacki.role.can({ permission: 'id' })` before acting: Stacki never enforces them for the app.
To place things on the canvas, `stacki.canvas.capture({ on: true })` turns the next clicks into `canvas.click` `{ nodeId, at }` events (`mode: 'observe'` leaves every click to the editor and reports single clicks too; `reason` is the chip's text), a label anchored `{ nodeId, at }` stays on that spot, `stacki.node.key({ nodeId })` gives a key that outlives edits (`node.find` gets the id back), and `stacki.page.findByAttribute({ name })` searches every page. A click inside a component also carries `layers` (innermost first, each with a `ref`); `node.measure`, `canvas.scrollTo`, `node.find` and anchors take `{ ref }` to reach an element inside a component instance. `stacki.canvas.setOutlineMode({ mode: 'deep' })` outlines hovers inside closed components (inspect only; it resets on its own), `stacki.canvas.highlight({ ref })` outlines one element as the editor would without selecting it (no argument clears it), and `stacki.canvas.startInsertDrag(item)` on pointerdown lets the person drag a `node.insert` item onto the canvas.
Mark a spot with a pin (`{ kind: 'pin', id, anchor: { nodeId, at }, label: '3', tone: 'accent', interactive: true }`); give a box, label or pin `draggable: true` and redraw it on each `overlay.drag` (`start`, `move`, `end`; `cancelled` puts it back), and `stacki.page.open`, `stacki.canvas.scrollTo({ nodeId })` and `stacki.selection.set` take the person back to a saved spot.

The full reference (every method, type, overlay kind, limit and error) is the Stacki Apps guide:
stacki.build/docs/apps, or `docs/apps.md` in the Stacki repository.

## Package and test

To test while you build, write the app straight to `.stacki/apps/<id>/` in the open project (the folder named exactly as `id`): it is installed at once and reloads when its files change.

1. `cd my-app && zip -r ../my-app.zip .`
2. To publish, attach the zip to a GitHub release (`gh release create v1.0.0 my-app.zip`). In Stacki press **E**,
   open the header's **+** menu, choose **Load App From GitHub**, then **Install**, then **Open**; projects see new releases as updates.
3. Tag the repository with the `stacki-app` topic (`gh repo edit --add-topic stacki-app`) so Load App From GitHub lists it.
