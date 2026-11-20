// Goal: the Page settings dialog never scrolls sideways. Its body holds the Folder dropdown beside a button, and the
// Layout props section holds the Properties panel's editors (a long prop name, a long unbroken value, an image card
// with a long path, the True/False switch, an option dropdown): none of them may make the body wider than the dialog,
// in a narrow window or a wide one.
//
//   node test/renderer/pages/pageSettingsWidthChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays the dialog out. A harness bundles the real
// PageSettingsDialog and InstancePropFields with styles.css and is loaded in one window, resized to each width in
// turn. For each width the probe waits (polling once per animation frame, bounded) until the dialog has drawn and
// its layout holds still for a frame, then reads the body's scrollWidth and clientWidth and every descendant's right
// edge against the body's. Nothing waits a fixed time. Screenshots are written to
// node_modules/.stacki-test/page-settings-width/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS_PX = [360, 520, 1200];
const LONG_NAME = 'aVeryLongPropertyNameThatKeepsGoingAndGoingWithoutAnySpaceToBreakAt';

const HARNESS = `
import { createRoot } from 'react-dom/client';
import './src/app/styles.css';
import { PageSettingsDialog } from './src/features/pages/PageSettingsDialog';
import { InstancePropFields } from './src/features/props/PropsPanel';

const page = (name, route) => ({ path: '/site/src/pages/' + name, name, route });
const pages = [page('index.astro', '/'), page('example-components.astro', '/example-components'), page('a-folder-with-a-long-name/post.astro', '/a-folder-with-a-long-name/post')];
const node = {
  kind: 'component',
  id: 'layout',
  name: 'BaseLayout',
  props: {
    ${LONG_NAME}: { kind: 'string', value: 'https://example.com/' + 'a'.repeat(160) },
    image: { kind: 'string', value: '/images/' + 'a-really-long-image-file-name-'.repeat(4) + '.png' },
    theme: { kind: 'string', value: 'a-very-long-theme-option-name-that-is-wide-enough-to-matter' },
  },
  children: [],
};
const schema = [
  { name: '${LONG_NAME}', type: 'string' },
  { name: 'image', type: 'string', optional: true },
  { name: 'theme', type: 'string', options: ['light', 'dark', 'a-very-long-theme-option-name-that-is-wide-enough-to-matter'], optional: true },
  { name: 'noindex', type: 'boolean', optional: true },
];
const layoutProps = (
  <InstancePropFields node={node} schema={schema} isLayout projectPath="/site" filePath="/site/src/pages/example-components.astro"
    onSetProp={() => {}} onRenameProp={() => {}} onSetText={() => {}} onSetContent={() => {}} onSetInline={() => {}} />
);
const host = { unavailable: undefined, plan: async () => ({ ok: false, error: { code: 'x', message: 'x' } }), apply: async () => ({ ok: true, value: undefined }) };
createRoot(document.getElementById('root')).render(
  <PageSettingsDialog page={pages[1]} pages={pages} folders={['a-folder-with-a-long-name']} host={host}
    allowed={{ rename: true, create: true, remove: true }} layoutProps={layoutProps} close={() => {}} />,
);
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css">' +
  '<style>html,body{margin:0;background:#111}</style></head><body><div id="root"></div>' +
  '<script>window.avb=new Proxy({},{get:()=>async()=>({ok:false,error:{code:"x",message:"x"}})});</script><script src="harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const WIDTHS = ${JSON.stringify(WIDTHS_PX)};
const MEASURE = \`new Promise((resolve) => {
  let frames = 0;
  let last = '';
  const step = () => {
    frames += 1;
    const body = document.querySelector('.page-settings-body');
    const shape = body === null ? '' : body.scrollWidth + 'x' + body.scrollHeight + ':' + body.clientWidth;
    if (body !== null && shape === last && document.fonts.status === 'loaded') {
      const limit = body.getBoundingClientRect().right;
      const wide = [...body.querySelectorAll('*')]
        .filter((element) => element.getBoundingClientRect().right > limit + 0.5)
        .slice(0, 10)
        .map((element) => element.tagName.toLowerCase() + '.' + String(element.className).split(' ').join('.'));
      const box = (element) => element.getBoundingClientRect();
      const sections = [...body.querySelectorAll('.page-settings-section')];
      const layout = sections.map((section) => {
        const heading = box(section.querySelector('h3'));
        const fields = [...section.querySelectorAll('.props-field')].filter((field) => field.parentElement.closest('.props-field') === null);
        const controls = fields.flatMap((field) =>
          [...field.querySelectorAll(':scope > input, :scope > textarea, :scope > .dd-trigger, .bool-seg, .asset-field, .asset-card')].map(box),
        );
        return {
          headingLeft: heading.left,
          contentRight: box(section).right - parseFloat(getComputedStyle(section).paddingRight),
          labelLefts: fields.map((field) => box(field.querySelector('label')).left),
          controlLefts: controls.map((rect) => rect.left),
          controlRights: controls.map((rect) => rect.right),
          gaps: fields.slice(1).map((field, index) => box(field).top - box(fields[index]).bottom),
          labelGaps: fields.map((field) => {
            const label = field.querySelector(':scope > label');
            const next = label?.nextElementSibling;
            return label && next ? box(next).top - box(label).bottom : undefined;
          }).filter((gap) => gap !== undefined),
        };
      });
      const address = body.querySelector('.page-settings-address');
      const addressStyle = getComputedStyle(address);
      const title = box(document.querySelector('.page-settings-title'));
      const route = box(document.querySelector('.page-settings-route'));
      resolve({
        scrollWidth: body.scrollWidth,
        clientWidth: body.clientWidth,
        gutter: getComputedStyle(body).scrollbarGutter,
        wide,
        layout,
        address: { background: addressStyle.backgroundColor, paddingLeft: addressStyle.paddingLeft, left: box(address).left, fieldLeft: box(address.parentElement.querySelector('.dd-trigger')).left },
        headerGap: route.top - title.bottom,
        homeLabel: [...body.querySelectorAll('.props-field > label')].map((label) => label.textContent),
      });
      return;
    }
    last = shape;
    if (frames > 600) {
      resolve({ error: 'the dialog did not settle' });
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})\`;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ show: false, width: WIDTHS[0], height: 900, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(DIRECTORY, 'host.html'));
    for (const width of WIDTHS) {
      win.setContentSize(width, 900);
      const measured = await win.webContents.executeJavaScript(MEASURE);
      fs.writeFileSync(path.join(DIRECTORY, 'width-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      results.push({ width, ...measured });
    }
    console.log('RESULT ' + JSON.stringify({ results }));
  } catch (error) {
    console.log('RESULT ' + JSON.stringify({ error: String(error && error.stack || error) }));
  }
  app.exit(0);
});
`;

