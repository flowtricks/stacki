// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the canvas from the click until the window is on
// the copy. It shows every frame at once (a skeleton for one with no kept document yet), says the site is being
// copied, and offers to cancel. Nothing in it is edited: there is no copy to edit yet.
import { useEffect, useRef, useState } from 'react';
import type { DesignFrameView } from '../../../shared/ipc/designSession';
import { centralIcon } from '../../ui/central/CentralIcon';
import { brush, close } from '../../ui/central/centralGeometry';
import { cancelDesignMode } from './designActions';
import { fitCamera } from './designCamera';
import { DesignFrameTile, EMPTY_FRAME } from './DesignFrameTile';
import { framePicture, useDesignView } from './designStore';
import { useCanvasColumn } from './useCanvasColumn';
import { useDesignWords } from './i18n/designWords';

const ModeIcon = centralIcon(brush);
const CloseIcon = centralIcon(close);

export function DesignOpeningCanvas({ frames }: { readonly frames: readonly DesignFrameView[] }) {
  const words = useDesignWords();
  const view = useDesignView();
  const area = useCanvasColumn('.main > .center .preview-frame-wrap');
  const column = useCanvasColumn('.main > .center');
  const plane = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = plane.current;
    if (element !== null) {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    }
  }, [area.visible]);
  const boxes = frames.map((frame) => ({ at: frame.at, widthPx: view.snapshots.get(frame.id)?.viewportWidthPx ?? EMPTY_FRAME.widthPx }));
  const camera = fitCamera(boxes, size.width, size.height);
  return (
    <>
      <div className="dm-canvas" data-design-mode="" style={{ ...area.style, display: area.visible ? 'block' : 'none' }}>
        <div ref={plane} className="dm-plane" dir="ltr">
          <div className="dm-world" style={{ transform: `translate(${String(camera.x)}px, ${String(camera.y)}px) scale(${String(camera.zoom)})` }}>
            {frames.map((frame) => (
              <DesignFrameTile
                key={frame.id}
                frame={frame}
                at={frame.at}
                zoom={camera.zoom}
                snapshot={framePicture(view, frames, frame)}
                mark="none"
                hover={undefined}
                picked={undefined}
                renaming={false}
                onRename={() => undefined}
                onRenamed={() => undefined}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="dm-bar" data-design-mode="" style={column.style}>
        <div className="dm-shell" role="toolbar" aria-label={words('bar.label')}>
          <span className="dm-name">
            <ModeIcon size={16} />
            <span className="dm-name-text">{words('bar.label')}</span>
          </span>
          <span className="dm-status" role="status">
            {words('enter.copying')}
          </span>
          <button type="button" className="dm-icon dm-exit" aria-label={words('bar.close')} onClick={() => void cancelDesignMode()}>
            <CloseIcon size={16} />
          </button>
        </div>
      </div>
    </>
  );
}
