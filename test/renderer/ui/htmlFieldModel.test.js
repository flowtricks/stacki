// Goal: rich text stays editable when it carries only markup that describes itself — the
// list and link attributes exported rich text writes — and still locks for anything that
// could act (scripts, frames, handlers) or that the editor would drop.
// Method: the projection runs in a JSDOM document over known-good and known-bad fragments,
// and the editable HTML is compared with what went in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/html-field-model.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/ui/htmlFieldModel.ts')],
  absWorkingDir: ROOT,
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { editableHTML } = require(output);
const { document } = new JSDOM('<!doctype html>').window;

test('exported list and link attributes keep rich text editable and intact', () => {
  for (const html of [
    '<ul start=""><li>One</li></ul>',
    '<ol start="3" reversed="" type="a"><li value="4">Four</li></ol>',
    '<p><a href="https://example.com" target="_blank" rel="noopener">Site</a></p>',
    '<h6>Join us<br></h6>',
  ]) {
    const projection = editableHTML(html, document);
    assert.equal(projection.restricted, false, html);
    assert.equal(projection.html, html, 'nothing is dropped');
  }
});

test('markup that could act, or that is not document content, still locks the field', () => {
  for (const html of [
    '<iframe src="https://www.youtube.com/embed/x"></iframe>',
    '<p onclick="alert(1)">Hi</p>',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
    '<p style="color:red">Hi</p>',
    '<li start="2">Item</li>',
  ]) {
    assert.equal(editableHTML(html, document).restricted, true, html);
  }
});
