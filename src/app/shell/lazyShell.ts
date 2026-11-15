// The project window's chunk. The window (the editor shell, every panel, the code editor, the style
// engine, the binding picker's models) is most of the renderer's code and a cold start on the start screen
// does not need it: that screen paints first and this is fetched when the renderer is idle (src/main.tsx).
// A window that opens a project awaits it before its first render, so the first frame is the real shell.
type ProjectWindowModule = typeof import('./ProjectWindow');

let loaded: ProjectWindowModule | undefined;

export function loadShell(): Promise<ProjectWindowModule> {
  return import('./ProjectWindow').then((module) => {
    loaded = module;
    return module;
  });
}

/** The chunk's module once it has loaded. A component that reads it renders the shell in its first frame; React.lazy
 *  cannot, because it learns of a settled import only a microtask later and would commit its fallback first. */
export function loadedShell(): ProjectWindowModule | undefined {
  return loaded;
}
