// What a project window shows in the frames before the editor shell's code has arrived: the real
// title bar, rail, side panels and canvas in their real places, filled shapes and no words
// (docs/ui-loading.md). The shell loads behind the start screen (App.tsx), so this is seen only
// when a project opens before that finished, and it keeps the layout from jumping when it does.
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';

/** The widths the panels open at, so the placeholder and the shell line up. */
const LEFT_PANEL_WIDTH = '260px';
const RIGHT_PANEL_WIDTH = '340px';
const RAIL_BUTTONS = 8;

export function ShellSkeleton() {
  const buttons: number[] = [];
  for (let index = 0; index < RAIL_BUTTONS; index += 1) {
    buttons.push(index);
  }
  return (
    <div className="app">
      <div className="titlebar" />
      <div className="main">
        <div className="rail">
          {buttons.map((index) => (
            <Skeleton key={index} width="28px" height="28px" radius="6px" />
          ))}
        </div>
        <div style={{ width: LEFT_PANEL_WIDTH, flexShrink: 0, padding: 12 }}>
          <SkeletonRows count={8} />
        </div>
        <div className="center" style={{ flex: 1, minWidth: 0 }} />
        <div style={{ width: RIGHT_PANEL_WIDTH, flexShrink: 0, padding: 12 }}>
          <SkeletonRows count={10} />
        </div>
      </div>
    </div>
  );
}
