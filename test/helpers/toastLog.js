// Goal: let a component test read the toasts the real UI reports, since notices and errors are toasts, never paragraphs in a panel.
// Method: subscribe to the renderer's toast channel (src/ui/errorNotices) and mirror each live toast into a plain container in
// document.body: its message as text and one button per recovery action, wired to the action. A dismissed toast is removed, so a
// test reads what a person would see on screen and clicks what a person could click. The container is outside the component's own
// root, so "the panel holds no notice text" and "the toast says it" are separate assertions.

/** Mirrors toasts into `document`; `subscribe` is the bundle's own `subscribeErrorToasts` (one module instance with the component). */
function installToastLog(subscribe) {
  // Toasts reported while nobody listened are queued for the next listener; they belong to an earlier test, so drain them first.
  subscribe(
    () => undefined,
    () => undefined,
  )();
  const container = document.createElement('div');
  container.className = 'toast-log';
  document.body.appendChild(container);
  const items = new Map();
  const unsubscribe = subscribe(
    (notice) => {
      const item = document.createElement('div');
      item.className = 'toast-log-item';
      item.dataset.kind = notice.kind;
      const text = document.createElement('span');
      text.textContent = notice.message;
      item.appendChild(text);
      for (const action of notice.recovery ?? []) {
        const control = document.createElement('button');
        control.textContent = action.label;
        control.addEventListener('click', () => void action.run());
        item.appendChild(control);
      }
      items.set(notice.id, item);
      container.appendChild(item);
    },
    (id) => {
      items.get(id)?.remove();
      items.delete(id);
    },
  );
  return {
    /** The messages on screen, oldest first. */
    messages: () => [...container.querySelectorAll('.toast-log-item > span')].map((node) => node.textContent),
    /** Removes the mirror and the subscription. */
    uninstall() {
      unsubscribe();
      container.remove();
      items.clear();
    },
  };
}

module.exports = { installToastLog };
