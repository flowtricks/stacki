import CodeWindow from '../../../vendor/stacki/src/features/code/CodeWindow';
import type { useCodeWindow } from './useCodeWindow';

export function CodePopup({ editor }: { readonly editor: ReturnType<typeof useCodeWindow> }) {
  const current = editor.current;
  if (!current?.title || !current.language) {
    return null;
  }
  return (
    <CodeWindow
      title={current.title}
      language={current.language}
      indentation={current.indentation}
      value={current.value}
      editorKey={editor.key}
      revealLine={1}
      onChange={editor.change}
      onClose={editor.close}
    />
  );
}
