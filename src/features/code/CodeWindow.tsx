import Popup from '../../ui/Popup';
import type React from 'react';
import CodeEditor from '../../ui/CodeEditor';
import type { CodeEditorProps } from '../../ui/CodeEditor';
import { CloseIcon, CodeIcon } from '../../ui/Icons';
import { useWindowRectangle } from '../../ui/useWindowRectangle';
import { WindowResizeHandles } from '../../ui/WindowResizeHandles';

interface CodeWindowProps extends CodeEditorProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly editorKey?: React.Key | undefined;
}

// A single pointer session owns movement and cleanup, including closing mid-drag.
export default function CodeWindow(props: CodeWindowProps) {
  const { title, language, value, onChange, onClose, editorKey, revealLine } = props;
  const windowState = useWindowRectangle({ width: 340, height: 220 });
  const { rectangle } = windowState;
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={onClose}
      className="code-window"
      role="dialog"
      label={title}
      style={{
        left: rectangle.x,
        top: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
      }}
    >
      <div className="code-window-header" onPointerDown={(event) => windowState.start(event)}>
        <CodeIcon size={13} />
        <span className="code-window-title">{title}</span>
        <span className="type-tag">{language}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close (edits are saved live)" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="code-window-body">
        <CodeEditor key={editorKey} language={language} value={value} onChange={onChange} revealLine={revealLine} />
      </div>
      <WindowResizeHandles windowState={windowState} />
    </Popup>
  );
}
