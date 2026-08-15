// Compile gate for the marked source the dev server serves.
//
//   node test/markers.js [projectDir ...]
//
// `serializePageMarked` rewrites every .astro on its way to the browser, so
// whatever it emits has to be something Astro will still compile — and every
// marker it emits has to survive that compile, or the node it names can't be
// outlined on the canvas.
//
// Both halves have failed silently before:
//
//   compiles     a `.map()` body serialized as marker/child/marker returns a
//                list where one expression is wanted. Astro's own compiler
//                reads it as one template and accepts it; Astro 7's Rust
//                compiler rejects it, and every page with a loop 500s with a
//                bare "Unexpected token" and no file name.
//   markers kept a plain html comment directly inside a component is dropped
//                by BOTH compilers. That is why `markerFor` has a `set:html`
//                form — and why a <Fragment> wrapper without it builds fine
//                while quietly erasing the markers inside it.
//
// Checked against both compilers, because they disagree: @astrojs/compiler is
// Astro ≤6, @astrojs/compiler-rs is Astro 7+. A project can be passed on the
// command line to run its own pages through the same two checks.

const fs = require('fs');
const path = require('path');
const { parsePage, serializePageMarked } = require('../electron/astroParser.js');

// Pages whose marked output has caught a real bug. Kept inline: each is small,
// and what matters is the construct, not a file full of realistic markup.
const CASES = {
  'loop, arrow body': '---\nconst xs = [1];\n---\n<ul>{xs.map((x) => (<li>{x}</li>))}</ul>\n',
  'loop, no parens': '---\nconst xs = [1];\n---\n<ul>{xs.map((x) => <li>{x}</li>)}</ul>\n',
  'loop, block body': '---\nconst xs = [1];\n---\n<ul>{xs.map((x) => { const y = x * 2; return (<li>{y}</li>); })}</ul>\n',
  'loop, two children': '---\nconst xs = [1];\n---\n<ul>{xs.map((x) => (<li>{x}</li>))}</ul>\n',
  'loop of components': '---\nimport Card from "../components/Card.astro";\nconst xs = [1];\n---\n<div>{xs.map((x) => (<Card title={x} />))}</div>\n',
  'nested loops': '---\nconst rows = [[1]];\n---\n<div>{rows.map((row) => (<ul>{row.map((c) => (<li>{c}</li>))}</ul>))}</div>\n',
  'conditional, &&': '---\nconst c = true;\n---\n<div>{c && <p>x</p>}</div>\n',
  'conditional, ternary': '---\nconst c = true;\n---\n<div>{c ? <p>a</p> : <p>b</p>}</div>\n',
  'loop inside conditional': '---\nconst c = true;\nconst xs = [1];\n---\n<div>{c && <ul>{xs.map((x) => (<li>{x}</li>))}</ul>}</div>\n',
  'slotted child': '---\nimport Card from "../components/Card.astro";\n---\n<Card><h2 slot="header">Hi</h2><p>Body</p></Card>\n',
  'plain elements': '---\n---\n<div><p>hi</p></div>\n',
};

// Every marker the serializer put in the source, so the compiled output can be
// checked for the same set. `set:html` markers appear as a quoted string, plain
// ones as a comment — the path is what identifies them either way.
function markersIn(text) {
  return new Set([...text.matchAll(/avb-[se]:([\w|./-]+?)-->/g)].map((m) => m[0]));
}

const failures = [];
let checked = 0;

function fail(label, message) {
  failures.push(`  ${label}\n${message}`);
}

async function loadCompilers() {
  const wanted = [
    ['@astrojs/compiler-rs', 'Astro 7+'],
    ['@astrojs/compiler', 'Astro <=6'],
  ];
  const found = [];
  for (const [pkg, label] of wanted) {
    try {
      found.push({ label: `${pkg} (${label})`, transform: (await import(pkg)).transform });
    } catch {
      // Not installed — reported below rather than skipped quietly.
    }
  }
  return found;
}

async function check(compilers, label, source) {
  let marked;
  try {
    const parsed = parsePage(source);
    if (!parsed.editable) return { skipped: true };
    marked = serializePageMarked(parsed.model);
  } catch (err) {
    fail(label, `    serializePageMarked threw: ${err.message}`);
    return {};
  }
  const expected = markersIn(marked);
  for (const compiler of compilers) {
    let result;
    try {
      result = await compiler.transform(marked, { filename: '/page.astro' });
    } catch (err) {
      fail(label, `    ${compiler.label}: threw ${String(err.message || err).split('\n')[0]}`);
      continue;
    }
    const errors = (result.diagnostics || []).filter(
      (d) => d.severity === 'error' || d.severity === 1
    );
    if (errors.length) {
      fail(label, `    ${compiler.label}: ${errors[0].text}\n${indented(marked)}`);
      continue;
    }
    const lost = [...expected].filter((m) => !result.code.includes(m));
    if (lost.length) {
      fail(
        label,
        `    ${compiler.label}: ${lost.length} marker${lost.length === 1 ? '' : 's'} dropped by the compiler` +
          `\n      ${lost.join(' ')}\n${indented(marked)}`
      );
    }
  }
  checked++;
  return {};
}

function indented(text) {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => '      ' + l)
    .join('\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.astro')) out.push(p);
  }
  return out;
}

(async () => {
  const compilers = await loadCompilers();
  if (!compilers.length) {
    console.error(
      'markers: no Astro compiler installed — this gate cannot run.\n' +
        '  npm i -D @astrojs/compiler-rs @astrojs/compiler\n'
    );
    process.exit(2);
  }

  let skipped = 0;
  for (const [label, source] of Object.entries(CASES)) {
    const { skipped: s } = await check(compilers, label, source);
    if (s) skipped++;
  }

  for (const dir of process.argv.slice(2)) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root)) {
      console.error(`no such directory: ${dir}`);
      process.exit(2);
    }
    for (const file of walk(root)) {
      const rel = path.relative(path.dirname(root), file);
      const { skipped: s } = await check(compilers, rel, fs.readFileSync(file, 'utf8'));
      if (s) skipped++;
    }
  }

  const names = compilers.map((c) => c.label).join(', ');
  const skipNote = skipped ? `, ${skipped} not editable` : '';
  if (failures.length) {
    console.error(`\nmarkers: ${failures.length} failed, ${checked} passed${skipNote}  [${names}]\n`);
    console.error(failures.join('\n\n') + '\n');
    process.exit(1);
  }
  console.log(`markers: ${checked} passed${skipNote}  [${names}]`);
})();
