// Goal: see the component editing settings work in the real app, end to end, and keep screenshots for a person:
// Allow rich text on the content slot of a slot component and of a Lumos-style `set:html` component and on a
// set:html prop, Allow line breaks on a paragraph component's content; Enter on the canvas, the `+`, the Edit rich text dialog, the code view, and undo and redo of a canvas edit.
//
// Method: a generated fixture project in a temporary directory (the studio fixture's installed packages cloned beside
// it, copy-on-write on macOS), never the owner's projects. The built app (`npm run build:electron`,
// `npm run build:renderer`, `npx vite build`) is launched by Playwright with its own user data directory, opened on the
// fixture, and driven with real clicks and keys. Files are read from disk to check what was written. Outside the gate
// (it starts the dev server): `node test/integration/richTextFlow.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor } = require('../helpers/waitFor.js');
// Playwright is Studio's dev dependency (its browser tests); Desktop reuses it here rather than adding its own copy.
const { _electron: electron } = require(
  fs.existsSync(repoPath('studio/node_modules/playwright'))
    ? repoPath('studio/node_modules/playwright')
    : '/Users/timothyricks/Documents/Projects/stacki/studio/node_modules/playwright',
);

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-rich-text-shots'));
// A worktree may not have installed the fixture site's packages: the main checkout's are read, never written.
const SITE = fs.existsSync(repoPath('studio/test/fixtures/site/node_modules'))
  ? repoPath('studio/test/fixtures/site')
  : '/Users/timothyricks/Documents/Projects/stacki/studio/test/fixtures/site';
const WAIT_MS = 60_000;

