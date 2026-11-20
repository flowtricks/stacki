// Goal: one spelling for every repository file a test names, so the layout
// tool (scripts/move/moveSources.mts) can follow a file when it moves.
// Method: a test writes a repository-relative path as one string —
// repoPath('src/editor/pageEdits.ts'), never path pieces or `../` — and stubs a
// module by the file it resolves to, never by the text of an import, so a
// changed specifier can never make a stub silently stop matching.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** The absolute path of a repository-relative path written with `/`. */
function repoPath(relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('repoPath: expected a repository-relative path');
  }
  if (relative.startsWith('/') || relative.split('/').includes('..')) {
    throw new Error(`repoPath: ${relative} must stay inside the repository`);
  }
  return path.join(ROOT, ...relative.split('/'));
}

/** A path written for an esbuild stdin import: absolute, quoted for code. */
function sourceSpecifier(relative) {
  return JSON.stringify(repoPath(relative));
}

/**
 * An esbuild plugin that replaces whole modules, matched by the file they
 * resolve to. `stubs` maps a repository path to a function of the absolute
 * path returning esbuild's `{ contents, loader }`, or undefined to load the
 * real file.
 */
function stubSources(name, stubs) {
  const byPath = new Map(Object.entries(stubs).map(([file, stub]) => [repoPath(file), stub]));
  return {
    name,
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        const stub = byPath.get(path.resolve(args.path));
        return stub === undefined ? undefined : stub(args.path);
      });
    },
  };
}

// The components App.tsx reaches as panels. Harnesses that mount the real App
// replace them with stubs that record their props (stubPanels).
const PANEL_SOURCES = Object.freeze([
  'src/features/assets/AssetsPanel.tsx',
  'src/features/preview/CanvasView.tsx',
  'src/features/cms/CmsField.tsx',
  'src/features/cms/CmsPanel.tsx',
  'src/features/cms/CmsSettings.tsx',
  'src/features/cms/CmsView.tsx',
  'src/features/code/CodePanel.tsx',
  'src/features/componentProperties/ComponentPropertiesPanel.tsx',
  'src/features/content/ContentFields.tsx',
  'src/features/content/ContentView.tsx',
  'src/features/preview/DevOffline.tsx',
  'src/features/git/GitChip.tsx',
  'src/features/git/GitChipView.tsx',
  'src/features/history/HistoryPanel.tsx',
  'src/features/history/HistorySections.tsx',
  'src/features/history/HistoryTimeline.tsx',
  'src/features/props/ListField.tsx',
  'src/features/git/MergeConflictModal.tsx',
  'src/features/props/ObjectField.tsx',
  'src/features/pages/PageDialogs.tsx',
  'src/features/pages/PageTreeView.tsx',
  'src/features/pages/PagesPanel.tsx',
  'src/features/palette/PaletteDialogs.tsx',
  'src/features/palette/PalettePanel.tsx',
  'src/features/preview/PreviewOverlays.tsx',
  'src/features/preview/PreviewPane.tsx',
  'src/features/preview/PreviewSizeControls.tsx',
  'src/features/preview/PreviewToolbar.tsx',
  'src/features/props/PropField.tsx',
  'src/features/componentProperties/PropertyDeclarationInfo.tsx',
  'src/features/componentProperties/PropertyDefault.tsx',
  'src/features/componentProperties/PropertyEditor.tsx',
  'src/features/componentProperties/PropertyOptions.tsx',
  'src/features/componentProperties/PropertyReorder.tsx',
  'src/features/componentProperties/PropertySettingsDialog.tsx',
  'src/features/componentProperties/PropertyType.tsx',
  'src/features/props/PropsPanel.tsx',
  'src/features/git/PublishModal.tsx',
  'src/app/SaveConflictNotice.tsx',
  'src/features/selectors/SelectorsPanel.tsx',
  'src/features/structure/StructurePanel.tsx',
  'src/features/structure/StructureTree.tsx',
  'src/features/style/StylePanel.tsx',
  'src/features/git/SwitchBranchModal.tsx',
  'src/features/terminal/TerminalDock.tsx',
  'src/features/terminal/TerminalPane.tsx',
  'src/features/variables/VariableCell.tsx',
  'src/features/variables/VariableTable.tsx',
  'src/features/variables/VariablesPanel.tsx',
  'src/features/variables/VariablesView.tsx',
  'src/features/welcome/WelcomeScreen.tsx',
  'src/features/welcome/WelcomeWizards.tsx',
  'src/features/props/propAttributes.tsx',
  'src/features/props/propBindings.tsx',
  'src/features/props/propNodeEditors.tsx',
]);

/**
 * stubSources over every panel component: `stub(name)` receives the component's
 * file name without its extension and returns esbuild's `{ contents, loader }`,
 * or undefined to keep the real component.
 */
function stubPanels(name, stub) {
  const stubs = PANEL_SOURCES.map((file) => [file, () => withNamedExports(file, stub(path.basename(file, path.extname(file))))]);
  return stubSources(name, Object.fromEntries(stubs));
}

// A stub exports a default panel and little else, but modules that stay real import other names from a stubbed
// file (the page settings dialog mounts InstancePropFields, the drop overlay draws outlineIcon, the source panels
// call assetImportOf). esbuild refuses such a bundle with "No matching export", so each value export the real
// file declares is also exported from the stub as a function that renders and returns nothing. The names are read
// from the real file's own export statements, so a new export needs no edit here. Types are erased and skipped.
function valueExportNames(file) {
  const text = fs.readFileSync(repoPath(file), 'utf8');
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^export\s*(?!type\b)\{([^}]*)\}/gm)) {
    for (const item of match[1].split(',')) {
      const entry = item.trim();
      if (entry.length > 0 && !entry.startsWith('type ')) {
        names.add(
          entry
            .split(/\s+as\s+/)
            .pop()
            .trim(),
        );
      }
    }
  }
  names.delete('default');
  return [...names];
}

function withNamedExports(file, stubbed) {
  if (stubbed === undefined) {
    return stubbed;
  }
  const missing = valueExportNames(file).filter((exportName) => !new RegExp(`export\\s+(?:const|function|class)\\s+${exportName}\\b`).test(stubbed.contents));
  const exported = missing.map((exportName) => `export const ${exportName} = () => null;`).join(' ');
  return { ...stubbed, contents: `${stubbed.contents}\n${exported}\n` };
}

module.exports = { PANEL_SOURCES, ROOT, repoPath, sourceSpecifier, stubPanels, stubSources };
