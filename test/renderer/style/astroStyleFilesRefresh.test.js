// Goal: the Style panel lists the `.astro` files with a `<style>` again when the page's components change. Create
// component with "Move styles" puts `<Portfolio />` on the page and writes `Portfolio.astro` with a `<style>` of its
// own; the panel used to list those files only for a new open file or when the window got focus back, so "Add custom
// styles in" offered "Create <style>" instead of the component's new tag until the person left Stacki and came back.
// Method: mount the real StylePanel through the shared harness, answer the file list from the test, and re-render it
// the way the app does after the move (the page's component paths gain the new file) and after its undo (they lose
// it). Each step counts the list's reads and checks what the panel published to its host; a re-render with equal
// paths in a new array must not read the list again.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel } = require('../../helpers/stylePanelHarness.js');

const FIXTURE = {
  sheets: [{ rel: 'src/styles/base.css', css: '.portfolio { display: grid; }' }],
  nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'portfolio' } }, children: [] }],
  markup: '<div class="portfolio" data-avb-p="n1">a</div>',
  selectedId: 'n1',
};
const PORTFOLIO = { rel: 'src/components/Portfolio.astro', name: 'Portfolio.astro', path: '/fixture/src/components/Portfolio.astro', size: 120 };

test('a component added to the page, then taken off, lists the `.astro` style files again; equal paths do not', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.settle();
  let reads = 0;
  let files = [];
  panel.window.avb.listAstroStyleFiles = async () => {
    reads += 1;
    return { files };
  };
  assert.deepEqual(panel.host().astroFiles, [], 'no component with a `<style>` yet');
  // The move: the component is written with its `<style>`, and the page now uses it.
  files = [PORTFOLIO];
  panel.rerender({ pageComponentPaths: [PORTFOLIO.path] });
  await panel.settle();
  assert.equal(reads, 1, 'the new component on the page lists the files again');
  assert.deepEqual(
    panel.host().astroFiles.map((file) => file.path),
    [PORTFOLIO.path],
    'the component’s `<style>` is offered without the window losing focus',
  );
  // An unrelated re-render with the same paths in a new array.
  panel.rerender({ pageComponentPaths: [PORTFOLIO.path] });
  await panel.settle();
  assert.equal(reads, 1, 'equal paths read nothing again');
  // The undo: the page no longer uses the component, and its file is gone.
  files = [];
  panel.rerender({ pageComponentPaths: [] });
  await panel.settle();
  assert.equal(reads, 2, 'the component taken off the page lists the files again');
  assert.deepEqual(panel.host().astroFiles, [], 'the deleted component’s `<style>` is no longer offered');
});