function writeFixture(project) {
  fs.mkdirSync(project, { recursive: true });
  // The fixture site's own source and assets come along whole: its config reads them.
  fs.cpSync(path.join(SITE, 'src'), path.join(project, 'src'), { recursive: true });
  fs.cpSync(path.join(SITE, 'public'), path.join(project, 'public'), { recursive: true });
  for (const file of ['package.json', 'astro.config.mjs', 'tsconfig.json']) {
    fs.copyFileSync(path.join(SITE, file), path.join(project, file));
  }
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0, 'the fixture packages were cloned');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  };
  write('src/components/Paragraph.astro', '<p class="paragraph"><slot /></p>\n');
  write('src/components/RichText.astro', '---\nconst { variant = "main" } = Astro.props;\n---\n<div class="rich-text" data-variant={variant}><slot /></div>\n');
  // Lumos' Rich Text renders its slot through set:html (src/components/typography/RichText.astro), shaped the same here.
  write(
    'src/components/LumosRichText.astro',
    '---\nconst content = await Astro.slots.render("default");\n---\n{content && <div class="text rich-text"><Fragment set:html={content} /></div>}\n',
  );
  // Lumos' own Paragraph (src/components/typography/Paragraph.astro), copied from the framework with its two helpers,
  // the `@/` alias written as a relative path: its tag comes from a prop and its slot is printed through set:html.
  const lumos = '/Users/timothyricks/Documents/Projects/lumos-framework/src';
  if (fs.existsSync(lumos)) {
    for (const file of ['utils/slots.ts', 'utils/style.ts']) {
      write(`src/${file}`, fs.readFileSync(path.join(lumos, file), 'utf8'));
    }
    write(
      'src/components/typography/Paragraph.astro',
      fs.readFileSync(path.join(lumos, 'components/typography/Paragraph.astro'), 'utf8').replaceAll('"@/utils/', '"../../utils/'),
    );
  }
  write('src/components/HtmlBlock.astro', '---\nconst { html } = Astro.props;\n---\n<div class="html-block" set:html={html} />\n');
  write(
    'src/pages/index.astro',
    `---\nimport Paragraph from "../components/Paragraph.astro";\nimport RichText from "../components/RichText.astro";\nimport LumosRichText from "../components/LumosRichText.astro";\nimport HtmlBlock from "../components/HtmlBlock.astro";\nimport LumosParagraph from "../components/typography/Paragraph.astro";\n---\n<html><body>\n<Paragraph>Words of a paragraph</Paragraph>\n<RichText><h2>Title</h2><p>Hello world</p></RichText>\n<LumosRichText><p>Lumos text</p></LumosRichText>\n<HtmlBlock html="<p>From a prop</p>" />\n<HtmlBlock html={"<p>" + "joined" + "</p>"} />\n<LumosParagraph id="lumos-p">\n  Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius enim in eros elementum tristique.${
      // The key pass starts from a break saved earlier, written open as HTML writes it, on a line of its own.
      process.env['RICH_TEXT_KEYS'] === '1' ? '<br>\n  Another paragraph' : ''
    }\n</LumosParagraph>\n<p id="plain-p" class="lead">Plain <strong>words</strong></p>\n<RichText />\n</body></html>\n`,
  );
  write(
    '.stacki/components.json',
    `${JSON.stringify(
      {
        version: 1,
        components: {
          'src/components/Paragraph.astro': { editing: { 'slot:default': { lineBreaks: true } } },
          'src/components/RichText.astro': { editing: { 'slot:default': { richText: true } } },
          'src/components/LumosRichText.astro': { editing: { 'slot:default': { richText: true } } },
          'src/components/HtmlBlock.astro': { editing: { html: { richText: true } } },
          'src/components/typography/Paragraph.astro': { editing: { 'slot:default': { lineBreaks: true, richText: true } } },
        },
      },
      undefined,
      2,
    )}\n`,
  );
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The real path: the app refuses metadata of a project opened through a symbolic link (macOS /var is /private/var).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-rich-text-')));
  const project = path.join(root, 'site');
  writeFixture(project);
  const page = () => fs.readFileSync(path.join(project, 'src/pages/index.astro'), 'utf8');
  const app = await electron.launch({
    // A mock keychain: a test app never asks the person's macOS keychain for anything (its own settings folder, the real HOME).
    args: [repoPath('dist/electron/main.js'), '--use-mock-keychain', `--user-data-dir=${path.join(root, 'user-data')}`, project],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const results = {};
  try {
    const window = await app.firstWindow();
    // Wide enough that the canvas's 1440 px desktop frame shows at 100 %: input into a scaled-down frame lands on the
    // wrong element in a hidden window.
    await window.setViewportSize({ width: 2200, height: 1000 }).catch(() => undefined);
    const canvas = window.frameLocator('iframe').first();
    await canvas.locator('.rich-text h2').waitFor({ timeout: WAIT_MS });
    // `RICH_TEXT_LOOKS=<locale>` (de, ar …) takes the pictures a consistency review needs instead of the flow.
    if (process.env['RICH_TEXT_KEYS'] === '1') {
      await keyPass(window, canvas, page, results);
      return;
    }
    const looks = process.env['RICH_TEXT_LOOKS'];
    if (looks !== undefined && looks !== '') {
      await lookPass(window, canvas, looks, results);
      return;
    }
    await window.screenshot({ path: path.join(SHOTS, '01-open.png') });
    await window.evaluate(() => {
      Reflect.set(window, '__posts', []);
      addEventListener('message', (event) => {
        const type = event.data?.type;
        if (typeof type === 'string' && /^avb:(rich|text-(save|inactive|active|refused|close))/.test(type)) {
          Reflect.get(window, '__posts').push(
            type +
              (event.data.html ? ':' + event.data.html : '') +
              (event.data.rect ? ':rect' : '') +
              (event.data.stack ? ':' + event.data.action + event.data.stack : ''),
          );
        }
      });
    });

    // Canvas rich text: Enter at the end of "Hello world" makes a new paragraph, the + turns it into a heading.
    await canvas.locator('.rich-text p').first().dblclick();
    await canvas.locator('[data-avb-text-editor]').waitFor({ timeout: WAIT_MS });
    results.richEditorTag = await canvas
      .locator('[data-avb-text-editor]')
      .first()
      .evaluate((element) => element.className || element.tagName);
    await window.keyboard.press('End');
    await window.keyboard.press('Enter');
    await window.waitForSelector('.html-block-plus', { timeout: WAIT_MS });
    await window.screenshot({ path: path.join(SHOTS, '02-canvas-plus.png') });
    await window.click('.html-block-plus');
    await window.getByRole('menuitem', { name: 'Heading 3' }).click();
    await window.keyboard.type('Added on the page');
    results.posts = await window.evaluate(() => Reflect.get(window, '__posts'));
    results.typed = await canvas
      .locator('.rich-text')
      .first()
      .evaluate((element) => element.innerHTML.replace(/ data-avb-[a-z]+="[^"]*"/g, ''));
    await window.screenshot({ path: path.join(SHOTS, '03-canvas-heading.png') });
    // A press outside the canvas saves (⌘/Ctrl Enter breaks the line now).
    await leaveCanvas(window);
    await waitForFile(page, (text) => text.includes('<h3>Added on the page</h3>'));
    results.canvasRich = /<p>Hello world<\/p>\s*<h3>Added on the page<\/h3>/.test(page());

    // Undo and redo of the canvas edit, as one step each, from the app's own shortcut.
    await leaveCanvas(window);
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await waitForFile(page, (text) => !text.includes('Added on the page'));
    results.undo = page().includes('<RichText><h2>Title</h2><p>Hello world</p></RichText>');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
    await waitForFile(page, (text) => text.includes('Added on the page'));
    results.redo = true;
    await canvas.locator('.rich-text h3').first().waitFor({ timeout: WAIT_MS });
    results.oneHeading = (await canvas.locator('.rich-text h3').count()) === 1;

    // Line breaks: Enter in the paragraph types a break, saved as <br />.
    // The canvas may still be settling the redo's render: double clicks repeat, a bounded number of times, until one opens.
    for (let attempt = 0; attempt < 10 && (await canvas.locator('.paragraph[data-avb-text-editor]').count()) === 0; attempt++) {
      // Right of the selection's name tag, which the host draws over the start of the words.
      await canvas.locator('.paragraph').dblclick({ position: { x: 120, y: 8 } });
      await canvas
        .locator('.paragraph[data-avb-text-editor]')
        .waitFor({ timeout: 2_000 })
        .catch(() => undefined);
    }
    await window.keyboard.press('End');
    await window.keyboard.press('Enter');
    await window.keyboard.type('Second line');
    // A press outside the canvas saves (⌘/Ctrl Enter breaks the line now).
    await leaveCanvas(window);
    await waitForFile(page, (text) => text.includes('Second line'));
    results.lineBreak = /Words of a paragraph<br\s*\/?>Second line/.test(page());

    // The panel: the Lumos-style instance shows Edit rich text; the dialog opens on its content.
    results.paragraphOnce = (await canvas.locator('.paragraph').first().textContent())?.split('Second line').length === 2;
    await window.getByText('LumosRichText', { exact: true }).first().click();
    await window.getByText('Settings', { exact: true }).first().click(); // The right panel's Settings tab.
    await window.waitForSelector('.props-rich-text-edit', { timeout: WAIT_MS });
    await window.screenshot({ path: path.join(SHOTS, '04-panel-button.png') });
    await window.click('.props-rich-text-edit');
    await window.waitForSelector('.props-rich-text-dialog .html-content', { timeout: WAIT_MS });
    await window.click('.props-rich-text-dialog .html-content p');
    await window.keyboard.press('End');
    await window.keyboard.press('Enter');
    await window.keyboard.type('From the dialog');
    await waitForFile(page, (text) => text.includes('From the dialog'));
    await window.screenshot({ path: path.join(SHOTS, '05-dialog.png') });
    results.dialog = /<LumosRichText>[\s\S]*Lumos text[\s\S]*From the dialog[\s\S]*<\/LumosRichText>/.test(page());
    await window.keyboard.press('Escape');

    // The code view of the same content, by the {} beside the label.
    await window.click('.props-rich-text .prop-expr-toggle');
    await window.waitForSelector('.props-rich-text-code .cm-content', { timeout: WAIT_MS });
    await window.screenshot({ path: path.join(SHOTS, '06-code-view.png') });
    results.codeView = (await window.textContent('.props-rich-text-code .cm-content'))?.includes('From the dialog') === true;

    // A literal set:html prop is rich text; a joined expression shows as code, locked.
    await window.getByText('HtmlBlock', { exact: true }).first().click();
    await window.waitForSelector('.props-rich-text-edit', { timeout: WAIT_MS });
    results.propLiteral = true;
    await window.getByText('HtmlBlock', { exact: true }).nth(1).click();
    await window.waitForSelector('.props-rich-text-code', { timeout: WAIT_MS });
    results.propExpressionLocked = (await window.getAttribute('.props-rich-text .prop-expr-toggle', 'aria-disabled')) === 'true';
    await window.screenshot({ path: path.join(SHOTS, '07-expression-code.png') });

    // The component's own Properties panel: the content slot's row first, lined up with the prop rows, and its settings.
    await window.getByText('RichText', { exact: true }).first().dblclick();
    await window
      .getByRole('button', { name: /^Properties/ })
      .first()
      .click();
    await window.waitForSelector('.property-list .property-slot-row', { timeout: WAIT_MS });
    await window.screenshot({ path: path.join(SHOTS, '08-property-list.png') });
    // The Content row's icon starts where the prop rows' icons do.
    const iconLeft = (selector) =>
      window
        .locator(`${selector} .list-field-icon`)
        .first()
        .evaluate((icon) => icon.getBoundingClientRect().left);
    results.contentFirst = (await window.locator('.property-list > .list-field-row').first().getAttribute('class'))?.includes('property-slot-row') === true;
    results.contentAligned = (await iconLeft('.property-slot-row')) === (await iconLeft('.property-list > .list-field-row:not(.property-slot-row)'));
    await window.locator('.property-slot-row button').first().click();
    await window.waitForSelector('.property-editing-flags', { timeout: WAIT_MS });
    // The form fades in; the picture is taken once it is fully shown.
    await window.waitForFunction(() => getComputedStyle(document.querySelector('.property-editor') ?? document.body).opacity === '1', undefined, {
      timeout: WAIT_MS,
    });
    await window.screenshot({ path: path.join(SHOTS, '09-content-settings.png') });
    results.propFlags = await window.locator('.property-editing-flags label').allTextContents();
    await window.keyboard.press('Escape');
  } catch (error) {
    results.error = String(error);
    await (await app.firstWindow()).screenshot({ path: path.join(SHOTS, 'error.png') }).catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
    fs.writeFileSync(path.join(SHOTS, 'page-after.astro'), page());
    // Printed here, so a pass that returns early (the look pass) reports too.
    console.log(`RESULT ${JSON.stringify(results)}`);
    console.log(`Screenshots: ${SHOTS}`);
  }
})();

// The states a reviewer compares with the rest of the app, in one interface language: the canvas `+` and its menu
// driven by the keyboard alone, the asset picker it opens, the `+` at another zoom, a narrow window, the rich text
// field and its dialog, and a prop's settings.
async function lookPass(window, canvas, locale, results) {
  // The interface's own words in this language, from the built catalogs, to find tabs and rail buttons by name.
  const word = (area, key) => require(repoPath(`dist/shared/properties/i18n/messages/${locale}/${area}.js`)).messages[key];
  const shot = (name) => window.screenshot({ path: path.join(SHOTS, `${locale}-${name}.png`) });
  await window.evaluate((preference) => localStorage.setItem('stacki.locale', preference), locale);
  await window.reload();
  // A reload starts on the welcome screen: the fixture is its recent project.
  await window.getByText('site', { exact: true }).first().click();
  await canvas.locator('.rich-text h2').waitFor({ timeout: WAIT_MS });
  await canvas.locator('.rich-text p').first().dblclick();
  await canvas.locator('[data-avb-text-editor]').waitFor({ timeout: WAIT_MS });
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.waitForSelector('.html-block-plus', { timeout: WAIT_MS });
  await shot('01-plus');
  // Keyboard only: focus the +, open its menu, move to Heading 3, choose it.
  await window.focus('.html-block-plus');
  await window.keyboard.press('Enter');
  await window.waitForSelector('[role="menu"]', { timeout: WAIT_MS });
  await shot('02-menu');
  for (let step = 0; step < 2; step++) {
    await window.keyboard.press('ArrowDown');
  }
  await window.keyboard.press('Enter');
  await canvas.locator('.rich-text h3').first().waitFor({ timeout: WAIT_MS });
  results.keyboardMenu = true;
  await window.keyboard.type('Heading');
  await window.keyboard.press('Enter');
  await window.waitForSelector('.html-block-plus', { timeout: WAIT_MS });
  await window.click('.html-block-plus');
  await window.getByRole('menuitem').nth(8).click(); // Image: the ninth row, after the six headings, paragraph and quote.
  // The picker opens on the menu's choice: wait for it rather than for a guessed time.
  await window.locator('.asset-pick-overlay, [class*="asset-pick"]').first().waitFor({ timeout: WAIT_MS });
  await shot('03-asset-picker');
  results.assetPicker = await window.locator('.asset-pick-overlay, [class*="asset-pick"]').count();
  await window.keyboard.press('Escape');
  await shot('04-address-field');
  await window.keyboard.press('Escape');
  await leaveCanvas(window);
  // Another zoom: the + still sits beside its block.
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Equal' : 'Control+Equal');
  await canvas.locator('.rich-text p').first().dblclick();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.waitForSelector('.html-block-plus', { timeout: WAIT_MS });
  await shot('05-plus-zoomed');
  await window.keyboard.press('Escape');
  // A narrow window, the rich text field and its dialog, and a prop's settings.
  await window.setViewportSize({ width: 1100, height: 800 });
  await window.getByText('LumosRichText', { exact: true }).first().click();
  await window.getByText(word('shell', 'shell.rightTabs.settings'), { exact: true }).first().click();
  await window.waitForSelector('.props-rich-text-edit', { timeout: WAIT_MS });
  await shot('06-field-narrow');
  await window.click('.props-rich-text-edit');
  await window.waitForSelector('.props-rich-text-dialog .html-content', { timeout: WAIT_MS });
  await shot('07-dialog-narrow');
  await window.keyboard.press('Escape');
  await window.getByText('HtmlBlock', { exact: true }).first().dblclick();
  await window
    .getByRole('button', { name: new RegExp(`^${word('rail', 'rail.properties')}`) })
    .first()
    .click();
  await window.waitForSelector('.property-list', { timeout: WAIT_MS });
  await window.locator('.property-row-main').first().click();
  await window.waitForSelector('.property-editing-flags', { timeout: WAIT_MS });
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.property-editor') ?? document.body).opacity === '1', undefined, {
    timeout: WAIT_MS,
  });
  await shot('08-prop-settings');
  results.flags = await window.locator('.property-editing-flags label').allTextContents();
}

