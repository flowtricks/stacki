# Translating the interface: the playbook

Rules and recipes for moving every user-visible string behind `translate()`. Read `docs/i18n.md` (layout, formats) first. Goal: when the person
picks a language in Settings, **all** text changes: Desktop, Studio, menus and dialogs. Languages: `en` (source), `es`, `fr`, `de`, `pt-BR`.

## 0. The loop

```sh
node scripts/i18n/scanRawStrings.mts <your folders>            # counts per folder; target 0
node scripts/i18n/scanRawStrings.mts --list <your folders>     # every remaining hit: file:line kind text
npx prettier --write <files> && npx eslint <files>             # naming lint: the function is `translate`, never `t`
npx tsc -p tsconfig.json --noEmit                              # also: -p electron/tsconfig.json, -p shared/tsconfig.json
env -u ELECTRON_RUN_AS_NODE npm test -- catalogParity <your suites>
npm run check:changed
```

The scan is a **floor, not a proof**: it sees JSX text, text props, label/title/message properties, `return 'sentence'`, plural ternaries and
capitalised property values. It cannot see a lowercase one-word label (`kind: 'image'` shown to a person), words built by concatenation, or text
produced two calls away. After it reads 0, read each file once more for visible words. A hit that is really code is silenced with
`// i18n-ignore: <reason>.` on the same or previous line (a reason is required in spirit: reviewers read it); `// i18n-ignore-file: <reason>`
in the first 30 lines excuses a file (brand-name tables).

## 1. Namespaces: who owns what

One namespace = one file per locale = one owner, so parallel agents never touch the same file. Key = `<namespace>.<area>.<thing>`, camelCase
segments, at least two segments (`isMessageKey`). **Edit only your own namespaces.** A word that already exists in `ui` (Cancel, Close, Apply,
Remove, Retry, Reset, Search…, Choose…, Open, Continue) is used from there: `translate('ui.cancel')`. Do not add to `ui`, `error`,
`menu` or `dialog` (A1/A12 own them); if you need a new shared word, put it in your namespace.

