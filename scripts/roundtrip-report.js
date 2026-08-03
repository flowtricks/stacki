#!/usr/bin/env node
//
// Human-readable view of the round-trip gate. The test suite answers "did
// anything regress"; this answers "where does the parser stand, and what is
// left to fix".
//
//   node scripts/roundtrip-report.js                    — the checked-in corpus
//   node scripts/roundtrip-report.js ~/my-astro-site    — any project tree
//
// Exits 0 always. This is a report, not a gate — `npm test` is the gate.

const fs = require('node:fs');
const path = require('node:path');

const { parsePage, serializePage } = require('../electron/astroParser.js');

const ROOT = path.join(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'test', 'corpus');
const expectations = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test', 'expectations.json'), 'utf8')
);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', 'release', 'build']);

function collect(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(d, entry.name));
      } else if (entry.name.endsWith('.astro')) {
        out.push(path.join(d, entry.name));
      }
    }
  };
  walk(dir);
  return out.sort();
}

function classify(file) {
  const source = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = parsePage(source);
  } catch (err) {
    return { status: 'threw', detail: err.message };
  }
  if (!parsed.editable) return { status: 'not-editable', detail: parsed.reason || '' };
  let output;
  try {
    output = serializePage(parsed.model);
  } catch (err) {
    return { status: 'threw', detail: `serialize: ${err.message}` };
  }
  return { status: output === source ? 'identical' : 'differs', detail: '' };
}

const target = process.argv[2];
const files = collect(target ? path.resolve(target) : CORPUS_DIR);
const base = target ? path.resolve(target) : CORPUS_DIR;

const counts = { identical: 0, differs: 0, 'not-editable': 0, threw: 0 };
const rows = [];

for (const file of files) {
  const { status, detail } = classify(file);
  counts[status]++;
  rows.push({ name: path.relative(base, file), status, detail });
}

const MARK = {
  identical: '  ok  ',
  differs: ' diff ',
  'not-editable': ' code ',
  threw: ' THREW',
};

const width = Math.max(0, ...rows.map((r) => r.name.length));

console.log(`\n  ${base}\n`);
for (const row of rows) {
  const known = expectations[row.name];
  const tag = known ? `  (known: ${known.severity})` : '';
  console.log(`  ${MARK[row.status]}  ${row.name.padEnd(width)}${tag}`);
}

const total = files.length;
const pct = (n) => (total ? `${Math.round((n / total) * 100)}%` : '0%');

console.log(
  `\n  ${total} files — ` +
    `${counts.identical} round-trip clean (${pct(counts.identical)}), ` +
    `${counts.differs} rewritten (${pct(counts.differs)}), ` +
    `${counts['not-editable']} code-view only (${pct(counts['not-editable'])}), ` +
    `${counts.threw} crashed\n`
);

// The known defects, worst first — this is the parser worklist.
if (!target) {
  const known = Object.entries(expectations).filter(([k]) => k !== '_comment');
  const order = { corruption: 0, formatting: 1 };
  known.sort((a, b) => (order[a[1].severity] ?? 9) - (order[b[1].severity] ?? 9));

  const corruption = known.filter(([, v]) => v.severity === 'corruption');
  console.log(`  Known defects: ${known.length} (${corruption.length} change meaning, not just formatting)\n`);
  for (const [name, info] of known) {
    console.log(`  [${info.severity}] ${name}`);
    console.log(`      ${info.note}\n`);
  }
}
