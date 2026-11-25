// Goal: the browser's own cascade answer (the origin the canvas reports) and the panel's pure
// cascade ranking name the same winning declaration, for every CSS pattern the panel can meet,
// and that winner explains the used value. Also pins the owner's case: three `h3` margin-top
// rules across three stylesheets, where the last stylesheet's `0` is in use, not the first's `20px`.
// Method: bundle the real frame reader and the pure ranking into Chromium (Electron), load one
// element per pattern (order across sheets, specificity, :where, !important, layers and their
// important inversion, media conditions, shorthand against longhand, var(), the style attribute),
// and for each compare (a) getComputedStyle, (b) the frame's reported winner, (c) the winner the
// pure ranking picks from the frame's candidate list. Skipped, with a message, where Electron
// cannot be started (a CI image without a display server or the binary).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../../helpers/sources.js');

const CASES = [
  { id: 'order', style: ['.order{margin-top:1px}', '.order{margin-top:2px}'], prop: 'margin-top', used: '2px', value: '2px' },
  { id: 'spec', style: ['#spec{margin-top:3px} .spec{margin-top:4px}'], prop: 'margin-top', used: '3px', value: '3px' },
  { id: 'where', tag: 'section', style: ['section{margin-top:6px} :where(.where){margin-top:5px}'], prop: 'margin-top', used: '6px', value: '6px' },
  { id: 'important', style: ['.important{margin-top:7px !important} #important{margin-top:8px}'], prop: 'margin-top', used: '7px', value: '7px' },
  {
    id: 'layerLate',
    style: ['@layer a, b; @layer b{.layerLate{margin-top:9px}} @layer a{.layerLate{margin-top:10px}}'],
    prop: 'margin-top',
    used: '9px',
    value: '9px',
  },
  { id: 'unlayered', style: ['@layer a{.unlayered{margin-top:11px}} .unlayered{margin-top:12px}'], prop: 'margin-top', used: '12px', value: '12px' },
  {
    id: 'layerImportant',
    style: ['@layer a, b; @layer a{.layerImportant{margin-top:13px !important}} @layer b{.layerImportant{margin-top:14px !important}}'],
    prop: 'margin-top',
    used: '13px',
    value: '13px',
  },
  {
    id: 'media',
    style: ['.media{margin-top:15px} @media (min-width:100px){.media{margin-top:16px}} @media (min-width:99999px){.media{margin-top:17px}}'],
    prop: 'margin-top',
    used: '16px',
    value: '16px',
  },
  { id: 'shortAfter', style: ['.shortAfter{margin-top:18px} .shortAfter{margin:19px}'], prop: 'margin-top', used: '19px', value: '19px' },
  { id: 'longAfter', style: ['.longAfter{margin:20px;margin-top:21px}'], prop: 'margin-top', used: '21px', value: '21px' },
  { id: 'variable', style: [':root{--s:22px} .variable{margin-top:var(--s)}'], prop: 'margin-top', used: '22px', value: 'var(--s)' },
  { id: 'inlineLoses', style: ['.inlineLoses{margin-top:24px !important}'], attr: 'style="margin-top:23px"', prop: 'margin-top', used: '24px', value: '24px' },
  { id: 'inlineWins', style: ['#inlineWins{margin-top:26px}'], attr: 'style="margin-top:25px"', prop: 'margin-top', used: '25px', value: '25px' },
  { id: 'color', style: ['.color{color:red} div.color{color:blue}'], prop: 'color', used: 'rgb(0, 0, 255)', value: 'blue' },
  {
    id: 'owner',
    tag: 'h3',
    cls: 'heading',
    style: ['h3{margin-top:20px}', 'h1,h2,h3,h4,h5,h6{margin-top:0}', ':where(.heading){margin-top:0}'],
    prop: 'margin-top',
    used: '0px',
    value: '0px',
    winnerSelector: 'h1, h2, h3, h4, h5, h6',
  },
];

function html() {
  const styles = CASES.flatMap((one) => one.style.map((text) => `<style>${text}</style>`)).join('\n');
  const elements = CASES.map((one) => `<${one.tag ?? 'div'} id="${one.id}" class="${one.id} ${one.cls ?? ''}" ${one.attr ?? ''}>x</${one.tag ?? 'div'}>`).join(
    '\n',
  );
  return `<!doctype html><body style="width:1000px">${styles}${elements}`;
}

