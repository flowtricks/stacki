# Releasing Desktop, Studio, and create-stacki

These are separate publication paths. A successful `Check` run publishes nothing:

- A version tag starts `.github/workflows/release.yml`. Desktop installers, Linux install checks,
  and the Studio browser test must finish before the draft release becomes public.
- `.github/workflows/publish-create-stacki.yml` is manually dispatched from the same tested tag.
  See [create-stacki publication](./create-stacki.md) for authentication and registry verification.

Run the fast checks and complete regression suite locally before pushing. Also run Studio's
`npm run verify` and `npm run test:browser` against a disposable fixture workspace before tagging:
the Desktop regression gate does not run that separate Studio browser scenario.

Pushing a version tag runs the Linux preflight automatically: the `pre-push` hook runs it after the
full gate has rebuilt `dist/`, and a failure stops the tag reaching GitHub, so no release build
starts. `npm run release` pushes the version commit before the tag, so after a failure that commit
is on `main` and the tag exists only locally: fix the finding and release a new version rather than
moving the tag. Run `npm run check:linux` by hand (about 30 seconds) to find problems before
tagging. It checks, on a Mac, the ways the Linux release job has failed:

- relative imports and package or workflow paths match their files' case exactly (macOS ignores
  case, Linux does not), and no two tracked paths differ only in case;
- files run directly are executable in git, and every `#!` line works under Linux's `env`;
- no test names a git-ignored file that a clean checkout lacks (the 1.0.4 failure);
- both lockfiles hold every platform's dependencies (`npm ci` refused them in 0.1.52);
- electron-builder's Linux settings, icon and targets are valid, and the deb's maintainer script
  renders from the builder template and parses as shell;
- every suite that opens an Electron window passes with animation frames delayed 200 ms and CSS
  motion at quarter speed (`scripts/release/linuxSlowMotion.ts`). That is the hidden window on the
  slower runner: it reproduced the 1.0.11 sourceMenu failure to the pixel, and most Linux release
  failures have been probes that measured before a popup, scroll or hover finished moving. A
  warning lists probes that measure after a fixed sleep without waiting for the motion.

By hand, it runs the probes from the existing build, so run it after the regression suite. `--static`
skips the probes, `--repeat=3` runs them three times, and `--only=<name>` narrows them. What it
cannot reproduce stays with the Linux job: xvfb's GPU and capture paths (`thumbs`), inotify watcher
timing in Studio, the packaged deb and AppImage installs, and native module builds.

Use an isolated checkout when other tasks are editing the working directory. Match the root,
Studio, Studio release manifest, and npm starter versions. Never move an existing release tag to
include later changes.

## 1.0.21 the 1.0.16 changes, with undo after a reorder

- Desktop 1.0.20 never became public: Studio's browser test failed. After a Navigator drag,
  undo restored the page but the Navigator still showed the dragged order, because the drop's
  order was hidden rather than forgotten once the server answered, and the undo restored the
  exact source it was planned over. The order is now forgotten on the first source change.
- `create-stacki` 1.0.20 shipped that Studio; 1.0.21 replaces it.
- The browser test holds a touch past the drag threshold it reads from the Navigator, and finds
  the phone toolbar's single style and settings panel button.
- `npm run verify` does not run the browser test; run `npm run test:browser` against the fixture
  site before tagging.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.21.

## 1.0.20 the 1.0.16 changes, published

- The same app as 1.0.19, which never became public. On the Linux runner, the reveal let go
  between two widely spaced frames of a smooth-scroll library's glide, so the glide carried the
  node off screen; it now waits for the page to hold at the landing spot (2 s, or three times the
  longest gap between its scroll events) and jumps once more after a glide.
- On Windows a bake test imported by `D:\` path, which ESM refuses; it now uses a `file://` URL.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.20.

## 1.0.19 the 1.0.16 changes, through every platform's build

- The same app as 1.0.18, which never became public: its Mac build passed, but Windows and Linux
  failed.
  - Windows could not start `npm` from the bake tests (a `.cmd` file) and needed junctions.
  - On the Linux runner the Navigator reveal overshot its target. The browser's smooth scroll kept
    animating after the reveal had jumped, which the local slow-motion preflight cannot show.
- Every reveal now jumps instantly to an absolute landing spot, recomputed from the box and the
  scroller each time, so repeating it never moves the page. Desktop's Navigator reveal jumps
  rather than glides, as Studio's already did.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.19.

## 1.0.18 the 1.0.16 changes, through a clean checkout

- The same app as 1.0.17, which never became public. Its Linux build and the `create-stacki`
  workflow failed Studio's verify on a clean checkout: the demo bake tests borrowed Astro from the
  git-ignored `test/fixtures/site/node_modules`, copied a `dist/` that verify builds only after its
  tests, and shared one `node_modules` whose `.astro` and `.vite` caches parallel bakes overwrote.
- The tests now install the fixture site and build the preview runtime once under a lock, and each
  test project gets its own `node_modules` of linked packages. Run on a fresh clone with no build
  and no fixture packages, Studio's verify passed 667/667 and the full gate 604/604.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.18.

## 1.0.17 the 1.0.16 changes, with a Studio bundle that installs

- The same app as 1.0.16, which never became public. Its Studio bundle shipped
  `scripts/buildDemoAssets.ts`, which imports from `demo/`, a folder a release leaves out, so
  installing it failed Studio's type check and kept the old version. Installing the packed
  `create-stacki` into a test site caught it before anything was published; both 1.0.16 workflows
  were cancelled and the tag stays where it is.
- The release collector now leaves that script out (`RELEASE_EXCLUDED_FILES`), and the demo-release
  test allows a file to import `demo/` only when the release really leaves it out.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.17.

## 1.0.16 the editor on stacki.build, instant reorders, touch and rem

- stacki.build opens every page in the Studio demo, starting in preview: docs entries through
  their template page and entry switcher, prop edits rendered without Astro (variants, lists and
  layouts included), preview links, downloads and back/forward behaving like the site, and the
  reset bar shown only once there are edits.
