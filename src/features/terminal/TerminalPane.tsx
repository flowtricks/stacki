import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { ArrowDownIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { TerminalRuntime } from './terminalRuntime';

export interface TerminalPaneHandle {
  readonly fit: () => void;
  readonly focus: () => void;
}

interface TerminalPaneProps {
  readonly terminalId: string;
  readonly projectPath: string;
  readonly autoLaunch: string;
  readonly onTitleChange: (title: string) => void;
}

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(props, ref) {
  const translate = useTranslate();
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<TerminalRuntime>();
  const autoLaunchRef = useRef(props.autoLaunch);
  const titleChangedRef = useRef(props.onTitleChange);
  const [scrolledUp, setScrolledUp] = useState(false);
  autoLaunchRef.current = props.autoLaunch;
  titleChangedRef.current = props.onTitleChange;

  useImperativeHandle(
    ref,
    () => ({
      fit: () => runtimeRef.current?.fit(),
      focus: () => runtimeRef.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    const runtime = new TerminalRuntime({
      host,
      terminalId: props.terminalId,
      projectPath: props.projectPath,
      autoLaunch: () => autoLaunchRef.current,
      titleChanged: (title) => titleChangedRef.current(title),
      scrolled: setScrolledUp,
    });
    runtimeRef.current = runtime;
    const unmount = runtime.mount();
    return () => {
      unmount();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = undefined;
      }
    };
  }, [props.projectPath, props.terminalId]);

  return (
    <div className="term-pane">
      <div className="term-host" ref={hostRef} />
      {scrolledUp && (
        <button className="term-scroll-btn" title={translate('workspace.terminal.scrollBottom')} onClick={() => runtimeRef.current?.scrollToBottom()}>
          <ArrowDownIcon size={14} />
        </button>
      )}
    </div>
  );
});

export default TerminalPane;
