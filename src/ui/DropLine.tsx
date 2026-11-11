// The insertion line every reorderable list draws where a dragged row would land:
// the Navigator's and Pages' drop gaps (TreeDragDrop.tsx) and the Roles tab's pinned
// apps (RolePinnedApps.tsx). One component and one rule (styles.css `.drop-indicator`)
// so the accent, thickness, rounded ends and glow match wherever a row is dropped.
// It is absolutely placed in the centre of its container, so it never moves layout
// and never becomes a drop target itself.
export function DropLine() {
  return <div className="drop-indicator" aria-hidden="true" />;
}
