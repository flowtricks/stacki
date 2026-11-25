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
// Playwright is Studio's dev dependency (its browser tests); Desktop reuses it here rather than adding its own copy.
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-rich-text-shots'));
const SITE = repoPath('studio/test/fixtures/site');
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
  write('src/components/RichText.astro', '<div class="rich-text"><slot /></div>\n');
  // Lumos' Rich Text renders its slot through set:html (src/components/typography/RichText.astro), shaped the same here.
  write(
    'src/components/LumosRichText.astro',
    '---\nconst content = await Astro.slots.render("default");\n---\n{content && <div class="text rich-text"><Fragment set:html={content} /></div>}\n',
  );
  write('src/components/HtmlBlock.astro', '---\nconst { html } = Astro.props;\n---\n<div class="html-block" set:html={html} />\n');
  write(
    'src/pages/index.astro',
    '---\nimport Paragraph from "../components/Paragraph.astro";\nimport RichText from "../components/RichText.astro";\nimport LumosRichText from "../components/LumosRichText.astro";\nimport HtmlBlock from "../components/HtmlBlock.astro";\n---\n<html><body>\n<Paragraph>Words of a paragraph</Paragraph>\n<RichText><h2>Title</h2><p>Hello world</p></RichText>\n<LumosRichText><p>Lumos text</p></LumosRichText>\n<HtmlBlock html="<p>From a prop</p>" />\n<HtmlBlock html={"<p>" + "joined" + "</p>"} />\n</body></html>\n',
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
    args: [repoPath('dist/electron/main.js'), `--user-data-dir=${path.join(root, 'user-data')}`, project],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const results = {};
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1500, height: 950 }).catch(() => undefined);
    const canvas = window.frameLocator('iframe').first();
    await canvas.locator('.rich-text h2').waitFor({ timeout: WAIT_MS });
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
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await waitForFile(page, (text) => text.includes('<h3>Added on the page</h3>'));
    results.canvasRich = /<p>Hello world<\/p>\s*<h3>Added on the page<\/h3>/.test(page());

    // Undo and redo of the canvas edit, as one step each, from the app's own shortcut.
    await window.mouse.click(700, 61);
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
      await canvas.locator('.paragraph').dblclick();
      await canvas
        .locator('.paragraph[data-avb-text-editor]')
        .waitFor({ timeout: 2_000 })
        .catch(() => undefined);
    }
    await window.keyboard.press('End');
    await window.keyboard.press('Enter');
    await window.keyboard.type('Second line');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await waitForFile(page, (text) => text.includes('Second line'));
    results.lineBreak = /Words of a paragraph<br\s*\/?>Second line/.test(page());

    // The panel: the Lumos-style instance shows Edit rich text; the dialog opens on its content.
    results.paragraphOnce = (await canvas.locator('.paragraph').first().textContent())?.split('Second line').length === 2;
    await window.getByText('LumosRichText', { exact: true }).first().click();
    await window.mouse.click(1414, 61); // The Settings tab of the right panel.
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
  } catch (error) {
    results.error = String(error);
    await (await app.firstWindow()).screenshot({ path: path.join(SHOTS, 'error.png') }).catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
    fs.writeFileSync(path.join(SHOTS, 'page-after.astro'), page());
  }
  console.log(`RESULT ${JSON.stringify(results)}`);
  console.log(`Screenshots: ${SHOTS}`);
})();

// Polls the page file for what an action should have written, within a bound.
async function waitForFile(read, until) {
  for (let poll = 0; poll < 300; poll++) {
    if (until(read())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The page never showed the edit:\n${read()}`);
}
