import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorModel } from '../../editor/pageView';
import {
  componentSourceRanges,
  nodeSelectionOf,
  sourceLineLabel,
  sourceNodeAtOffset,
  sourceRangeForSelection,
  textSelectionOf,
  type SourceRange,
  type SourceSelection,
} from './codePanelModel';
import CodeEditor, { type CodeEditorSelection } from '../../ui/CodeEditor';
import Menu from '../../ui/Menu';
import { useShortcutTip } from '../../ui/shortcutTip';
import { SparkleIcon } from '../../ui/Icons';
import { currentDesktopPlatform, isAddToChatKey, shortcutLabel } from '../../lib/shortcutLabel';
import { PanelHeader } from '../../ui/PanelHeader';
import { useTranslate } from '../../lib/i18n/useTranslate';

interface CodePanelProps {
  readonly source: string;
  readonly relativePath: string;
  readonly model: EditorModel | undefined;
  readonly selectedId: string | undefined;
  /** Code to show instead of the whole selected element: what a refusal's 'Show in code' points at. */
  readonly revealRange?: SourceRange | undefined;
  readonly onChange: (source: string, position: number) => void;
  readonly onSelect: (id: string) => void;
  readonly onOpenComponent: (name: string, id: string) => void;
  /** More editor behaviour from the caller, read when the editor is made (the CSS chips of the page's `<style>` blocks). */
  readonly extensions?: Extension | undefined;
  /** What the editor draws beside its code with those extensions (the chips' popups). */
  readonly overlay?: ReactNode;
  /** "Add to chat" for what is selected here: the selected text, else the highlighted element. Absent where there is no AI panel. */
  readonly onAddToChat?: ((selection: SourceSelection) => void) | undefined;
}

export default function CodePanel(props: CodePanelProps) {
  const translate = useTranslate();
  const { source, relativePath, model, selectedId, revealRange, onChange, onSelect, onOpenComponent, extensions, overlay, onAddToChat } = props;
  const selectionRange = useMemo(() => sourceRangeForSelection(model, selectedId, source.length), [model, selectedId, source.length]);
  const activeRange = revealRange ?? selectionRange;
  const components = useMemo(() => componentSourceRanges(model?.nodes ?? [], source), [model, source]);
  const chat = useCodeSelection({ source, relativePath, model, selectedId, revealRange, activeRange, onAddToChat });
  const lineLabel = sourceLineLabel(source, chat.textRange ?? activeRange);
  return (
    <section className="code-panel" onKeyDown={chat.onKeyDown}>
      <PanelHeader
        title={translate('workspace.code.title')}
        actions={
          <>
            <span className="code-panel-path" title={relativePath}>
              {/* Cut from the start so the file name stays visible; styles.css says how. */}
              <bdi dir="ltr">{relativePath}</bdi>
            </span>
            {lineLabel && <span className="code-panel-lines">{lineLabel}</span>}
            {onAddToChat !== undefined && chat.selection !== undefined && <AddToChatButton onAdd={chat.add} />}
          </>
        }
      />
      <div className="code-panel-editor" onContextMenu={chat.onContextMenu}>
        <CodeEditor
          language="astro"
          value={source}
          activeRange={activeRange}
          componentRanges={components}
          onChange={onChange}
          onPositionChange={(position) => {
            if (model?.bodyStart !== undefined && position < model.bodyStart) {
              onSelect('frontmatter');
              return;
            }
            const node = sourceNodeAtOffset(model?.nodes ?? [], position);
            if (node !== undefined) {
              onSelect(node.id);
            }
          }}
          onOpenComponent={onOpenComponent}
          onSelectionChange={chat.onSelectionChange}
          extensions={extensions}
        />
        {overlay}
        {chat.menu}
      </div>
    </section>
  );
}

// What "Add to chat" takes here, and the three ways to ask for it: the header's button, ⌘L and the right-click menu.
function useCodeSelection(
  props: Pick<CodePanelProps, 'source' | 'relativePath' | 'model' | 'selectedId' | 'revealRange' | 'onAddToChat'> & {
    readonly activeRange: SourceRange | undefined;
  },
) {
  const translate = useTranslate();
  const { source, relativePath, model, selectedId, revealRange, activeRange, onAddToChat } = props;
  const [selected, setSelected] = useState<CodeEditorSelection | undefined>(undefined);
  const [menuAt, setMenuAt] = useState<{ readonly left: number; readonly top: number } | undefined>(undefined);
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  useEffect(() => {
    setSelected(undefined);
    setMenuAt(undefined);
  }, [relativePath]);
  // A selection made in other text (an undo, a save from outside) selects nothing here.
  const textRange = selected !== undefined && selected.source === source ? selected : undefined;
  const selection =
    textRange !== undefined
      ? textSelectionOf(source, textRange)
      : revealRange !== undefined
        ? textSelectionOf(source, revealRange)
        : activeRange === undefined
          ? undefined
          : nodeSelectionOf(source, model, selectedId);
  const add = (): void => {
    if (selection !== undefined) {
      onAddToChat?.(selection);
    }
  };
  const shortcut = shortcutLabel('L', 'primary', currentDesktopPlatform());
  return {
    textRange,
    selection,
    add,
    onSelectionChange: setSelected,
    onKeyDown: (event: KeyboardEvent): void => {
      if (onAddToChat !== undefined && !event.defaultPrevented && isAddToChatKey(event.nativeEvent, currentDesktopPlatform())) {
        // Taken here, so the app does not add the element a second time.
        event.preventDefault();
        add();
      }
    },
    onContextMenu: (event: MouseEvent): void => {
      if (onAddToChat !== undefined && selection !== undefined) {
        event.preventDefault();
        setMenuAt({ left: event.clientX, top: event.clientY });
      }
    },
    menu:
      menuAt === undefined ? undefined : (
        <>
          <span ref={(element) => setAnchor(element ?? undefined)} className="code-panel-menu-anchor" style={{ left: menuAt.left, top: menuAt.top }} />
          <Menu
            open={anchor !== undefined}
            anchor={anchor}
            label={translate('workspace.code.addToChat')}
            onClose={() => setMenuAt(undefined)}
            placement="below-start"
            entries={[{ kind: 'item', id: 'add-to-chat', label: translate('workspace.code.addToChat'), shortcut, onSelect: add }]}
          />
        </>
      ),
  };
}

function AddToChatButton({ onAdd }: { readonly onAdd: () => void }) {
  const translate = useTranslate();
  const shortcut = shortcutLabel('L', 'primary', currentDesktopPlatform());
  const label = translate('workspace.code.addToChat');
  const { props, tip } = useShortcutTip(label, shortcut);
  return (
    <>
      <button
        type="button"
        className="ghost code-panel-add"
        aria-label={label}
        // The press leaves the editor's selection where it is.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAdd}
        {...props}
      >
        <SparkleIcon size={14} />
      </button>
      {tip}
    </>
  );
}