// Every heading, label and control starts at one x; controls end at the card's inner edge; groups are one gap apart
// in both cards (the props-field rhythm), the address is plain text on the field's edge, and the header breathes.
function alignment(result) {
  const failures = [];
  const near = (left, right) => Math.abs(left - right) <= 1;
  const [general, layout] = result.layout;
  const origin = general.headingLeft;
  for (const [name, section] of [
    ['General', general],
    ['Layout props', layout],
  ]) {
    if (!near(section.headingLeft, origin)) {
      failures.push(`${result.width}px: ${name} heading starts at ${section.headingLeft}, not ${origin}`);
    }
    for (const left of [...section.labelLefts, ...section.controlLefts]) {
      if (!near(left, origin)) {
        failures.push(`${result.width}px: ${name} has a label or control at x=${left}, not ${origin}`);
      }
    }
    for (const right of section.controlRights) {
      if (!near(right, section.contentRight)) {
        failures.push(`${result.width}px: ${name} has a control ending at ${right}, not the card's inner edge ${section.contentRight}`);
      }
    }
  }
  const gaps = [...general.gaps, ...layout.gaps];
  if (gaps.length < 4 || gaps.some((gap) => !near(gap, gaps[0]))) {
    failures.push(`${result.width}px: field groups are not one gap apart: ${gaps.map(Math.round).join(', ')}`);
  }
  const labelGaps = [...general.labelGaps, ...layout.labelGaps];
  if (labelGaps.some((gap) => !near(gap, labelGaps[0]))) {
    failures.push(`${result.width}px: label-to-field gaps differ: ${labelGaps.map(Math.round).join(', ')}`);
  }
  if (result.address.background !== 'rgba(0, 0, 0, 0)' || result.address.paddingLeft !== '0px' || !near(result.address.left, result.address.fieldLeft)) {
    failures.push(`${result.width}px: the address is a chip, not plain text on the field's edge (${JSON.stringify(result.address)})`);
  }
  if (result.headerGap < 3.5) {
    failures.push(`${result.width}px: the title and the route are ${result.headerGap}px apart, less than 4px`);
  }
  if (!result.homeLabel.includes('Convert to home')) {
    failures.push(`${result.width}px: the homepage button has no "Convert to home" label (${result.homeLabel.join(', ')})`);
  }
  return failures;
}

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('page-settings-width: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/page-settings-width');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  buildSync({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 16 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      for (const result of output.results) {
        if (result.error !== undefined) {
          failures.push(`${result.width}px: ${result.error}`);
          continue;
        }
        if (result.scrollWidth > result.clientWidth) {
          failures.push(`${result.width}px: the body scrolls sideways (scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth})`);
        }
        if (result.wide.length > 0) {
          failures.push(`${result.width}px: wider than the body: ${result.wide.join(', ')}`);
        }
        if (result.gutter !== 'stable') {
          failures.push(`${result.width}px: the body keeps scrollbar-gutter: stable (it is ${result.gutter})`);
        }
        failures.push(...alignment(result));
      }
    }
  }
  if (failures.length > 0) {
    console.error(`page-settings-width: ${failures.length} checks failed\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`page-settings-width: passed  [screenshots in ${directory}]`);
  }
})();
