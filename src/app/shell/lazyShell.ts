// The project window's chunk. The window (the editor shell, every panel, the code editor, the style
// engine, the binding picker's models) is most of the renderer's code and a cold start does not need
// it: the start screen paints first and this is fetched when the renderer is idle (src/main.tsx), so
// opening a project finds it ready.
export function loadShell(): Promise<typeof import('./ProjectWindow')> {
  return import('./ProjectWindow');
}
