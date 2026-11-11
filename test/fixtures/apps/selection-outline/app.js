// The example app: outlines whatever is selected, in Stacki's accent, and counts project changes.
// Its page is built from Stacki's UI kit (index.html), the reference for an app's look.
const selected = document.getElementById('selected');
const changes = document.getElementById('changes');
let changeCount = 0;

async function follow({ nodeId }) {
  if (nodeId === undefined) {
    selected.textContent = 'Nothing selected';
    await stacki.overlay.clear();
    return;
  }
  selected.textContent = `Selected ${nodeId}`;
  await stacki.overlay.set({
    items: [{ kind: 'box', id: 'selected', anchor: { nodeId }, color: '#0099ff', label: 'Selected by app', interactive: true }],
  });
}

stacki.on('selection.change', follow);
stacki.on('project.change', ({ source }) => {
  changeCount += 1;
  changes.textContent = `${changeCount} project changes (last: ${source})`;
});
stacki.on('overlay.click', ({ itemId }) => {
  selected.textContent = `Clicked ${itemId}`;
});
stacki.selection.get().then(follow);