// The Lumos Paragraph with line breaks and rich text on, typed into from the Content field and on the canvas: each step
// reads the canvas and the file, collects any error toast, and times how long a break takes to show and to be saved.
async function keyPass(window, canvas, page, results) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const toast = () => window.locator('body').evaluate((body) => (/[^.\n]*(?:couldn.t|could not|cannot|can.t)[^.\n]*/i.exec(body.innerText) ?? [''])[0]);
  const lumos = () => (/<LumosParagraph id="lumos-p">([\s\S]*?)<\/LumosParagraph>/.exec(page())?.[1] ?? '').trim();
  const plain = () => /<p id="plain-p" class="lead">([\s\S]*?)<\/p>/.exec(page())?.[1] ?? '';
  // Opens the words of an element for typing, the caret placed in the text node holding `words` at `at` (start/end).
  const open = async (selector, words, at) => {
    for (let attempt = 0; attempt < 10 && (await canvas.locator('[data-avb-text-editor]').count()) === 0; attempt++) {
      await canvas.locator(selector).dblclick({ position: { x: 120, y: 8 } });
      await canvas
        .locator('[data-avb-text-editor]')
        .first()
        .waitFor({ timeout: 2_000 })
        .catch(() => undefined);
    }
    await canvas.locator(selector).evaluate(
      (element, place) => {
        const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.data.includes(place.words)) {
            const offset = place.at === 'start' ? node.data.indexOf(place.words) : node.data.indexOf(place.words) + place.words.length;
            element.ownerDocument.getSelection().collapse(node, offset);
            return;
          }
        }
      },
      { words, at },
    );
  };
  const step = async (name, run, until, read) => {
    await run();
    await leaveCanvas(window);
    await waitForFile(read, until).catch(() => undefined);
    results[name] = { source: read(), ok: until(read()), toast: await toast() };
    await canvas
      .locator('[data-avb-text-editor]')
      .first()
      .waitFor({ state: 'detached', timeout: WAIT_MS })
      .catch(() => undefined);
  };
  // 1. A break saved earlier (`<br>` on its own line), Backspace at the start of the second line: the lines join.
  await step(
    'backspaceSavedBreak',
    async () => {
      await open('#lumos-p', 'Another', 'start');
      await window.keyboard.press('Backspace');
    },
    (text) => !/<br/.test(text) && /tristique\.\s*Another paragraph/.test(text),
    lumos,
  );
  // 2. A new break at the end and words on it, ⌘ Enter, one more character, then Backspace twice (the character, the break).
  await step(
    'enterThenBackspace',
    async () => {
      await open('#lumos-p', 'paragraph', 'end');
      await window.keyboard.press('Enter');
      await window.keyboard.type('Line two');
      await window.keyboard.press(`${mod}+Enter`);
      await window.keyboard.type('x');
      await window.keyboard.press('Backspace');
      await window.keyboard.press('Backspace');
    },
    (text) => /paragraph\s*<br \/>\s*Line two$/.test(text),
    lumos,
  );
  // 3. Forward Delete at the end of the first line takes the break out, the second line's words kept.
  await step(
    'deleteForward',
    async () => {
      await open('#lumos-p', 'paragraph', 'end');
      await window.keyboard.press('Delete');
    },
    (text) => !/<br/.test(text) && /paragraph\s*Line two/.test(text),
    lumos,
  );
  // 4. Enter in the middle of the words, then a selection across the new break deleted.
  await step(
    'middleThenSelectionAcross',
    async () => {
      await open('#lumos-p', 'Lorem ipsum', 'end');
      await window.keyboard.press('Enter');
      await window.keyboard.press('Shift+ArrowLeft');
      await window.keyboard.press('Shift+ArrowLeft');
      await window.keyboard.press('Backspace');
    },
    (text) => !/<br/.test(text) && /Lorem ipsu(?: |&#160;)dolor/.test(text),
    lumos,
  );
  // 5. Enter at the start of the words.
  await step(
    'enterAtStart',
    async () => {
      await open('#lumos-p', 'Lorem', 'start');
      await window.keyboard.press('Enter');
    },
    (text) => /^<br \/>\s*Lorem/.test(text),
    lumos,
  );
  // 6. A plain <p>, no setting: Enter after its bold word.
  await step(
    'plainParagraph',
    async () => {
      await open('#plain-p', 'words', 'end');
      await window.keyboard.press('Enter');
      await window.keyboard.type('after');
    },
    (text) => /Plain <strong>words<\/strong><br \/>after|Plain <strong>words<br \/>after<\/strong>/.test(text),
    plain,
  );
  // 7. The plain <p> from the Content field: Enter at the end, words.
  await canvas.locator('#plain-p').click({ position: { x: 120, y: 8 } });
  await window.getByText('Settings', { exact: true }).first().click();
  await window.click('.rich-content');
  await window.keyboard.press(`${mod}+ArrowDown`);
  await window.keyboard.press('Enter');
  await window.keyboard.type('panel');
  await waitForFile(plain, (text) => /<br \/>\s*panel/.test(text)).catch(() => undefined);
  results.plainPanel = { source: plain(), ok: /<br \/>\s*panel/.test(plain()), toast: await toast() };
  await window.screenshot({ path: path.join(SHOTS, 'keys-panel.png') });
  // 8. The Edit rich text dialog on an empty RichText: the + in its gutter, the placeholder and caret at the text edge.
  await window.getByText('RichText', { exact: true }).nth(1).click();
  await window.click('.props-rich-text-edit');
  await window.waitForSelector('.props-rich-text-dialog .html-content', { timeout: WAIT_MS });
  await window.click('.props-rich-text-dialog .html-content');
  await window.waitForSelector('.props-rich-text-dialog .html-block-plus', { timeout: WAIT_MS });
  results.dialogPlus = await window.evaluate(() => {
    const plus = document.querySelector('.props-rich-text-dialog .html-block-plus').getBoundingClientRect();
    const content = document.querySelector('.props-rich-text-dialog .html-content');
    const before = getComputedStyle(content, '::before');
    const edge = content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingInlineStart);
    return { plusRight: plus.right, textEdge: edge, placeholderLeft: content.getBoundingClientRect().left + parseFloat(before.insetInlineStart) };
  });
  await window.screenshot({ path: path.join(SHOTS, 'keys-dialog-empty.png') });
}

// A press outside the canvas on nothing that takes the keyboard (the panel header), so the canvas editor saves and the
// app's own shortcuts (undo, redo) are the ones the next keys reach.
async function leaveCanvas(window) {
  await window
    .locator('.panel-header, .props-title, header')
    .first()
    .click({ position: { x: 2, y: 2 } })
    .catch(() => window.mouse.click(1200, 15));
  await window.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

// Polls the page file for what an action should have written, within a bound: 300 polls of 100 ms, past the slowest
// save seen through the real app.
async function waitForFile(read, until) {
  await waitFor({ what: 'the page file shows the edit', read, until, pollCountMax: 300, pollIntervalMs: 100 });
}