| Area | Folders | Namespaces (create `en/<ns>.ts` + 4 locales) |
|---|---|---|
| A1 (done) | `src/ui`, `src/lib`, `src/ipc`, i18n infrastructure | `ui`, `error` (renderer bridge errors), `menu`, `dialog` |
| A2 style panel | `src/features/style` sections and controls | `style` |
| A3 style models, selectors, variables, structure | `src/features/style/model`, clip path, embed, components; `selectors`, `structure`, `variables` | `styleModel`, `selectors`, `structure`, `variables` |
| A4 props | `componentDefaults`, `componentProperties`, `props`, **and `src/editor`** | `props`, `componentProps`, `editor` |
| A5 apps | `src/features/apps`, `studio/src/features/apps`, `shared/properties/app*.ts` | `apps` |
| A6 CMS and content | `cms`, `cmsConnections`, `content`, studio `cms`/`collections`/`components` | `cms` |
| A7 AI chat | `src/features/ai`, `electron/handlers/ai`, studio `ai` | `ai` (exists) |
| A8 publishing, git, assets, history | `publishing`, `git`, `assets`, `history`, `electron/git`, studio equivalents, `bake`, `github` | `publish` (exists), `git`, `assets`, `history` |
| A9 settings, roles, instructions | `src/app/settings`, `instructions`, studio `roles`/`settings`, `shared/properties/projectRoles.ts` | `settings` (exists), `roles`, `instructions` |
| A10 audits and workspace | `audits`, `code`, `notifications`, `pages`, `palette`, `preview`, `studioSetup`, `terminal`, `welcome`, `shared/page/audit*.ts` | `audits` (exists), `preview` (exists), `workspace` |
| A11 app shell | `src/app`, `app/model`, `app/roles`, `app/shell`, `app/state`, studio `app`, `auth`, `updates`, `collaboration`, `project`, `server`, `cloudflare` | `shell` |
| A12 main process | `electron/**` | `menu`, `dialog`, `error` (shared with A1's bridge keys: add, do not rename) |

New namespace checklist (the parity test fails until all of it is true): `en/<ns>.ts` + `es|fr|de|ptBR/<ns>.ts` with identical keys; one `import`
and one spread in each of the five `index.ts` (alphabetical, a two-line edit with the Edit tool, re-read the file right before); every new file
added to `studio/scripts/shared-source.json` (then `npm --prefix studio run assemble`, one run at a time, wait if another is running; never edit
`studio/vendor`). File header comment and `satisfies CatalogOf<...>` exactly as in `en/ui.ts` / `de/ui.ts`. Keys alphabetical in the file.
Main-process namespaces are also listed in `electron/lib/mainLocale.ts` (section 9).

Catalog rules: a key is never reused for different text; change the text, keep the key. Plural messages are objects (section 5). A translation
that must equal English (a product term, `Markdown`) ends its line with `// same`; a line a human should double-check ends with `// review`.
Parity test checks: same files, same keys, same `{placeholders}` and same `<tags>` per key, non-empty, differs from English unless `// same`.

## 2. Translation quality

- Register: **es tú** (Elige, Escribe), **fr vous** (Choisissez), **de du** (Wähle, dein; ignore the few `Sie` in `settings.secrets.*`, they are
  being fixed), **pt-BR você** (Escolha). Buttons and menu items use the infinitive or a noun (Elegir, Choisir, Auswählen, Escolher).
- Keep English: Stacki, Astro, Lumos, Sanity, GitHub, Cloudflare, CMS, MCP, HTML/CSS/JS, CSS property names and values, tag and class names,
  file paths, key names in shortcuts (Cmd, Ctrl, Shift, Alt, Enter, Esc), units (px, rem, %), code identifiers, `frontmatter`, `slot`, `prop` in code.
- Concise: UI width matters, German is longest; prefer the short natural word. No machine-literal calques. Ellipsis: `…` (de writes ` …` after a space).
- Typographic apostrophe `’` in fr/es/pt; keep English as the source wrote it.
- Glossary (use these; extend in your PR if you add terms):

| English | es | fr | de | pt-BR |
|---|---|---|---|---|
| Asset | recurso | ressource | Asset | recurso |
| Project | proyecto | projet | Projekt | projeto |
| Page | página | page | Seite | página |
| Component | componente | composant | Komponente | componente |
| Element | elemento | élément | Element | elemento |
| Selector / Class | selector / clase | sélecteur / classe | Selektor / Klasse | seletor / classe |
| Property (prop) | propiedad | propriété | Eigenschaft | propriedade |
| Variable | variable | variable | Variable | variável |
| Repository | repositorio | dépôt | Repository | repositório |
| Publish | publicar | publier | veröffentlichen | publicar |
| Settings | ajustes | réglages | Einstellungen | configurações |
| Folder | carpeta | dossier | Ordner | pasta |
| Link | enlace | lien | Link | link |
| Remove / Delete | quitar / eliminar | retirer / supprimer | entfernen / löschen | remover / excluir |
| Loop (list) | bucle | boucle | Schleife | laço |
| Undo / Redo | deshacer / rehacer | annuler / rétablir | rückgängig / wiederholen | desfazer / refazer |

## 3. Recipes (components)

The hook gives `translate(key, params?)`; keys are typed (`MessageKey`), so a typo is a compile error. Components render English at once
(no loading text, no raw keys); the catalog swaps in when loaded.

```tsx
// Before
<button title="Remove link" aria-label="Remove link">Remove</button>
// After
const translate = useTranslate();                       // import { useTranslate } from '<rel>/lib/i18n/useTranslate'
<button title={translate('ui.htmlLink.remove')} aria-label={translate('ui.htmlLink.remove')}>{translate('ui.remove')}</button>
```

| Pattern | Do |
|---|---|
| JSX text, `title`, `aria-label`, `placeholder`, `alt`, `label` props | `translate('ns.area.thing')`, one key per distinct sentence |
| Dynamic text `` `Remove ${name}` `` | one message with a placeholder: `'Remove {name}'`, `translate('x.remove', { name })`. Never split around the value; word order differs. Gender/case: write the whole sentence |
| Option arrays `[{ value: 'flex-start', label: 'Start' }]` | build in render (or a function taking `translate`): `label: translate('style.align.start')`. **Values and ids never change** |
| Module constants holding text | store a `MessageKey` (`label: 'ui.htmlToolbar.bold'`, typed `MessageKey` from `lib/i18n/localeContext`), translate where drawn. Never call `translate` at import time |
| Default prop text (`confirmLabel = 'Continue'`) | make the prop optional and resolve in render: `props.label ?? translate('ui.continue')` |
| Class components | `static override contextType = LocaleContext; declare context: ...; this.context.translate(...)` (see `src/ui/PanelBoundary.tsx`) |
| Code-ish text in a sentence | `{code}` slot via rich text (section 4), or keep the technical token as a param |
| Tooltips with shortcuts | message with a `{shortcut}` param; the key chord itself (`⌘K`, `Ctrl+K`) is not translated |
| Document title | `document.title = translate(...)` inside the effect that sets it, with `translate` in the deps |
| Toasts/status from handlers | translate at the call site where the hook is in scope; do not store English in state if the text can be a key (store the key and params, translate in render) |
| Text from the OS, git, a server, a user's file | stays as received (not ours to translate); wrap only our own sentence around it (`{message}` param) |

**Do not translate:** code, CSS/HTML/Astro identifiers, file paths and extensions, URLs, log and `console.*` text, `assert`/`throw new Error`
messages (programmer errors), test fixtures, brand names, `KeyboardEvent.key` names, debug/dev-only text, API refusals read by apps/agents, JSON keys,
generated source code written into the user's project (`const { x } = Astro.props;`), data values the user typed.

## 4. Rich text (inline code, links, emphasis)

A sentence with a code path or link in the middle is **one message** with marks. `{name}` is a slot (any React node), `<name>…</name>` wraps
translated text in an element you supply. `{{` `}}` are literal braces; `<` that is not `<name>` is text. Nothing is parsed as HTML.

```tsx
// en:  'ns.folders.saved': 'Saved in {file} for Desktop and Studio. <docs>Learn more</docs>'
// de:  'ns.folders.saved': 'Gespeichert in {file} für Desktop und Studio. <docs>Mehr erfahren</docs>'
const translateRich = useTranslateRich();
<p>{translateRich('ns.folders.saved', { file: <CodeInline>.stacki/folders.json</CodeInline>, docs: (text) => <a href={DOCS_URL}>{text}</a> })}</p>
```

- Function value = tag, anything else = slot. A mark the **message** uses that you did not pass crashes (programmer error); a **translation** using a mark
  you did not offer falls back to English with a console warning. `count: number` also selects the plural form.
- Parity test requires every locale to keep exactly the same `<tags>` and `{slots}`. Nesting depth ≤ 4, ≤ 16 tags/slots per message.
- Use rich text only when markup is inside the sentence; plain `translate()` shows `<b>` literally.

## 5. Plurals and numbers

`{ one, other }` (plus `few`/`many`/`two`/`zero` if a language needs it; `other` is required and the fallback). The category comes from
`Intl.PluralRules` for the active locale, so es/fr/pt `many` (millions) falls back to `other` unless the catalog provides it. `{count}` is required, numeric, finite.

```tsx
// Before
{count} {count === 1 ? 'file' : 'files'}
// After   en: 'ns.files': { one: '{count} file', other: '{count} files' }     de: { one: '{count} Datei', other: '{count} Dateien' }
translate('ns.files', { count })
```

Checklist for each of the ~143 ternaries: (1) find `=== 1 ?` / `!== 1 ?` / `.length === 1` with word branches (the scan prints them as `plural`);
(2) the whole phrase becomes the message, number included; (3) zero: `one` covers 0 in French (`0 fichier`); if "No files" reads better, branch in code
before calling translate; (4) a number that can exceed 999 is displayed with `formatNumber` as a **separate param**
(`{ count, total: formatNumber(count) }`, message uses `{total}`), `count` stays raw for the plural choice; (5) delete the old ternary.

Numbers, dates, sizes: never `toFixed`, `toLocaleString()` without a locale, `padStart`, or `` `${n} KB` `` in UI text.

```tsx
const { formatNumber, formatDate, formatRelativeTime, formatList, formatBytes } = useFormat();   // shared/core/i18n/format.ts
formatNumber(1234.5)                                   // 1,234.5 | 1.234,5
formatDate(date, { dateStyle: 'medium' })              // options are required: say what you want
formatRelativeTime(timestampMs, Date.now())            // "5 minutes ago" | "hace 5 minutos"
formatList(['a', 'b', 'c'], 'and')                     // "a, b, and c" | "a, b und c"
formatBytes(1536)                                      // 1.5 kB
```

Outside React: `formattersFor(locale)` from `shared/core/i18n/format`.

## 6. Pure code that produces a sentence (validation, refusals, labels computed in `src/editor`-style modules)

Pure functions cannot call hooks. Pick by what the text does:

| The sentence is… | Do |
|---|---|
| shown immediately by the caller, never stored | take `translate: Translator` as the **last** parameter (`Translator` from `shared/properties/i18n/messageRef`); callers pass the hook's `translate`; tests pass `ENGLISH_TRANSLATE` (`shared/properties/i18n/englishTranslator`) |
| returned inside a result, stored, or sent across a boundary | return a reference: `described('editor.x.y', params)` gives `{ message: <English>, messageRef }` |

Consumers of `Described` (a `{ message, messageRef? }` value, including optional wire fields) call `const translateDescribed = useTranslateDescribed();
translateDescribed(result)`. It shows the translation when the key is known and its parameters fit, otherwise `message`. A typed
`TypedMessageRef` alone (no English next to it) is shown with `useTranslateRef()` → `translateRef(ref)`; `englishText(ref)` gives its English
for logs and tests. Add the new field **optional**; never remove or rename the existing `message`.

```ts
// Before
return { ok: false, message: 'This setting is not linked to a property.' };
// After
return { ok: false, ...described('editor.options.notLinked') };   // import { described } from '<rel>/shared/properties/i18n/messageRef'
// UI:   {translateDescribed(result)}
```

Rules: never concatenate sentence fragments from several functions (`${where} ${problem}`); one full message per case with params.
Functions that returned `string | undefined` ("why can't I?") return `Described | undefined`: `=== undefined` checks keep working.

## 7. Shared-layer strings (`shared/`: audit findings, roles, app places, parsers)

`shared/` cannot call a hook. It returns the **stable id and params** next to the English text it always returned:

```ts
// shared/page/auditFindings.ts
import { messageRef } from '../properties/i18n/messageRef';
return { ...finding, title: 'Raw value', titleRef: messageRef('audits.finding.rawValue.title') };    // title stays: old readers, logs
// renderer
const translateDescribed = useTranslateDescribed();
translateDescribed({ message: finding.title, messageRef: finding.titleRef });
```

- `MessageRef = { key, params? }` (`shared/core/i18n/messageReference.ts`); `messageRef(key, params)` (typed against the English catalog) in
  `shared/properties/i18n/messageRef.ts`; `parseMessageRef(input)` validates one that crossed IPC/disk (bounded: key shape, ≤16 params, strings/finite numbers).
- Wire/IPC/disk formats stay backward compatible: **add** an optional `…Ref` field beside the string, parse it with `parseMessageRef` (drop it when invalid),
  keep the string. Old data without refs shows English; an unknown key from a newer producer shows `message`.
- Role/permission labels, enums with display names: store the id, never the label; map id → key in a table in the renderer (`Record<Id, MessageKey>`).
- Developer diagnostics in `shared/core/i18n`, parser `throw`s and `assert`s stay English.
- Already done as examples: `error.bridge.*` in `src/ipc/*Bridge.ts` (`Described` on `SanityLoginState`, `AccountState`, `MediaResult`, `RemoteResult`).
  Their consumers (CMS, publishing, media panels) show them with `translateDescribed`: **A6/A8 must switch the failure display to it.**

## 8. Pending call sites left by A1 (wave 2 completes them)

- `pageDisplayLabel(page, translate)` in `src/lib/pageName.ts` is the translated form of `pageDisplayName(page)` (English, kept for search/logs).
  Switch display callers: `src/features/pages/PageTreeView.tsx`, `PagesPanel.tsx`, `PageSwitcher.tsx`, `src/features/props/linkType.ts`,
  `src/app/state/appCanvasModel.ts`, `studio/src/features/project/pageLabels.ts`, `studio/src/features/pages/PageFileList.tsx` (A10, A3/A4, A11, Studio).
- `src/ui/PanelBoundary`: pass `label={translate(...)}` for the panel's displayed name (`name` stays the log id).
- `src/ui/PanelReadStatus` `label` (aria noun) and `ConfirmDialog` title/body/labels are the caller's; pass translated strings.
- **`src/editor` is not migrated** (about 136 scan hits: validation problems in `itemFields`, `propDeclaration`, `listPropType`, `propDocumentation`,
  `htmlAttributes`, `optionsBinding`, `optionsQuery`, `loopSections`, `loopQueryPlan`, `extractFrontmatter`, `selectorRemoval`, `dataSample`
  previews, `ITEM_FIELD_TITLES`). **A4 owns it** with the `props` consumers: namespace `editor` (additive: A4 creates `en/editor.ts` + 4 locales;
  A1 did not). Use section 6: `…Problem()` functions return `Described | undefined`, `{ ok: false, message }` results become
  `{ ok: false, ...described(key, params) }`, label maps become key maps. Developer-facing refusals (`insertTarget`, generated code) get `i18n-ignore`.
  Tree previews (`samplePreview`): add an optional `previewRef` beside `preview` on `TreeNode` and let `PreviewValue` render it.

## 9. Main process (Electron menu, dialogs, native messages)

`shared/` catalogs are loaded by the main process too. The renderer's choice (`stacki.locale`) is mirrored to main over `locale:set`
(`LocaleProvider onPreference` → `src/ipc/localeBridge.ts`), stored in `settings.json` as `localePreference`, and `"system"` resolves from
`app.getPreferredSystemLanguages()`. Changing the language rebuilds the menu. Main speaks only the namespaces `menu`, `dialog`, `error`.

```ts
import { translateMain } from './lib/mainLocale';
void showMessageBox(window, { title: translateMain('dialog.privacy.notSaved.title'), message: translateMain('dialog.privacy.notSaved.message') });
```

- Menu: `electron/app/applicationMenu.ts` (`buildApplicationMenuTemplate({ translate, ... })`); roles Electron localizes itself
  (`appMenu`, `windowMenu`, `viewMenu`) keep the OS language; A12 may spell them out.
- Dialogs and updater text: key in `dialog.*` (English in `en/dialog.ts` + 4 locales; keys alphabetical), `translateMain(key, params)` at the call site.
  Call it when the dialog opens, not at import (the language can change).
- Errors that reach the renderer: send the existing stable `code` and translate in the renderer by code, or add `messageRef` (section 7) with an `error.*` key.
  Free-form OS/git text stays as received.
- Adding a namespace to main: add it to `ENGLISH` and to each locale's importer in `electron/lib/mainLocale.ts`.
- Do not mass-migrate `electron/**` handler errors; prefer codes. Menu accelerators and the update check are the only menu actions that need `main.ts`.

## 10. Tests

- English is the default locale: existing tests that assert English still pass. Update a test only when the text itself changed.
- Hook-less code under test uses `ENGLISH_TRANSLATE`; a bundled test can `export { ENGLISH } from './src/lib/i18n/localeContext.ts'`.
- Every new boundary parser (a `messageRef` field, a settings value) needs a good and a bad-shape test (`parseMessageRef`, `catalogParity`).
- Add one test per non-trivial helper (a plural conversion that branches before `translate`, a key table).
- Run: `env -u ELECTRON_RUN_AS_NODE npm test -- catalogParity i18n <your suites>`; finish with `npm run check:changed`. Report failures outside your files separately.
- Do not launch Electron, do not touch `~/Desktop/my-site`. Studio: `npm --prefix studio run assemble` then `npm --prefix studio run check`, one at a time.

## 11. Definition of done for an area

1. `scanRawStrings` reports 0 for your folders (every remaining `i18n-ignore` has a real reason).
2. All five locales have your keys; `catalogParity` green; no `// same` on text that should differ; German fits the UI.
3. Plurals use messages, numbers/dates use `useFormat`, sentences with code/links use rich text.
4. Shared/main strings use refs/`translateMain`; no English stored where a key could be.
5. `tsc` (root, electron, shared), ESLint, Prettier, your suites, `check:changed` pass; Studio assembled and checked if you touched bundled files.