async function bundle() {
  const output = await require('esbuild').build({
    stdin: {
      contents: `export { queryAuthoredStyles } from './electron/preload/frameStyleSources';
        export { rankCandidates } from './src/features/style/model/cascadeResolve';
        export { LayerRegistry } from './src/features/style/model/cascadeLayers';
        export { selectorSpecificity } from './src/features/style/model/selectorParse';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'reader',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  return output.outputFiles[0].text;
}

// Runs in the page: for each case, the frame's answer and the pure ranking over its candidates.
const EXERCISE = `(() => {
  const registry = new reader.LayerRegistry();
  const seen = [];
  const walk = (rules, outer) => {
    for (const rule of rules) {
      if (rule instanceof CSSLayerStatementRule) {
        for (const name of rule.nameList) registry.positionOf([...outer, ...name.split('.')]);
      } else if (rule instanceof CSSLayerBlockRule) {
        registry.positionOf([...outer, ...rule.name.split('.')]);
        walk(rule.cssRules, [...outer, ...rule.name.split('.')]);
      } else if (rule.cssRules) {
        walk(rule.cssRules, outer);
      }
    }
  };
  for (const sheet of document.styleSheets) walk(sheet.cssRules, []);
  const applies = (conditions) => conditions.every((text) =>
    text.startsWith('@media') ? matchMedia(text.slice(6).trim()).matches : text.startsWith('@supports') ? CSS.supports(text.slice(9).trim()) : true);
  const results = {};
  for (const one of CASES) {
    const element = document.getElementById(one.id);
    const answer = reader.queryAuthoredStyles(element, [one.prop], 'element').authoredOrigins[one.prop];
    const specificityOf = (selector) => {
      const members = selector === 'style' ? [] : selector.split(',').map((member) => member.trim());
      const matching = members.filter((member) => { try { return element.matches(member); } catch (e) { return false; } });
      return matching.map((member) => reader.selectorSpecificity(member)).sort((left, right) => right[0] - left[0] || right[1] - left[1] || right[2] - left[2])[0] ?? [0, 0, 0];
    };
    const pure = answer && reader.rankCandidates(answer.candidates.map((origin) => ({
      origin,
      important: origin.important,
      inline: origin.selector === 'style',
      layer: origin.layer === undefined ? undefined : registry.positionOf(origin.layer.split('.')),
      specificity: specificityOf(origin.selector),
      order: origin.order,
      applies: applies(origin.conditions),
    })))[0];
    results[one.id] = {
      computed: getComputedStyle(element).getPropertyValue(one.prop).trim(),
      used: answer && answer.used,
      winner: answer && answer.winner,
      pureWinner: pure && pure.origin,
    };
  }
  return results;
})()`;

async function main() {
  let electron;
  try {
    electron = require('electron');
  } catch {
    electron = undefined;
  }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) {
    console.log('cascade-origins: skipped, no Chromium (Electron) is available');
    return;
  }
  const directory = path.join(ROOT, 'node_modules/.stacki-test/cascade-origins');
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, 'probe.js');
  fs.writeFileSync(
    script,
    `
    const { app, BrowserWindow } = require('electron');
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, width: 1000, height: 600 });
      try {
        await window.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html())}));
        await window.webContents.executeJavaScript(${JSON.stringify(await bundle())});
        const result = await window.webContents.executeJavaScript(${JSON.stringify(`const CASES = ${JSON.stringify(CASES)};\n${EXERCISE}`)});
        console.log(JSON.stringify(result));
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        window.destroy();
        app.quit();
      }
    });
  `,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, [script], { encoding: 'utf8', timeout: 60000, env });
  if (run.error !== undefined || run.status === null) {
    console.log('cascade-origins: skipped, Chromium could not start');
    return;
  }
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('{'));
  assert.ok(line, run.stderr || run.stdout);
  const results = JSON.parse(line);
  for (const one of CASES) {
    const result = results[one.id];
    assert.ok(result?.winner, `${one.id}: the frame reports a winner`);
    assert.equal(result.computed, one.used, `${one.id}: used value`);
    assert.equal(result.used, one.used, `${one.id}: the reported used value is the computed one`);
    assert.equal(result.winner.value, one.value, `${one.id}: the browser's winning declaration`);
    assert.deepEqual(result.pureWinner, result.winner, `${one.id}: the pure ranking agrees with the browser`);
    if (one.winnerSelector !== undefined) {
      assert.equal(result.winner.selector, one.winnerSelector, `${one.id}: the winning rule`);
    }
  }
  console.log('cascade-origins: the pure ranking matches Chromium on', CASES.length, 'patterns');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
