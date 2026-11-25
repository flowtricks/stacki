// Goal: a project shaped like the one the field-latency report was made on: a page of real size and
// a stylesheet of thousands of rules, with one heading styled by `h2.heading.text-style-h3` whose
// colour comes from another rule (`.heading { color: var(--text) }`), so a committed custom colour
// replaces a variable chip and a clear brings that chip back.
//
// Method: pure text builders over a rule count, so the measurement (test/integration/
// styleFieldLatency.js) writes them into its scratch copy of the soak site and a gate test can check
// that the stylesheet grows linearly with the count and holds the target rules exactly once.
// Paths are joined with `path.join`; nothing here names a separator.

const fs = require('node:fs');
const path = require('node:path');

/** The rule the panel edits, and the element it styles. */
const TARGET = Object.freeze({
  selector: 'h2.heading.text-style-h3',
  elementId: 'lat-heading',
  property: 'color',
  stylesheet: path.join('src', 'styles', 'patterns.css'),
  page: path.join('src', 'pages', 'index.astro'),
});

const RULE_COUNT_DEFAULT = 3000;
const RULE_COUNT_MAX = 100000;
// The heading goes in right after this element of the soak page.
const PAGE_ANCHOR = '<Heading tag="h2" id="soak-heading-two"';

/** `count` filler rules (plain, state and breakpoint forms) and the target rules after them. */
function latencyStylesheet(count) {
  if (!Number.isSafeInteger(count)) {
    throw new Error('latencyStylesheet: count is a safe integer');
  }
  if (count < 1 || count > RULE_COUNT_MAX) {
    throw new Error(`latencyStylesheet: count is within 1..${RULE_COUNT_MAX}`);
  }
  const rules = [];
  for (let index = 0; index < count; index += 1) {
    rules.push(fillerRule(index));
  }
  rules.push(':root {\n  --lat-mix: 40%;\n}');
  rules.push('.heading {\n  color: var(--text);\n}');
  rules.push(`${TARGET.selector} {\n  letter-spacing: -0.01em;\n}`);
  return `${rules.join('\n\n')}\n`;
}

// One filler rule. Every tenth sits in a breakpoint and every seventh is a hover state, as a real
// site's would; none can match the target heading (each names a class only it carries).
function fillerRule(index) {
  const body = `  color: rgb(${index % 256}, ${(index * 7) % 256}, ${(index * 13) % 256});\n  padding-top: ${index % 40}px;`;
  if (index % 10 === 0) {
    return `@media (max-width: 991px) {\n  .lat-rule-${index} {\n  ${body.trim()}\n  }\n}`;
  }
  if (index % 7 === 0) {
    return `.lat-rule-${index}:hover {\n${body}\n}`;
  }
  return `.lat-rule-${index} {\n${body}\n}`;
}

/** The soak page with the target heading added after the second heading. */
function latencyPage(page) {
  const at = page.indexOf(PAGE_ANCHOR);
  if (at < 0) {
    throw new Error('latencyPage: the soak page has its second heading');
  }
  const heading = `<Heading tag="h2" variant="h3" id="${TARGET.elementId}">Latency heading</Heading>\n      `;
  return `${page.slice(0, at)}${heading}${page.slice(at)}`;
}

/** Writes the fixture into a scratch project (never a person's own). */
function writeLatencyFixture(project, count = RULE_COUNT_DEFAULT) {
  const stylesheet = path.join(project, TARGET.stylesheet);
  const existing = fs.readFileSync(stylesheet, 'utf8');
  fs.writeFileSync(stylesheet, `${existing}\n${latencyStylesheet(count)}`);
  const page = path.join(project, TARGET.page);
  fs.writeFileSync(page, latencyPage(fs.readFileSync(page, 'utf8')));
  return { stylesheet, page };
}

module.exports = { TARGET, RULE_COUNT_DEFAULT, latencyStylesheet, latencyPage, writeLatencyFixture };