- Drag to reorder updates the canvas the moment you drop; the render then confirms it, and a
  refused write puts the page back. Reordering works by touch on iPhone.
- Style drags and Variables nudges preview at once and write one at a time, so fast drags no
  longer report "This file changed". Lumos projects write rem for every length.
- Selector chips include classes an instance passes in, no longer flicker, and are ordered by
  specificity with a styled tag first. The canvas preview keeps the file's whitespace.
- Studio: Navigator picks scroll the canvas, through smooth-scroll libraries too; the editor
  collapses by canvas width; Safari and iOS fixes; swipes scroll the Style panel.
- Desktop: preview mode opens off-site redirects in the browser; the app is 28.8 MB smaller.
- Each release uploads the optional Studio demo and asks stacki.build to rebuild.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.16.

## 1.0.15 collection fields stick, prop renames follow through

- Fields added in a content collection's settings now stay. A name like `My Field` becomes the key
  `my-field`, an invalid name keeps its text and shows why, and a refused save no longer wipes the
  form (#75).
- Renaming a prop renames its local variable and every use in the file, in one undo step. A clash
  is refused under Name.
- With `::before` or `::after` selected, Duplicate, Wrap, Make component and Copy no longer act on
  the parent element.
- Studio: the chat no longer stacks copies of its transcript (#74).
- Pushing a version tag now also runs the Linux preflight.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.15.

## 1.0.14 the 1.0.13 Desktop release, through the Linux build

- The same app as 1.0.13, which never became a public Desktop release: its Linux build failed on
  two tests, and a tag is never moved. A reveal check read a smooth scroll the runner had paused
  10px in, and a chip width compared exactly differed by a pixel in Linux text rendering. Both
  tests are fixed; no app code changed.
- `create-stacki` 1.0.13 is on npm, and it creates the same project as 1.0.14. It is republished
  when someone can approve the sign-in, so npm can trail Desktop by this one version.

## 1.0.13 page templates, moving frontmatter into components, prop settings

- Create page template: the Pages `+` menu makes a template from a content collection, a Sanity
  connection or JSON from a link. The form fills itself from a fetched sample, shows the pages it
  will make, and keeps secrets in `.env`.
- Making a section a component moves the frontmatter it reads into the new component, leaving a
  copy when the parent still uses it. Passing a prop is the secondary choice. Extracting a section
  inside a loop no longer breaks the page.
- Props: a settings gear in the data picker opens the Properties form, existing props save as you
  edit, and list item fields can bind to data. Reset moves to the label's menu.
- Loops over a List prop have Filters, Sort and Limit, each with a code view for code the controls
  cannot show. Renaming a loop's variable updates every reference and refuses names that would
  break the page.
- Canvas: a click in a loop's outline selects the loop, an element in view no longer scrolls, and
  Delete on `::before` or `::after` no longer deletes the parent element.
- Code shown anywhere in the app is syntax highlighted, and the page dropdown matches the Pages
  panel's names. Switching CMS entries no longer flashes a slug error.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.13.

## 1.0.12 clip-path SVG paste is back, a new default shape, quieter undo

- Pasting an SVG into the clip-path tool works again. ⌘V never reached the tool: Desktop's Paste
  menu item pasted the copied element when no field had focus, and Studio cancelled ⌘V with an
  element selected. The open tool now claims ⌘V; straight lines become `polygon()` and curves
  `shape()`, with holes and fill rules kept.
- Choosing Shape starts from a new default shape, converted exactly as pasting it would be.
  Size, Offset X and Offset Y bind to variables like every other value field.
- An undo or redo that is declined (the element moved, unsaved edits, a syntax error to fix
  first) shows an orange warning instead of a red error.
- `npm run check:linux` runs before tagging and catches the causes of recent Linux build
  failures locally. v1.0.11's first Linux build failed on a menu measured mid-animation; the
  test now waits for the motion to settle.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.12.

## 1.0.11 style panel fixes: nested queries, live drags, !important, prop binding

- Spacing drags update the canvas while the pointer moves: a live save was a debounce that every
  animation frame pushed back, so nothing saved until the hand rested. It now throttles.
- Nested media queries are read from where they are written: the wrapper selector shows over the
  query for every element it reaches, a nested query is listed only for its wrapper and its
  descendants, each row names its stylesheet, and edits in a nested block land in that block live
  and on commit. The menu lists only authored queries; picking a px/rem query sizes the canvas,
  and Desktop returns an @media context to Base.
- `!important` shows in every Style panel field, and swatches, variable picks and list editors keep
  it instead of dropping it.
- The CSS Code editor shows two-space levels with selectors flush left, and new nested rules are
  written at the file's own depth. Clip path keeps the authored text and writes the shortest form.
- `--` suggests variables, and the bind circle sits on the field, in the clip-path and CSS Code
  editors. A click past a variable chip puts the caret after it.
- Components: plain text connects to a string prop, the bind dot replaces the value or inserts at
  the caret, the Settings pop-up and Properties panel share one property editor, and double-clicking
  slotted text edits it on the page instead of opening the component.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.11.

## 1.0.10 new collections load in a running preview, clean new entries

- Astro reads `src/content.config.*` only when the dev server starts, so a collection added while
  the preview ran (the CMS's first collection, or a config written by hand) read as empty and the
  data picker said "Reading one entry…" forever. An empty read from a preview that started before
  its content config existed now restarts the preview once, on the same address, and reads again.
- A new Markdown entry starts as an empty `---`/`---` frontmatter, which was not recognised: the
  first field written added a second block above it, and new or duplicated entries kept `---`
  lines in their body. The empty block is now filled in place.
- `create-stacki` 1.0.9 was never published. Desktop, the Studio source bundle and
  `create-stacki` are aligned at 1.0.10.

## 1.0.9 one-letter tags no longer crash the app

- 1.0.8's element tooltip asserted that every chip was longer than one character, so selecting
  a `<p>`, `<a>` or any other one-letter tag threw while the Style panel rendered and blanked
  the whole window. A one-letter tag is now a chip like any other, and a nameless token is left
  out instead of asserted on.
- A render error now stays in the panel it happened in: the Style, Settings and Navigator panels,
  the app root and Studio's Style panel show what broke with a Try again button, and retry on
  their own when the selection or page changes.
- 1.0.8 is superseded; its `create-stacki` was never published. Desktop, the Studio source
  bundle and `create-stacki` are aligned at 1.0.9.

## 1.0.8 typed classes land on the element, element tooltip

- A name typed without a dot in the Style panel's selector box (`hero_wrap`) was read as a tag
  selector for an element nobody has, so the class never went on the element and the Settings
  class box missed it until a style was set. It is now a class, added at once, unless it is an
  HTML or SVG tag or the selected element's own tag; `.`, `#`, `[` and `:` stay as typed.
- Resting on the element line above the selector field shows the whole element as chips: the
  tag and id grey, each class blue, every authored attribute purple.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.8.

## 1.0.7 loops that hold text, data picker marks

- A Text element dropped into a loop was written as `( Text )`, which Astro reads as a
  JavaScript name: the loop read back as code, its Settings lost the source picker, the
  Navigator showed nothing inside it and nothing could be dropped in. A loop body that is not
  made of tags (text, an expression, a `{/* */}` comment, a nested condition or loop) is now
  written inside `<>…</>`, and a loop's `<>` or `<Fragment>` is shown as the loop's own
  contents, written back as it was.
- The data picker marks where values come from: the component on its props heading, Astro on
  Content Collections, and the CMS mark on each collection.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.7.

## 1.0.6 a selection is revealed even when the smooth scroll stalls

The 1.0.5 release stopped at the Linux build, and this time it was the app: selecting an
element far down the page started a smooth scroll that stopped 9px down on that runner, and the
selection stayed below the fold until it was selected again. The canvas now watches the scroll
it starts and, when the page stops short of the element, jumps the rest of the way; a person
who scrolls meanwhile is left alone. The reveal test halts the first smooth scroll itself, so
the stall is reproduced on every platform. Version 1.0.5 has its tag but no Desktop release;
Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.6 with the 1.0.4
changes below.

## 1.0.5 release correction

The 1.0.4 release stopped on every platform at the prop model's parity test: its snapshot
listed six generated benchmark pages under `test/fixtures/large/`, which are git-ignored and so
exist only in a working copy that generated them, never in a clean checkout. The snapshot now
holds only files the repository carries, and the test asserts that none from there return. On
Linux, the reveal test also read a smooth scroll 9px into its way; it now waits until the
element is on screen and the page has stopped, or the page has held still, within a bound.
The app was not at fault. Version 1.0.4 has its tag but no Desktop release; Desktop, the
Studio source bundle and `create-stacki` were to align at 1.0.5; they align at 1.0.6.

## 1.0.4 component props, variable chooser, welcome screen

- Component props: the bind dot on a class, data attribute or text lists the component's props
  and creates a new one (name, tooltip, default and kind: plain text, number with min, max and
  decimals, switch with On/Off labels, attributes, list, image). Every prop shape Astro can
  express is read correctly — code-only props show "Set in code" instead of a text box — by one
  prop model all panels share. Instances mark required props, show defaults dimmed, reset a
  prop from its label, tag deprecated props and give colour props a swatch. Saving a property
  unchanged no longer rewrites the file.
- Variable chooser: scrolls with the wheel from the custom-value box; a chip opens it on its
  own variable and a pick swaps that chip only; typing `var(` or `--` suggests as you type;
  ↑/↓ preview variables live, and a press outside puts the original back; a pick replaces
  selected text; only variables that fit the property are offered.
- Undo and redo work while typing in Style fields and the custom-value box.
- Selector field: click between class chips to type there; Delete removes a selected class or
  data attribute when it is written literally; class suggestions match fuzzily ("btnprim"
  finds `button-primary`) here and in the Settings class box. The filter checkboxes are always
  available.
- ⌘K opens the insert palette; ⌥P toggles the preview, and the preview button names it.
- Every new Style Block is `<style is:global>`; making a component leaves page CSS untouched.
- The data picker heads project collections "Content Collections" with the Astro logo, closed
  until opened, and pages through a list's entries.
- Welcome screen: a slow WebGL background; readable text contrast across the app.
- Desktop, the Studio source bundle and `create-stacki` were to align at 1.0.4; they align at 1.0.6.

## 1.0.3 Linux release correction

The 1.0.2 release stopped at the Linux build: the Style panel surface test moved the pointer
once and read the grid row's hover 300 ms later, while the grid editor, now a pop-up over the
panel, could still be easing into place on the slower Linux runner. The app was not at fault.
The test now aims at the row where it is and moves again until the row reports `:hover`, a
bounded number of times. Version 1.0.2 has its tag but no Desktop release; Desktop, the Studio
source bundle and `create-stacki` are aligned at 1.0.3 with the 1.0.2 changes below.

## 1.0.2 pseudo-element layers, loop settings, Style panel fixes

- ::before and ::after are Navigator layers. Picking one selects the rule that styles it and
  lists only the selectors that style that pseudo-element; hovering or selecting it outlines
  its own box on the canvas.
- Loops: Selected items show each item's picture and start with none picked (Undo returns to
  Dynamic); sorts by natural text order, length, list size and image file size; Custom code
  filters and sorts; filter and sort fields picked from a tree that reaches nested fields; a
  Sanity loop item's fields can be bound. Changing a loop's source, filter or sort is written
  as one edit, so the page no longer flashes "teamEntries is not defined".
- A comment typed in a `<style>` block and a deleted trailing space no longer fail with
  "couldn't apply this edit"; text is pasted plain, and pasting code into Content no longer
  crashes the page; paste and undo work while editing canvas text; copying shows no toast.
- Style panel: nested selectors (`.faq_summary{&::before}`) are written inside the existing
  rule, indented as the file is; selectors such as `:open > &::after` show for the element;
  padding is written as one shorthand; the variable chooser shows a swatch per variable and
  only variables defined on the element; the align box steps with the arrow keys.
- ⌘Enter puts the caret in the selector field; → in the empty field fills in the parent's
  class up to its last underscore (`.stat_card_`). Class suggestions include classes used in
  markup and scripts, in src/ and public/.
- Grid, background, object-position, easing and clip-path editors open over the Style panel
  only; the clip-path editor reopens on the value it was given; a new effect layer opens on
  the first click; menu group headings are easier to read.
- Desktop, the Studio source bundle and `create-stacki` were to align at 1.0.2; they align at 1.0.3.

## 1.0.1 content collection fixes, quieter guide

- A content collection's list shows each entry's picture when its image field holds a root path
  such as `/src/assets/images/staff.webp`: Stacki looks in public/ and then from the project
  root, as Astro does.
- Glob collections list their entries newest first, so a new entry is on top; data-file
  collections keep their file's order.
- Deleting a collection removes its `defineCollection` const even when its name also appears in
  a loader path, so no dead definitions are left in the content config.
- A collection whose entries the dev server had lost (an entry saved while a required field was
  empty stops Astro's loader for the session) is resynced when a picker samples it: the Loop
  Source tree opens to its fields instead of "Reading one entry…" forever, and a loop's item can
  be bound again. A schema error is shown instead of nothing.
- Removing a query Stacki wrote no longer leaves a stray `// stacki:query` line behind.
- A loop whose callback returns several elements side by side stays a loop of elements instead of
  turning into a code block.
- Turning the column guide on or off shows no toast; only a failed load or save does. Toast icons
  say their kind: white for information, green for success, orange for warnings, red for
  errors. The guide button keeps its fill while the guide shows.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.1.

## 1.0.0 collection lists, linked list settings, selectors panel

- A loop's Settings work like a builder's collection list. Source opens a tree of the
  project's collections (Astro and Sanity, each opening to a sample item), the page's lists,
  None and a Custom list typed as rows; a list inside a collection's items can be chosen too
  (every campus's pastors). Then Items (Dynamic or Selected, picked and dragged into order),
  Filters (all or any), Sort (Is Off First / Is On First for switches) and Limit items. It is
  read from the code however it is written — by hand, by an AI assistant or by a Webflow
  export — and every change is one undo step that cleans up what the old source left behind.
- Filters, Sort, Show, Skip and Selected items link to component properties with a purple dot:
  "New property" asks for a name, tooltip and default; a linked setting shows as a purple bar
  with Edit settings, Disconnect, New property and Connect. A page using the component edits
  the property with the same editors, its label blue once set. A list written as code is
  rewritten as data, read through a small `listItems` helper, when a setting is first linked.
  The Properties panel recognises these props as Filter, Sort or Selected items.
- Sorts and filters drag to reorder; a newly inserted loop opens with these settings instead of
  breaking the page; a selected loop's outline wraps every item.
- The binding picker shows a builder export's loop items with their values, a renamed prop once
  by the name the code uses, and a field named with dashes as one chip
  (`item0.fields["campus-name"]`); samples come from a published entry, not a draft.
- Styles: a Selectors panel that finds selectors nothing uses and removes them, with a delete
  prompt, and a check-project report.
- CMS: Sanity reference pictures, readable dates and switches in tables, and content
  collection fields written by hand editable in collection settings.
- Image defaults written as expressions show their thumbnails; text inside a component no
  longer draws a second tag over the component's; variable tables keep their columns aligned.
- Code style: Prettier at 160 columns, with no line, function or file length check
  (AGENTS.md, docs/enforcement.md).
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.0.

## 0.1.99 Windows release correction

The 0.1.98 release stopped at the Windows build: the collection-delete test recorded the
trashed file with Windows path separators (`src\data\people.json`) and compared it with a
forward-slash path. The app was not at fault. The test now compares project-relative paths with
forward slashes on every platform. Version 0.1.98 remains an unpublished Desktop draft with its
original tag (its `create-stacki` package was published); Desktop, the Studio source bundle and
`create-stacki` are aligned at 0.1.99 with the 0.1.98 changes below.

## 0.1.98 content collection settings

- A content collection's row shows a settings gear on hover. Its settings open in the main
  view: the collection's name, and its fields — dragged to reorder, opened to edit, deleted,
  duplicated, or added from a grid of every kind a collection can hold (plain and rich text,
  image and multi-image, video link, link, email, phone, number, date, switch, color, option,
  file, reference and multi-reference, list, group, key–value, constant and any value).
  Changes are made to a copy and written on Save collection; Cancel drops them.
- A field's settings state every zod check its kind supports: lengths, ranges, a pattern,
  starts and ends with, contains, trim, letter case, whole numbers, sign, exclusive bounds,
  multiple of, earliest and latest dates, an image's width and height range, option values, a
  default, and allowing null. The common ones show at once; the rest are under Advanced.
- Each change is written to the content config, rewriting only what it touches. Renaming a
  field renames it in every entry and in code that reads the collection; renaming a collection
  moves a glob folder named for it and updates `getCollection`, `getEntry`, `reference` and
  `CollectionEntry` in src. Deleting a field removes its values; deleting a collection moves its
  entries to the Trash, removes fields that point at it, and gives code that reads it nothing to
  read, so the site still builds.
- Collections list their item counts beside their names.

## 0.1.97 Astro content collections in the CMS panel, richer CMS fields

- The CMS panel always lists the project's Astro content collections, beside its CMS
  connections, and opens them with the same browser, table and item editor as Sanity: search,
  select and delete, new items, and the narrow and phone layouts. Entries are the project's own
  files, edited in place; publish, discard, history and the status column are left out.
- A collection can be created from the panel: it is added to `src/content.config.ts` (created
  when missing) with a glob loader and a starter schema, and its folder is made.
- New items and deletes work in glob collections (a file per entry, deleted to the Trash) and in
  collections kept in one JSON or YAML data file, including an empty one.
- A collection's schema becomes the panel's fields: kebab-case and digit-led keys, nullable
  values, `image()` fields with a preview and a picker that opens the Assets panel in a pop-up
  over the entry, `reference()` fields, and plain id fields that name another collection's
  records (a Webflow export's campus ids), offered as that collection's entries by name with
  their images. Lists show each entry's first image as its thumbnail.
- CMS fields: a custom date and time picker; a slug that follows its document's name until it
  is written by hand; video links shown as cards; colour functions recognised as colours;
  dropdowns that choose on click rather than on hover; a richer rich-text editor with
  Markdown shortcuts as you type, cleaned-up pastes, word counts and undo through every edit; rich text that stays editable with list
  and link attributes exported by other CMSs; Sanity choices shown by their titles.
- New items and duplicates open as unsaved drafts with Create and Cancel: nothing is written
  until Create, and opening another item cancels one. An item's fields end with Delete and
  Duplicate. Select turns the toolbar into what is chosen, Delete and Cancel, with a box that
  chooses every row. Opening an item keeps the list's header and rows where they were, and a content
  collection always shows its list, even with one entry. Clicking an open collection closes it.
- Collection tables sort by any column (smallest first, then largest first), and the pin at
  the end of the header chooses which fields show as columns, remembered per collection; a
  reference shows its record's name. Many columns scroll sideways.
- Data files up to 32 MB are read (a few hundred sermons with transcripts); saving is still
  limited to 10 MB, and a larger file says so.
- The CMS panel's + opens Settings at CMS connections; a Sanity connection is labelled Sanity.
- Canvas text keeps the typed words on screen while a save is checked, and the title bar keeps
  room for the window buttons at any page zoom.
- Stacki Studio gets all of it through its CMS route. Desktop, the Studio source bundle and
  `create-stacki` are aligned at 0.1.97.

## 0.1.96 component text on the canvas, live CMS data, Studio parity

- Text a component shows from a prop is edited on the canvas like any other text. Select the
  component and its text is outlined dashed; hover outlines it with its own tag and tints the
  component; a click picks it, with the component shown as its parent; a double click types in
  it. Plain props save the words to the attribute; props a component renders as HTML
  (`set:html`) edit one run at a time with the canvas formatting bar and save back as HTML. The
  matching prop field in Settings follows each keystroke.
- Slot text inside a selected component gets the same outlines, and double-clicking slot text
  passed through a wrapper component (a Section's container) now opens the editor.
- Canvas text no longer carries a component template's indentation into the Content field or
  the source: an edit keeps only the words, with the source's own edges.
- The binding picker shows real data a page reads from its own code — `const pastors = await
  getCampusPastors()` — sampled by the dev server the way the page's render runs it (only a
  project module under `src/`, only an export called with no arguments). A loop item lists every
  field with its value and steps through entries; images show as thumbnails. The picker's rows
  are calmer: a quiet hover, a shallower indent, values without quotes.
- Stacki Studio gets all of it: prop text editing and outlines on the canvas, saved through its
  own attribute edits, and the binding picker with the page's data (a new
  `/studio/api/sample-value` route runs the same bounded sample inside the dev server).
- Studio keeps its own files under `.stacki/studio/`, which ignores its contents: drafts,
  history and uploads in `state/`, update backups in `updates/`. An older `.studio-state/` or
  `.stacki-studio/` moves there whole on first start.
- The Cloudflare template turns Observability off by default to avoid diagnostic logging
  charges (Studio's docs/cloudflare.md says how to apply it to an existing installation).
- Fixes the Windows test that held back the 0.1.95 Desktop release. Desktop, the Studio source
  bundle and `create-stacki` are aligned at 0.1.96.

## 0.1.95 connected CMS and canvas editing

- Connect Sanity from Settings with "Log in with Sanity" (or a pasted key) and edit its content in
  the CMS panel. Collections follow the site's Studio order and icons; lists show each type's
  preview picture, title and subtitle. Every field type is editable — text, numbers, switches,
  dates, choices (including ones built from project constants), slugs, locations, groups, lists,
  images and files (uploaded to Sanity), references and rich text — read from the site's own
  schema, including field helpers, hidden fields, required fields and stated validation rules.
- Edits save as drafts. The item header shows draft or published state with times, and offers
  Publish (blocked while a stated rule fails), Discard changes, Unpublish and History with
  restore. Items can be created, deleted after a confirm, and dragged into order where the
  collection uses the orderable plugin.
- Sanity reads are cached and refreshed in the background, so panels open at once; nothing waits
  on the network, and offline the panel keeps what it last read.
- CMS fields, local and Sanity, use the component prop fields: blue labels when set, the `?`
  help, the `{}` switch from a dropdown to free text, locale and time-zone choices, real toggles,
  and dropdowns capped in height with search for long lists.
- `consts.ts` lists are fields inside their file; canvas text, palette search, outlines and the
  canvas formatting toolbar carry the editing improvements made alongside.
- Stacki Studio connects Sanity too, by pasted Editor key from the CMS panel's "Connect a CMS"
  row (Studio's docs/cloudflare.md, "CMS connections"). The Worker keeps keys encrypted in R2 and
  decrypts one only for the request that needs it; only GitHub Write or Admin collaborators may
  add or remove a connection. A local Studio keeps its connections in the user's home folder.
  Desktop and Studio answer every connected-CMS call with the same service.
- Text fields holding a hex colour use Stacki's colour picker, with `{}` for any other value;
  SVG files preview as pictures.
- New dependency `@sanity/icons` (docs/dependencies.md). Desktop, the Studio source bundle and
  `create-stacki` are aligned at 0.1.95.

## 0.1.94 Windows release corrections

The 0.1.93 release stopped after Windows exposed two failures. A preview-port probe rejected
Windows-reserved sockets with `EACCES` instead of continuing its bounded search. An inherited
page-title lookup compared unresolved source spellings with native resolved import paths.

Local regressions reproduced both causes before the fixes: socket-boundary injection replays
`EACCES`, occupied ports, exhaustion and unrelated errors; equivalent source paths demonstrate
the missed inherited title. The probe now skips reserved ports, and title lookup normalizes both
sides without changing page identities. Native Windows verification remains required in CI.
Version 0.1.93 remains an unpublished draft with its original tag. npm's publishing approval
expired before completion, so that package was not published. All release versions are 0.1.94.

## 0.1.93 updates (included in 0.1.94)

- Double-click source-matched canvas text to edit it in place. Single-click selects elements.
  Native caret movement preserves typography and authored spans; unsafe runtime markup refuses
  editing. Content fields mirror typing and undo immediately. Leaving editing clears its text
  highlight. Supported variable and CMS edits retain their bindings and identify shared content.
- Desktop and Studio share canvas interaction mode, delayed toolbar tooltips, readable page and
  template labels, searchable URL paths and safe page/folder renaming with conflict validation
  and project link updates. Shared page order remains in `.stacki` metadata.
- Published-site links resolve existing hosting destinations. Desktop includes PR #70's window
  navigation, external-link and sensitive-permission restrictions.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 0.1.93.

## 0.1.92 standalone Studio verification

The 0.1.91 release stopped at Studio verification: the new cross-host metadata test loaded
Desktop source, but the standalone job installs only Studio dependencies. Its subprocess could
not resolve TypeScript from the repository root. A fresh local source archive without a root
install reproduced the failure; normal workspaces had masked it with their root dependencies.
The test now explicitly resolves shared dependencies from Studio's installation. The same
isolated test and full Studio verification must pass before publication.

Version 0.1.91 remains an unpublished draft with its original tag. Desktop, Studio and the starter
are aligned at 0.1.92, retaining the project-settings updates below.

## 0.1.91 project settings

Opening a project without saved guide preferences now uses in-memory defaults without creating
`.stacki/guide.json`. The first guide edit still saves the file, and readable legacy preferences
still migrate. Missing, corrupt and inaccessible browser storage do not create a defaults file.

Settings saves remain independent: slot component defaults, publish destinations and scripts,
page order and component sources create their own `.stacki` files when first saved. Desktop and
Studio read and write `.stacki/publish.json`; credentials remain in host authentication storage.
Regression tests exercise first saves without a metadata directory, named-slot insertion,
stale-write protection and publish settings exchanged between the actual Desktop and Studio hosts.

PR 66's Windows failure was the creation-event watcher assertion already corrected in 0.1.89.
Updating the branch from main retains that regression fix and the removed variables-panel probe.
The refreshed Ubuntu check exposed a separate first-capture `UnknownVizError` from Electron.
Replaying that exact rejection in the real local capture test reproduced the missing thumbnail.
Capture now retries that error once, bounds each attempt to three seconds, and preserves the
previous image on failure. Tests cover recovery, persistent failure, other errors and a stalled
capture without showing the window. The native Ubuntu gate remains required for verification.
Desktop, Studio and the starter are aligned at 0.1.91.

## 0.1.90 release validation

At the user's request, remove the variables-panel layout probe because its visible Electron
window interrupts local work every time the full regression gate runs. Other variables-panel
unit and integration tests remain. The removed probe's row-alignment, scroll and hit-testing
measurements are no longer covered by that browser test; application behavior is unchanged.

The 0.1.89 release run was canceled before publication to include this removal. Its tag remains
unchanged. Desktop, Studio and the starter are aligned at 0.1.90.

## 0.1.89 release validation

The 0.1.88 Windows gate caught a watcher test that assumed creating a file only emits `add`.
Windows also emitted `change` before the file was removed. Replaying the recorded event trace
reproduced the assertion locally. The test now accepts creation writes only between the new
route's add and unlink events; fixtures reject missing, reordered, unrelated and staging events.
The real-watcher test still requires one atomic-save event and preserves project ignore rules.

A native Windows runner is unavailable locally; the hosted Windows gate remains required.
Release 0.1.88 stays an unpublished draft with its original tag. Version 0.1.89 aligns Desktop,
Studio and the starter and includes the Mac packaging changes below.

## Separate Mac architectures

Mac releases produce `Stacki-VERSION-arm64.dmg` and `Stacki-VERSION-x64.dmg`, plus
matching `.zip` archives and blockmaps. Architecture-specific Electron binaries avoid the
compressed universal binary's mid-file signature changes; download savings must be measured
between consecutive signed builds with the same Electron version, not promised in advance.

Keep the app ID, signing identity and GitHub feed unchanged. One `latest-mac.yml` lists both
architectures; the metadata step rejects a missing ZIP or DMG before the draft can publish.
The existing updater selects ARM on Apple Silicon (including Rosetta) and x64 on Intel.
The migration may fall back to a full download if the old archive or blockmap cannot be reused.

Local regressions exercise the installed updater's architecture filter, per-target terminal
binaries, and dual-architecture metadata. Before publishing the first split release, verify
signed universal-to-native installation on Intel and Apple Silicon, including a Rosetta launch.
Unsigned packaging cannot verify Squirrel.Mac signature acceptance or notarization.

The marketing site's `/download/mac` selects ARM and `/download/mac-intel` selects Intel.
Both can use an older universal DMG until split assets are published. Browser CPU hints select
the button automatically; browsers without them show a choice because `MacIntel` and Intel UA
strings also occur on Apple Silicon. The website never substitutes the opposite-CPU installer.

## 0.1.87 startup correction

The live 0.1.86 cold-start check found that Git restoration checked out the baseline a second
time, hydrating every blob in its partial clone. Bootstrap now retains the already-restored
files when the active Git target equals that baseline. Divergent branches and unpublished drafts
still restore before CRDT updates. A real Git regression checks both paths, including an absent
object store to prove the identical-baseline path cannot download repository blobs.

## 0.1.86 release validation

The 0.1.85 Windows gate caught a test that expected `chmod(0755)` to set an executable bit.
Windows does not expose that POSIX mode change, so the assertion failed even though source
comparison correctly retained the regular-file mode. The replacement test checks remote mode
changes on every platform and actual executable-bit changes on POSIX. All other new Git
workspace tests passed on Windows. A native Windows runner is unavailable locally; the hosted
Windows gate remains required before publication. The original 0.1.85 tag remains unchanged.

A live rollout check also exposed Git status hydrating partial-clone blobs for file sizes.
Status now reads only paths, modes and hashes; a real partial-clone test disconnects its remote
and verifies that status succeeds without downloading the missing repository blobs.

Version 0.1.86 retains the updates below and aligns Desktop, Studio and create-stacki.
The 0.1.85 npm workflow passed all tests and packaging but npm rejected its publishing
identity with E404; no 0.1.85 package was published. npm remains a separate authorization step.

## 0.1.85 updates

- Studio uses Desktop's Git controls for commits, partial commits, pulls, branches and merge
  review. One container keeps one shared checkout: changing branches affects every editor.
  Durable Git checkpoints preserve unpublished commits and parked drafts across restarts;
  replacement document namespaces reject stale edits from an older checkout.
- Panel loading uses compact skeletons without visible loader labels. Catalogs, Git history,
  component counts and font thumbnails reuse bounded caches and refresh in the background.
  Assets initially open images when available, then assets, and retain later navigation.
- Publishing exposes its progress, favicon activity and published-site link, improves status
  checks, and protects active operations from idle shutdown. Component focus, collection
  overlays, active-page styling and preview controls match the shared Desktop behavior.
- Desktop, the Studio source bundle and the npm installer share version 0.1.85.

## 0.1.84 release validation

This release retains the application updates below and corrects the Linux installation probe.
The 0.1.83 Linux regression suite passed, but its packaged-app smoke test still called
`terminal:start` without the dimensions required by the terminal startup update. Publication
stopped before the draft became public; the 0.1.83 tag remains unchanged.

A local regression executes the actual generated renderer probe against the shared IPC parser.
It reproduced the same `Expected number` error, then passed after the probe supplied an 80-column,
24-row startup grid. A typed fixture now checks required IPC fields during compilation, and the
runtime test checks startup, command output handling, and cleanup. Native packaged Linux terminal
verification remains required in the hosted installation checks.

Desktop, the Studio source bundle, and the npm installer are aligned at version 0.1.84.

## 0.1.83 release validation

This release contains the 0.1.82 updates below with corrected cross-platform test setup.
The 0.1.82 Desktop release remained unpublished after Linux failed three scrollbar assertions;
its npm installer had already published successfully. The existing tag remains unchanged.

The failure reproduced in a local Linux container with Electron's sandbox enabled. An unmapped,
hidden BrowserWindow delayed native scroll and ResizeObserver notifications. Disabling background
throttling alone did not fix it. The layout probe now maps its window without taking focus and
waits for bounded, measured synchronization instead of short sleeps. All 36 original assertions
pass on Linux and macOS. Application behavior is unchanged by this test correction.
Windows reported the same three failures. A local Windows runner is unavailable, so the hosted
Windows regression gate remains required to confirm the fix there before publication.

Versions were aligned at 0.1.83, but the packaged Linux check described above stopped publication.
The npm installer remained at 0.1.82.

## 0.1.82 updates

- Variables open in a dockable, resizable window. Group menus remain clickable above the window,
  and the shared horizontal scrollbar aligns with the values on Desktop and mobile Studio.
- Editor side panels resize and remember their bounded widths. Asset grids add thumbnail columns
  as the panel widens and keep sparse folders compact.
- Sibling placement works inside repeated markup containers while preserving source structure.
- Terminals start with their measured dimensions, avoiding an incorrectly sized first shell prompt.
- Preview element lookup targets matching paths, and attribute changes avoid unnecessary page
  reports while structural changes still refresh the page.
- The welcome background limits resolution and frame rate, pauses when inactive, and uses a
  static fallback for reduced motion or constrained devices.
- Desktop, the Studio source bundle, and the npm installer share version 0.1.82.

## 0.1.81 updates

- Collaborative edits continue reaching peers during slow saves. Source and draft writes are
  batched, while save confirmations and publishing still wait for persistence.
- Preview rendering avoids duplicate work, preserves newer text while older renders arrive,
  and recovers more reliably from disconnects and delayed startup.
- Desktop and Studio share source-preserving structural edits and faster component usage scans.
  Atomic staging files no longer trigger unnecessary Astro route rebuilds.
- Assets, CMS and Variables retain loaded content between visits and distinguish loading from
  empty results. Studio adds the shared Git history graph and file diffs.
- Collaboration locks appear in element settings with the editor's avatar. Connection status
  replaces the Draft badge; loading counts and sign-in rate limits provide clearer feedback.
- Cloud rendering remains dependent on project work and container capacity. These changes do
  not promise instant rendering on every project or add independent per-editor Git branches.

### 0.1.80 release validation

The 0.1.80 release stopped before publication when cross-platform checks exposed two races in
the new watcher regression. Vite can emit `ready` before `createServer` returns, and its watcher
coalesces rapid changes to the same file. Waiting for the missed event stalled Linux and one
macOS run; expecting a second immediate event failed Windows.

The stall reproduced in a local Linux container. The test now checks the public watched-file
inventory with a bounded wait and uses a separate existing file for the outside-edit case.
Canonical temporary paths also account for macOS symlinks. It still checks atomic rename,
staging-file ignores, project ignore rules, outside edits, and route addition/removal. The
replacement release is 0.1.81; the original tag remains unchanged for diagnosis.

## 0.1.79 updates

- New Astro and Lumos projects let you choose npm or pnpm. Stacki checks that the chosen
  manager is installed before creating the project and includes its lockfile in the first commit.
- Selected starter templates use a white background with dark text and preserve their spacing.
- Desktop, the Studio source bundle, and `npm create stacki@latest` share version 0.1.79,
  including the editable merge review and Windows merge fixes from 0.1.78.

### 0.1.79 browser failure investigation

The first hosted Studio browser run failed after leaving interactive preview: Astro's
`Unhandled rejection` overlay added another heading, so Playwright correctly refused the
ambiguous selector. The log captured the overlay title but omitted its error message and stack;
it does not establish the underlying cause. All Desktop platform gates and installers passed.

The exact release passed locally with the installed Chrome and with the same Chromium version
used by CI. Four additional runs, each with a new draft workspace and server, also passed.
This macOS reproduction cannot establish why the Linux runner showed the overlay. A rerun of
the unchanged tagged Studio job must still pass before the draft can become public.

Future browser failures now log bounded preview error messages and stacks alongside the editor
inspector and browser errors. The assertions, selectors, and timeouts remain unchanged; an error
overlay must not be hidden by narrowing the heading selector. These diagnostic-only test changes
do not change the tagged application or its published npm package.

## 0.1.78 updates

- Merge review now opens in a wider, editable final-code view. Branch-colored highlights show
  where each change came from, with independent choices for text and attributes, manual overrides,
  and undo/redo. Automatic merging still combines compatible edits; stale reviews are rejected
  before they can overwrite newer work.
- Branches have distinct colors throughout the branch list, commit destination, and history graph.
  Commit controls clearly identify the destination branch while the graph preserves real ancestry.
- Merge confirmation has cleaner spacing and shorter copy.
- Content fields preserve the caret when deleting spaces, so Backspace continues editing where
  expected instead of jumping to the beginning.

### 0.1.77 release validation

The 0.1.77 release was stopped before publication after Windows CI exposed CRLF conflict markers
being treated as ordinary source. A local reproduction with `core.autocrlf=true` failed the same
real-Git merge test. The parser now accepts CRLF marker endings while retaining source line endings;
regression checks cover both Git conversion modes, exact output, and unclosed markers.

An Ubuntu check also read a popup before its exit timer removed it. The browser probe now waits
for bounded popup presence/removal instead of assuming a fixed sleep is enough. This scheduler
race did not reproduce locally; the strengthened probe passes locally and still runs in CI.
The replacement is 0.1.78; the existing 0.1.77 tag and unpublished draft are retained for diagnosis.

## 0.1.76 updates

- Astro `.map()` callbacks recognize async, function, block, typed, destructured, and referenced
  forms while preserving source and exposing their markup as editable elements.
- Optional content fields use blue reset labels: Option-click to clear, or click and choose Reset.
- Project startup shows one loading indicator while dependencies and the preview are starting.
- [PR #54](https://github.com/flowtricks/stacki/pull/54): Project dependencies and Cloudflare's
  Wrangler install use the site's package manager, preferring `package.json` over its lockfile.
  Cancelling Cloudflare sign-in lets installation finish, and pnpm installs tolerate blocked
  dependency build scripts while keeping those scripts blocked. The sign-in dialog keeps one
  screen through installation, browser sign-in, and retry.
- [PR #55](https://github.com/flowtricks/stacki/pull/55): Start from Astro now asks where the site
  should go, then lets you name it and preview its folder, matching Start from Lumos. Both flows
  share name validation and improved label spacing. Failed Astro creation removes its new folder
  only when it is still empty, so retrying the same name works without deleting generated files.
- The welcome screen uses folder, GitHub, Lumos, and Astro icons with concise action labels.
  Dropdowns expand from their buttons as one white surface and animate closed before opening
  the next dialog, with reduced-motion support.

## Learn from publishing failures

Whenever a GitHub release or publishing workflow fails, inspect the failure before retrying.
Reproduce the cause locally whenever possible, then add or improve a local regression test that
fails for that cause and passes after the fix. Run the regression test and the required local
release checks before pushing again. Include the regression coverage in the fix so future releases
catch the same problem before reaching GitHub.

Match the conditions that caused the failure: a clean checkout, the Git hook environment, the
affected operating system, or the packaged installation. Prefer deterministic reproduction over
repeated retries, longer timeouts, or weakened assertions. For timing failures, synchronize on the
actual event or inject the failing condition instead of relying on a lucky test run.

Some failures depend on external services, signing, authentication, or hosted runner infrastructure.
When a local test cannot reasonably reproduce the cause, document why, record the verification
that is possible, and keep the required remote check. Never skip a gate to make publishing succeed.

## Browser tests and animated popups

Shared popups remain mounted while their close animation runs, and consume outside clicks during
that time. After closing a popup, wait for that popup to detach before clicking another control.
Do not use an arbitrary sleep or weaken the assertion.

In the 0.1.64 release, the Studio browser scenario closed the account menu and immediately clicked
`Expand all`. The closing popup consumed that click, leaving the navigator collapsed. The test
then timed out looking for Heading, even though the component existed. Waiting for
`.account-popover` to detach fixed the scenario.

## 0.1.64 recovery record

The tested release tag points to `6903fb2825006cd79eff99bfbacae2fd51a3b38c`. All three platform
builds, Linux installation checks, and Studio's compilation, lint, formatting, and unit tests passed
in GitHub Actions. The browser scenario reproduced locally against that exact source. After the
test-only popup wait was added, the complete browser scenario passed against the same release.

The existing Desktop installers were preserved. The Studio bundle built from the tested tag was
uploaded, all platform update metadata and installer assets were verified, and the draft was
published as the latest release. No application code or published version tag was changed.

The npm workflow separately failed authentication after passing its tests and building the package.
The maintainer authenticated a local publication of the exact-tag package after a fresh installation
smoke test. The registry's package checksum matched the tested tarball, and both `dist-tags.latest`
and the downloaded CLI reported 0.1.64.

The original failed workflow runs remain red; publishing manually does not rewrite their history.
Confirm live availability through the latest GitHub release and npm registry, rather than inferring
it from workflow badges. Do not bypass an unresolved application failure to publish a draft.
